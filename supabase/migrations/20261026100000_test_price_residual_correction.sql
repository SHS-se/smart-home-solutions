-- Research only. Applying this schema does not activate a worker or change household forecasts.
ALTER TABLE private.test_market_archive_config ADD COLUMN price_correction_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE public.energy_test_price_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES public.homes(id),
  baseline_id uuid NOT NULL REFERENCES public.energy_price_forecast_generations(id),
  algorithm text NOT NULL CHECK(algorithm='se3-price-residual-v1'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paired','unavailable')),
  context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'), forecast jsonb,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), saved_at timestamptz, eligibility_cutoff bigint,
  UNIQUE(home_id,baseline_id,algorithm),
  CHECK((status='pending' AND forecast IS NULL AND saved_at IS NULL AND eligibility_cutoff IS NULL)
    OR (status<>'pending' AND jsonb_typeof(forecast)='object' AND saved_at IS NOT NULL AND eligibility_cutoff IS NOT NULL))
);
CREATE INDEX test_price_correction_pending ON public.energy_test_price_corrections(home_id,reserved_at,id) WHERE status='pending';
CREATE TABLE public.energy_test_price_correction_targets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.energy_test_price_corrections(id),
  home_id uuid NOT NULL REFERENCES public.homes(id), start_ts timestamptz NOT NULL,
  target_day date NOT NULL, lead_day integer NOT NULL,
  baseline numeric NOT NULL CHECK(baseline NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  corrected numeric CHECK(corrected NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  features jsonb, reason text,
  training_eligible boolean NOT NULL, eligible boolean NOT NULL,
  eligibility_reason text NOT NULL CHECK(eligibility_reason IN ('eligible','unavailable','not_future','already_known')),
  UNIQUE(run_id,start_ts),
  CHECK(NOT training_eligible OR jsonb_typeof(features)='array'),
  CHECK(NOT eligible OR (training_eligible AND corrected IS NOT NULL AND reason IS NULL))
);
CREATE INDEX test_price_correction_training ON public.energy_test_price_correction_targets(home_id,start_ts,lead_day) WHERE training_eligible;
CREATE TRIGGER immutable_test_price_correction_target BEFORE UPDATE OR DELETE ON public.energy_test_price_correction_targets
  FOR EACH ROW EXECUTE FUNCTION private.immutable_test_price_evidence();
CREATE TRIGGER immutable_test_price_correction BEFORE UPDATE OR DELETE ON public.energy_test_price_corrections
  FOR EACH ROW EXECUTE FUNCTION private.validate_test_price_pair_transition();
ALTER TABLE public.energy_test_price_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_test_price_correction_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_test_price_corrections,public.energy_test_price_correction_targets FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.energy_test_price_corrections,public.energy_test_price_correction_targets TO service_role;
REVOKE ALL ON SEQUENCE public.energy_test_price_correction_targets_id_seq FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.request_test_price_correction()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
  SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
  IF NOT FOUND OR NOT config.price_correction_enabled THEN RETURN; END IF;
  IF config.function_url<>'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive' THEN RAISE EXCEPTION 'TEST correction requires TEST archive'; END IF;
  PERFORM net.http_post(url:='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-price-correction-experiment',
    headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),body:='{}'::jsonb,timeout_milliseconds:=180000);
END; $$;
CREATE FUNCTION private.enable_test_price_correction()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton AND price_experiment_home_id IS NOT NULL
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive') THEN RAISE EXCEPTION 'Enable the scoped TEST price ledger first'; END IF;
  UPDATE private.test_market_archive_config SET price_correction_enabled=true WHERE singleton;
  PERFORM cron.schedule('test-energy-price-correction','37 */6 * * *','SELECT private.request_test_price_correction()');
END; $$;

CREATE FUNCTION public.begin_test_price_correction()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; run public.energy_test_price_corrections%ROWTYPE;
  base public.energy_price_forecast_generations%ROWTYPE; mix public.energy_generation_forecast_runs%ROWTYPE;
  load public.energy_market_forecast_observations%ROWTYPE;
  known_at timestamptz; cutoff bigint; slots jsonb; samples jsonb; frozen jsonb; snapshot record;
BEGIN
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton AND price_correction_enabled
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  IF scoped_home IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO run FROM public.energy_test_price_corrections WHERE home_id=scoped_home AND status='pending' ORDER BY reserved_at,id LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('id',run.id,'status',run.status,'context',run.context); END IF;
  -- One statement freezes committed baseline and market versions. Remote issue dates do not select availability.
  SELECT b.b baseline,m.m generation,l.l demand INTO snapshot FROM
    (SELECT b FROM public.energy_price_forecast_generations b WHERE home_id=scoped_home ORDER BY generated_at DESC,id DESC LIMIT 1) b
    LEFT JOIN LATERAL(SELECT m FROM public.energy_generation_forecast_runs m WHERE zone='SE3' AND algorithm='se3-generation-analog-v2' ORDER BY recorded_at DESC,id DESC LIMIT 1) m ON true
    LEFT JOIN LATERAL(SELECT l FROM public.energy_market_forecast_observations l WHERE dataset='load_week_ahead' AND result->>'status'='data' ORDER BY sequence DESC LIMIT 1) l ON true;
  base:=snapshot.baseline; mix:=snapshot.generation; load:=snapshot.demand;
  IF base.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO run FROM public.energy_test_price_corrections WHERE home_id=scoped_home AND baseline_id=base.id;
  IF FOUND THEN RETURN jsonb_build_object('id',run.id,'status',run.status,'context',run.context); END IF;
  known_at:=clock_timestamp();
  SELECT coalesce(max(sequence),0) INTO cutoff FROM public.energy_test_price_observations WHERE home_id=scoped_home;
  SELECT jsonb_agg(jsonb_build_object('start',s.value,'price',base.outlook->'shadowImportSekPerKwh'->(s.ordinality-1)::integer,
    'published',base.inputs->'published_import_sek_per_kwh'->(s.ordinality-1)::integer<>'null'::jsonb) ORDER BY s.ordinality)
    INTO slots FROM jsonb_array_elements(base.inputs->'slot_starts') WITH ORDINALITY s;
  -- A forecast can train once its truth is published, even before physical delivery.
  -- Unavailable first corrections still supply prospectively frozen feature/label pairs.
  SELECT coalesce(jsonb_agg(jsonb_build_object('runId',s.run_id,'origin',s.reserved_at,'start',s.start_ts,'leadDay',s.lead_day,
      'baseline',s.baseline,'features',s.features,'actual',s.actual,'truthSequence',s.sequence) ORDER BY s.start_ts,s.lead_day),'[]'::jsonb) INTO samples
    FROM (SELECT DISTINCT ON(t.start_ts,t.lead_day) t.*,r.reserved_at,o.import_price_sek_per_kwh actual,o.sequence
      FROM public.energy_test_price_correction_targets t JOIN public.energy_test_price_corrections r ON r.id=t.run_id
      JOIN LATERAL(SELECT sequence,import_price_sek_per_kwh FROM public.energy_test_price_observations
        WHERE home_id=scoped_home AND start_ts=t.start_ts AND sequence<=cutoff ORDER BY sequence DESC LIMIT 1) o ON o.sequence>r.eligibility_cutoff
      WHERE t.home_id=scoped_home AND t.training_eligible AND r.saved_at<known_at AND t.start_ts>=known_at-interval '30 days'
      ORDER BY t.start_ts,t.lead_day,r.reserved_at DESC,r.id DESC) s;
  frozen:=jsonb_build_object('knownAt',known_at,'truthCutoff',cutoff,
    'baseline',jsonb_build_object('id',base.id,'generatedAt',base.generated_at,'slots',slots),
    'generationRunId',mix.id,'generation',mix.forecast,'load',CASE WHEN load.id IS NULL THEN NULL ELSE jsonb_build_object('id',load.id,'intervals',load.result->'document'->'intervals') END,
    'training',samples);
  INSERT INTO public.energy_test_price_corrections(home_id,baseline_id,algorithm,context,reserved_at)
    VALUES(scoped_home,base.id,'se3-price-residual-v1',frozen,known_at) RETURNING * INTO run;
  RETURN jsonb_build_object('id',run.id,'status',run.status,'context',run.context);
END; $$;

CREATE FUNCTION public.complete_test_price_correction(p_id uuid,p_forecast jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; run public.energy_test_price_corrections%ROWTYPE; target jsonb; slot jsonb;
  saved timestamptz; cutoff bigint; at timestamptz; b numeric; c numeric; features jsonb; reason text;
  future_unknown boolean; eligibility text; day date; expected integer;
BEGIN
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton AND price_correction_enabled
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  SELECT * INTO run FROM public.energy_test_price_corrections WHERE id=p_id AND home_id=scoped_home;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown TEST correction'; END IF;
  IF run.status<>'pending' THEN
    IF run.forecast IS DISTINCT FROM p_forecast THEN RAISE EXCEPTION 'Conflicting completed TEST correction'; END IF;
    RETURN jsonb_build_object('id',run.id,'status',run.status);
  END IF;
  IF p_forecast IS NULL OR jsonb_typeof(p_forecast)<>'object' OR p_forecast->>'algorithm' IS DISTINCT FROM run.algorithm
    OR p_forecast->>'status' IS NULL OR p_forecast->>'status' NOT IN ('paired','unavailable')
    OR jsonb_typeof(p_forecast->'targets') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_forecast->'fit') IS NULL OR jsonb_typeof(p_forecast->'fit') NOT IN ('object','null')
    OR (p_forecast->>'status'='paired' AND jsonb_typeof(p_forecast->'fit')<>'object') THEN RAISE EXCEPTION 'Invalid TEST correction forecast'; END IF;
  expected:=jsonb_array_length(run.context->'baseline'->'slots');
  IF jsonb_array_length(p_forecast->'targets')<>expected OR
    (SELECT count(DISTINCT (value->>'start')::timestamptz) FROM jsonb_array_elements(p_forecast->'targets'))<>expected THEN
    RAISE EXCEPTION 'Correction must retain the exact frozen household grid'; END IF;
  saved:=clock_timestamp();
  SELECT coalesce(max(sequence),0) INTO cutoff FROM public.energy_test_price_observations WHERE home_id=scoped_home;
  FOR target IN SELECT value FROM jsonb_array_elements(p_forecast->'targets') LOOP
    IF jsonb_typeof(target)<>'object' OR NOT(target ?& ARRAY['start','baseline','corrected','features','reason'])
      OR target-ARRAY['start','baseline','corrected','features','reason']<>'{}'::jsonb
      OR jsonb_typeof(target->'start')<>'string' OR jsonb_typeof(target->'baseline')<>'number'
      OR jsonb_typeof(target->'corrected') NOT IN ('number','null')
      OR jsonb_typeof(target->'features') NOT IN ('array','null')
      OR jsonb_typeof(target->'reason') NOT IN ('string','null') THEN RAISE EXCEPTION 'Invalid TEST correction target'; END IF;
    at:=(target->>'start')::timestamptz; b:=(target->>'baseline')::numeric; c:=(target->>'corrected')::numeric;
    features:=target->'features'; reason:=target->>'reason';
    SELECT value INTO slot FROM jsonb_array_elements(run.context->'baseline'->'slots') WHERE (value->>'start')::timestamptz=at;
    IF NOT FOUND OR NOT isfinite(at) OR extract(epoch FROM at)::numeric % 900<>0 OR b IS DISTINCT FROM (slot->>'price')::numeric THEN
      RAISE EXCEPTION 'Correction changed the frozen household baseline'; END IF;
    IF b IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) OR c IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
      OR (c IS NOT NULL AND (features='null'::jsonb OR reason IS NOT NULL OR (slot->>'published')::boolean))
      OR (c IS NULL AND reason IS NULL) OR (p_forecast->>'status'='unavailable' AND c IS NOT NULL) THEN RAISE EXCEPTION 'Invalid correction availability'; END IF;
    IF features<>'null'::jsonb AND (jsonb_array_length(features)<>13 OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(features) f WHERE jsonb_typeof(f)<>'number' OR (f#>>'{}')::numeric IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric))) THEN RAISE EXCEPTION 'Invalid correction features'; END IF;
    future_unknown:=at>saved AND NOT (slot->>'published')::boolean AND NOT EXISTS(
      SELECT 1 FROM public.energy_test_price_observations WHERE home_id=scoped_home AND start_ts=at);
    eligibility:=CASE WHEN at<=saved THEN 'not_future' WHEN NOT future_unknown THEN 'already_known' WHEN c IS NULL THEN 'unavailable' ELSE 'eligible' END;
    day:=(at AT TIME ZONE 'Europe/Stockholm')::date;
    INSERT INTO public.energy_test_price_correction_targets(run_id,home_id,start_ts,target_day,lead_day,baseline,corrected,features,reason,training_eligible,eligible,eligibility_reason)
      VALUES(run.id,scoped_home,at,day,day-(run.reserved_at AT TIME ZONE 'Europe/Stockholm')::date,b,c,nullif(features,'null'::jsonb),reason,
        future_unknown AND features<>'null'::jsonb,eligibility='eligible',eligibility);
  END LOOP;
  IF (p_forecast->>'status'='paired') IS DISTINCT FROM EXISTS(SELECT 1 FROM public.energy_test_price_correction_targets WHERE run_id=run.id AND corrected IS NOT NULL) THEN
    RAISE EXCEPTION 'Correction status disagrees with predictions'; END IF;
  UPDATE public.energy_test_price_corrections SET status=p_forecast->>'status',forecast=p_forecast,saved_at=saved,eligibility_cutoff=cutoff WHERE id=run.id;
  RETURN jsonb_build_object('id',run.id,'status',p_forecast->>'status');
END; $$;

CREATE VIEW public.energy_test_price_correction_outcomes AS
  SELECT r.id pair_id,t.id target_id,r.home_id,r.algorithm,r.reserved_at origin,r.saved_at,r.eligibility_cutoff,
    t.start_ts,t.target_day,t.lead_day,t.baseline reduced,t.corrected "full",o.sequence truth_sequence,
    o.recorded_at truth_recorded_at,o.import_price_sek_per_kwh actual,
    t.baseline-o.import_price_sek_per_kwh reduced_error,t.corrected-o.import_price_sek_per_kwh full_error,
    abs(t.baseline-o.import_price_sek_per_kwh) reduced_absolute_error,abs(t.corrected-o.import_price_sek_per_kwh) full_absolute_error
  FROM public.energy_test_price_correction_targets t JOIN public.energy_test_price_corrections r ON r.id=t.run_id
  JOIN LATERAL(SELECT * FROM public.energy_test_price_observations WHERE home_id=t.home_id AND start_ts=t.start_ts ORDER BY sequence DESC LIMIT 1) o ON o.sequence>r.eligibility_cutoff
  WHERE t.eligible;

-- Both experiments share the same score calculation and retain separate cohorts.
CREATE VIEW private.test_price_comparison_outcomes AS
  SELECT home_id,algorithm,lead_day,pair_id,target_day,reduced_error,full_error,reduced_absolute_error,full_absolute_error,truth_sequence FROM public.energy_test_price_pair_outcomes
  UNION ALL
  SELECT home_id,algorithm,lead_day,pair_id,target_day,reduced_error,full_error,reduced_absolute_error,full_absolute_error,truth_sequence FROM public.energy_test_price_correction_outcomes;

CREATE VIEW private.test_price_comparison_scores AS
  WITH quarters AS (
    SELECT home_id,algorithm,lead_day,count(*) AS scored_quarters,count(DISTINCT pair_id) AS origin_count,
      count(DISTINCT target_day) AS target_day_count,max(truth_sequence) AS truth_cutoff,
      avg(reduced_absolute_error) AS reduced_mae,avg(full_absolute_error) AS full_mae,
      avg(reduced_error) AS reduced_bias,avg(full_error) AS full_bias
    FROM private.test_price_comparison_outcomes GROUP BY home_id,algorithm,lead_day
  ), day_means AS (
    SELECT home_id,algorithm,lead_day,pair_id,target_day,count(*) AS scored_quarters,
      abs(avg(reduced_error)) AS reduced_daily_mean_absolute_error,
      abs(avg(full_error)) AS full_daily_mean_absolute_error,
      extract(epoch FROM ((target_day+1)::timestamp AT TIME ZONE 'Europe/Stockholm')-
        (target_day::timestamp AT TIME ZONE 'Europe/Stockholm'))/900 AS expected_day_quarters
    FROM private.test_price_comparison_outcomes GROUP BY home_id,algorithm,lead_day,pair_id,target_day
  ), daily AS (
    SELECT home_id,algorithm,lead_day,count(*) AS scored_day_origins,
      count(*) FILTER(WHERE scored_quarters=expected_day_quarters) AS complete_day_origins,
      avg(reduced_daily_mean_absolute_error) AS reduced_daily_mean_mae,
      avg(full_daily_mean_absolute_error) AS full_daily_mean_mae
    FROM day_means GROUP BY home_id,algorithm,lead_day
  ) SELECT q.*,q.reduced_mae-q.full_mae AS mae_improvement,
      d.scored_day_origins,d.complete_day_origins,d.reduced_daily_mean_mae,d.full_daily_mean_mae
    FROM quarters q JOIN daily d USING(home_id,algorithm,lead_day);
CREATE OR REPLACE VIEW public.energy_test_price_pair_scores AS SELECT * FROM private.test_price_comparison_scores WHERE algorithm='se3-price-mix-pair-v1';
CREATE VIEW public.energy_test_price_correction_scores AS SELECT * FROM private.test_price_comparison_scores WHERE algorithm='se3-price-residual-v1';

CREATE FUNCTION public.read_test_price_correction_report()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; report jsonb;
BEGIN
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton AND price_correction_enabled
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  SELECT jsonb_build_object(
    'truth_cutoff',coalesce((SELECT max(sequence) FROM public.energy_test_price_observations WHERE home_id=scoped_home),0),
    'pair_count',(SELECT count(*) FROM public.energy_test_price_corrections WHERE home_id=scoped_home),
    'scores',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY lead_day) FROM public.energy_test_price_correction_scores s WHERE home_id=scoped_home),'[]'::jsonb),
    'pairs',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY reserved_at DESC,id) FROM (
      SELECT r.id,r.status,r.reserved_at,r.saved_at,r.baseline_id,r.context->'baseline'->>'generatedAt' baseline_generated_at,
        (SELECT count(*) FROM public.energy_test_price_correction_targets WHERE run_id=r.id) target_count,
        (SELECT count(*) FROM public.energy_test_price_correction_targets WHERE run_id=r.id AND eligible) eligible_count,
        (SELECT count(*) FROM public.energy_test_price_correction_outcomes WHERE pair_id=r.id) scored_count
      FROM public.energy_test_price_corrections r WHERE home_id=scoped_home ORDER BY reserved_at DESC,id LIMIT 100
    ) s),'[]'::jsonb)) INTO report;
  RETURN report;
END; $$;
CREATE FUNCTION public.get_test_price_correction_comparison(p_pair_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; report jsonb; selected public.energy_test_price_corrections%ROWTYPE; selected_json jsonb; targets jsonb;
BEGIN
  IF NOT coalesce(public.is_staff(auth.uid()),false) THEN RAISE EXCEPTION 'Price forecast comparisons are staff-only' USING ERRCODE='42501'; END IF;
  report:=public.read_test_price_correction_report();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config WHERE singleton AND price_correction_enabled
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  IF scoped_home IS NULL THEN RETURN jsonb_build_object('enabled',false,'updated_at',clock_timestamp(),'report',report,'selected',NULL,'targets','[]'::jsonb); END IF;
  IF p_pair_id IS NULL THEN
    SELECT * INTO selected FROM public.energy_test_price_corrections WHERE home_id=scoped_home ORDER BY reserved_at DESC,id LIMIT 1;
  ELSE
    SELECT * INTO selected FROM public.energy_test_price_corrections WHERE home_id=scoped_home AND id=p_pair_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown TEST correction' USING ERRCODE='22023'; END IF;
  END IF;
  IF selected.id IS NOT NULL THEN
    selected_json:=jsonb_build_object('id',selected.id,'status',selected.status,'reserved_at',selected.reserved_at,'saved_at',selected.saved_at,
      'reason',selected.forecast->>'reason','training_quarters',selected.forecast->'fit'->'training'->'quarters',
      'baseline_generated_at',selected.context->'baseline'->>'generatedAt',
      'target_count',(SELECT count(*) FROM public.energy_test_price_correction_targets WHERE run_id=selected.id),
      'eligible_count',(SELECT count(*) FROM public.energy_test_price_correction_targets WHERE run_id=selected.id AND eligible));
    SELECT coalesce(jsonb_agg(jsonb_build_object('start',t.start_ts,'target_day',t.target_day,'lead_day',t.lead_day,
      'reduced',t.baseline,'full',t.corrected,'actual',o.actual,'truth_sequence',o.truth_sequence) ORDER BY t.start_ts),'[]'::jsonb) INTO targets
      FROM public.energy_test_price_correction_targets t LEFT JOIN public.energy_test_price_correction_outcomes o ON o.target_id=t.id
      WHERE t.run_id=selected.id AND t.eligible;
  END IF;
  RETURN jsonb_build_object('enabled',true,'updated_at',clock_timestamp(),'home_name',(SELECT name FROM public.homes WHERE id=scoped_home),
    'report',report,'selected',selected_json,'targets',coalesce(targets,'[]'::jsonb));
END; $$;
REVOKE ALL ON public.energy_test_price_correction_outcomes,public.energy_test_price_correction_scores,
  private.test_price_comparison_outcomes,private.test_price_comparison_scores FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.energy_test_price_correction_outcomes,public.energy_test_price_correction_scores TO service_role;
REVOKE ALL ON FUNCTION private.enable_test_price_correction(),private.request_test_price_correction(),
  public.begin_test_price_correction(),public.complete_test_price_correction(uuid,jsonb),public.read_test_price_correction_report(),
  public.get_test_price_correction_comparison(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_test_price_correction(),public.complete_test_price_correction(uuid,jsonb),public.read_test_price_correction_report() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_test_price_correction_comparison(uuid) TO authenticated;
