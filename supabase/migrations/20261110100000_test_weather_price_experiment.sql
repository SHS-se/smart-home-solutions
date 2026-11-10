-- Research only. Applying this schema starts no worker and changes no household forecast.
-- TEST activation is explicit (private.enable_test_weather_price), as for the earlier studies.
ALTER TABLE private.test_market_archive_config ADD COLUMN weather_price_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE public.energy_test_weather_price_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES public.homes(id),
  baseline_id uuid NOT NULL REFERENCES public.energy_price_forecast_generations(id),
  algorithm text NOT NULL CHECK(algorithm='se3-weather-price-v1'),
  -- prospective: saved before TEST knew any target price. replay: recomputed later from versions archived by the origin.
  kind text NOT NULL CHECK(kind IN ('prospective','replay')),
  -- The deployed forecast's own generation time: both forecasts answer for the same instant.
  origin_at timestamptz NOT NULL,
  truth_cutoff bigint NOT NULL,
  weather_observation_id uuid REFERENCES public.energy_market_forecast_observations(id),
  status text NOT NULL CHECK(status IN ('forecast','unavailable')),
  reason text,
  training_quarters integer NOT NULL CHECK(training_quarters>=0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(home_id,baseline_id,algorithm)
);
CREATE INDEX test_weather_price_runs_origin ON public.energy_test_weather_price_runs(home_id,kind,origin_at DESC);
-- Every row is a quarter the deployed forecast estimated while its price was unknown.
-- A missing candidate stays null: it counts against coverage and is never filled.
CREATE TABLE public.energy_test_weather_price_targets (
  run_id uuid NOT NULL REFERENCES public.energy_test_weather_price_runs(id),
  start_ts timestamptz NOT NULL,
  target_day date NOT NULL,
  lead_day integer NOT NULL CHECK(lead_day IN (2,3)),
  baseline numeric NOT NULL CHECK(baseline NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  candidate numeric CHECK(candidate NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  PRIMARY KEY(run_id,start_ts)
);
CREATE TRIGGER immutable_test_weather_price_run BEFORE UPDATE OR DELETE ON public.energy_test_weather_price_runs
  FOR EACH ROW EXECUTE FUNCTION private.immutable_test_price_evidence();
CREATE TRIGGER immutable_test_weather_price_target BEFORE UPDATE OR DELETE ON public.energy_test_weather_price_targets
  FOR EACH ROW EXECUTE FUNCTION private.immutable_test_price_evidence();
ALTER TABLE public.energy_test_weather_price_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_test_weather_price_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_test_weather_price_runs,public.energy_test_weather_price_targets FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.energy_test_weather_price_runs,public.energy_test_weather_price_targets TO service_role;

CREATE FUNCTION private.test_weather_price_home()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT price_experiment_home_id FROM private.test_market_archive_config WHERE singleton AND weather_price_enabled
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
$$;

-- One definition of the scored cohort, shared by the forecast context and the saved record:
-- Stockholm D+2 and D+3 quarters of one deployed forecast that neither its own input nor the
-- TEST price ledger knew at its generation time.
CREATE FUNCTION private.test_weather_price_targets(p_baseline_id uuid,p_cutoff bigint)
RETURNS TABLE(start_ts timestamptz,target_day date,lead_day integer,baseline numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT s.start_ts,s.target_day,s.lead_day,s.baseline FROM (
    SELECT e.value::timestamptz start_ts,(e.value::timestamptz AT TIME ZONE 'Europe/Stockholm')::date target_day,
      (e.value::timestamptz AT TIME ZONE 'Europe/Stockholm')::date-(b.generated_at AT TIME ZONE 'Europe/Stockholm')::date lead_day,
      CASE WHEN jsonb_typeof(b.outlook->'shadowImportSekPerKwh'->(e.ordinality-1)::integer)='number'
        THEN (b.outlook->'shadowImportSekPerKwh'->>(e.ordinality-1)::integer)::numeric END baseline,
      jsonb_typeof(b.inputs->'published_import_sek_per_kwh'->(e.ordinality-1)::integer) published,b.home_id
    FROM public.energy_price_forecast_generations b,jsonb_array_elements_text(b.inputs->'slot_starts') WITH ORDINALITY e
    WHERE b.id=p_baseline_id
  ) s WHERE s.lead_day IN (2,3) AND s.baseline IS NOT NULL AND s.published IS DISTINCT FROM 'number'
    AND NOT EXISTS(SELECT 1 FROM public.energy_test_price_observations o WHERE o.home_id=s.home_id AND o.start_ts=s.start_ts AND o.sequence<=p_cutoff);
$$;

-- Freezes what TEST demonstrably held at the deployed forecast's generation time. Local
-- acquisition time decides availability; provider issue times never do.
-- p_tick NULL: the newest deployed forecast. Otherwise the newest one in the 30 minutes before the tick.
CREATE FUNCTION public.read_test_weather_price_context(p_tick timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid:=private.test_weather_price_home(); tick timestamptz:=coalesce(p_tick,clock_timestamp());
  base public.energy_price_forecast_generations%ROWTYPE; cutoff bigint; history jsonb; targets jsonb; weather jsonb;
BEGIN
  IF scoped_home IS NULL THEN RETURN jsonb_build_object('status','disabled'); END IF;
  IF tick>clock_timestamp() THEN RAISE EXCEPTION 'A forecast origin cannot be in the future' USING ERRCODE='22023'; END IF;
  SELECT * INTO base FROM public.energy_price_forecast_generations
    WHERE home_id=scoped_home AND generated_at<=tick AND generated_at>tick-interval '30 minutes' ORDER BY generated_at DESC,id DESC LIMIT 1;
  IF base.id IS NULL THEN RETURN jsonb_build_object('status','no_household_forecast'); END IF;
  IF EXISTS(SELECT 1 FROM public.energy_test_weather_price_runs WHERE home_id=scoped_home AND baseline_id=base.id AND algorithm='se3-weather-price-v1') THEN
    RETURN jsonb_build_object('status','already_saved','baselineId',base.id);
  END IF;
  SELECT coalesce(max(sequence),0) INTO cutoff FROM public.energy_test_price_observations WHERE home_id=scoped_home AND recorded_at<=base.generated_at;
  SELECT coalesce(jsonb_agg(jsonb_build_object('start',h.start_ts,'price',h.price) ORDER BY h.start_ts),'[]'::jsonb) INTO history FROM (
    SELECT DISTINCT ON(start_ts) start_ts,import_price_sek_per_kwh price FROM public.energy_test_price_observations
    WHERE home_id=scoped_home AND sequence<=cutoff AND start_ts>=base.generated_at-interval '28 days' ORDER BY start_ts,sequence DESC) h;
  SELECT coalesce(jsonb_agg(t.start_ts ORDER BY t.start_ts),'[]'::jsonb) INTO targets FROM private.test_weather_price_targets(base.id,cutoff) t;
  -- One document supplies training weather and target weather. Missing values stay missing.
  SELECT jsonb_build_object('id',w.id,'sites',(SELECT jsonb_agg(jsonb_build_object('times',s->'times','series',jsonb_build_object(
      'wind_speed_120m',s->'series'->'wind_speed_120m','temperature_2m',s->'series'->'temperature_2m','shortwave_radiation',s->'series'->'shortwave_radiation')))
    FROM jsonb_array_elements(w.result->'document'->'sites') s)) INTO weather
    FROM public.energy_market_forecast_observations w
    WHERE w.dataset='weather_medium_range' AND w.recorded_at<=base.generated_at AND w.result->>'status'='data' AND w.result->'request'->>'past_days'='28'
    ORDER BY w.sequence DESC LIMIT 1;
  RETURN jsonb_build_object('status','ready','baselineId',base.id,'origin',base.generated_at,'truthCutoff',cutoff,
    'history',history,'targets',targets,'weather',weather);
END; $$;

CREATE FUNCTION public.record_test_weather_price(p_baseline_id uuid,p_forecast jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid:=private.test_weather_price_home(); base public.energy_price_forecast_generations%ROWTYPE;
  cutoff bigint; weather_id uuid; new_run uuid; run_kind text;
BEGIN
  IF scoped_home IS NULL THEN RAISE EXCEPTION 'TEST weather price study is not enabled'; END IF;
  IF p_forecast IS NULL OR p_forecast->>'algorithm' IS DISTINCT FROM 'se3-weather-price-v1' OR p_forecast->>'status' NOT IN ('forecast','unavailable')
    OR jsonb_typeof(p_forecast->'targets') IS DISTINCT FROM 'array' OR jsonb_typeof(p_forecast->'trainingQuarters') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Invalid TEST weather price forecast' USING ERRCODE='22023';
  END IF;
  SELECT * INTO base FROM public.energy_price_forecast_generations WHERE id=p_baseline_id AND home_id=scoped_home;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown TEST household forecast' USING ERRCODE='22023'; END IF;
  weather_id:=nullif(p_forecast->>'weatherObservationId','')::uuid;
  IF weather_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.energy_market_forecast_observations
    WHERE id=weather_id AND dataset='weather_medium_range' AND recorded_at<=base.generated_at) THEN
    RAISE EXCEPTION 'Weather evidence was not available at the forecast origin' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(max(sequence),0) INTO cutoff FROM public.energy_test_price_observations WHERE home_id=scoped_home AND recorded_at<=base.generated_at;
  -- The database, not the worker, decides whether this was saved before any target price was known.
  SELECT CASE WHEN EXISTS(SELECT 1 FROM private.test_weather_price_targets(base.id,cutoff) t JOIN public.energy_test_price_observations o
    ON o.home_id=scoped_home AND o.start_ts=t.start_ts) THEN 'replay' ELSE 'prospective' END INTO run_kind;
  INSERT INTO public.energy_test_weather_price_runs(home_id,baseline_id,algorithm,kind,origin_at,truth_cutoff,weather_observation_id,status,reason,training_quarters)
    VALUES(scoped_home,base.id,'se3-weather-price-v1',run_kind,base.generated_at,cutoff,weather_id,p_forecast->>'status',p_forecast->>'reason',(p_forecast->>'trainingQuarters')::integer)
    ON CONFLICT(home_id,baseline_id,algorithm) DO NOTHING RETURNING id INTO new_run;
  IF new_run IS NULL THEN RETURN jsonb_build_object('status','already_saved'); END IF;
  -- The deployed estimate and the cohort come from the archive; only the candidate comes from the worker.
  INSERT INTO public.energy_test_weather_price_targets(run_id,start_ts,target_day,lead_day,baseline,candidate)
    SELECT new_run,t.start_ts,t.target_day,t.lead_day,t.baseline,f.candidate FROM private.test_weather_price_targets(base.id,cutoff) t
    LEFT JOIN (SELECT (x->>'start')::timestamptz start_ts,(x->>'candidate')::numeric candidate FROM jsonb_array_elements(p_forecast->'targets') x
      WHERE jsonb_typeof(x->'candidate')='number') f USING(start_ts);
  RETURN jsonb_build_object('status',p_forecast->>'status','id',new_run,'kind',run_kind);
END; $$;

CREATE VIEW private.test_weather_price_outcomes AS
  SELECT r.id run_id,r.home_id,r.kind,r.origin_at,t.start_ts,t.target_day,t.lead_day,t.baseline,t.candidate,
    o.sequence truth_sequence,o.import_price_sek_per_kwh actual
  FROM public.energy_test_weather_price_targets t JOIN public.energy_test_weather_price_runs r ON r.id=t.run_id
  JOIN LATERAL(SELECT sequence,import_price_sek_per_kwh FROM public.energy_test_price_observations
    WHERE home_id=r.home_id AND start_ts=t.start_ts ORDER BY sequence DESC LIMIT 1) o ON o.sequence>r.truth_cutoff;

-- Errors on identical origin/quarter pairs only. Coverage is reported beside them, never folded in.
CREATE FUNCTION private.test_weather_price_report(p_home uuid,p_kind text,p_from date,p_to date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  WITH scored AS (
    SELECT * FROM private.test_weather_price_outcomes WHERE home_id=p_home AND kind=p_kind AND (p_from IS NULL OR target_day BETWEEN p_from AND p_to)
  ), paired AS (SELECT * FROM scored WHERE candidate IS NOT NULL
  ), quarters AS (
    SELECT lead_day,count(*) scored_quarters,count(DISTINCT run_id) origin_count,count(DISTINCT target_day) target_day_count,
      avg(abs(baseline-actual)) reduced_mae,avg(abs(candidate-actual)) full_mae,avg(baseline-actual) reduced_bias,avg(candidate-actual) full_bias
    FROM paired GROUP BY lead_day
  ), coverage AS (SELECT lead_day,count(*) baseline_quarters FROM scored GROUP BY lead_day
  ), day_origin AS (
    SELECT lead_day,run_id,target_day,count(*) quarters,abs(avg(baseline-actual)) reduced,abs(avg(candidate-actual)) corrected,
      extract(epoch FROM ((target_day+1)::timestamp AT TIME ZONE 'Europe/Stockholm')-(target_day::timestamp AT TIME ZONE 'Europe/Stockholm'))/900 expected
    FROM paired GROUP BY lead_day,run_id,target_day
  ), daily AS (
    SELECT lead_day,count(*) scored_day_origins,count(*) FILTER(WHERE quarters=expected) complete_day_origins,
      avg(reduced) reduced_daily_mean_mae,avg(corrected) full_daily_mean_mae FROM day_origin GROUP BY lead_day
  ), days AS (
    SELECT lead_day,target_day,count(*) scored_quarters,count(DISTINCT run_id) origin_count,
      avg(abs(baseline-actual)) reduced_mae,avg(abs(candidate-actual)) full_mae FROM paired GROUP BY lead_day,target_day
  ), wins AS (SELECT lead_day,count(*) FILTER(WHERE full_mae<reduced_mae) day_wins FROM days GROUP BY lead_day)
  SELECT jsonb_build_object(
    'scores',coalesce((SELECT jsonb_agg(jsonb_build_object('lead_day',q.lead_day,'scored_quarters',q.scored_quarters,'origin_count',q.origin_count,
      'target_day_count',q.target_day_count,'reduced_mae',q.reduced_mae,'full_mae',q.full_mae,'reduced_bias',q.reduced_bias,'full_bias',q.full_bias,
      'mae_improvement',q.reduced_mae-q.full_mae,'reduced_daily_mean_mae',d.reduced_daily_mean_mae,'full_daily_mean_mae',d.full_daily_mean_mae,
      'complete_day_origins',d.complete_day_origins,'scored_day_origins',d.scored_day_origins,'day_wins',w.day_wins,'baseline_quarters',c.baseline_quarters)
      ORDER BY q.lead_day) FROM quarters q JOIN daily d USING(lead_day) JOIN wins w USING(lead_day) JOIN coverage c USING(lead_day)),'[]'::jsonb),
    'days',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.target_day,x.lead_day) FROM days x),'[]'::jsonb));
$$;

-- Staff projection for the TEST bench. Replay results are the fixed walk-forward holdout only:
-- delivery days 3-10 November 2026, chosen before any of them was scored. Earlier days chose the model.
CREATE FUNCTION public.get_test_weather_price_comparison(p_run_id uuid DEFAULT NULL,p_kind text DEFAULT 'prospective')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid:=private.test_weather_price_home(); report jsonb; selected public.energy_test_weather_price_runs%ROWTYPE;
  selected_json jsonb; targets jsonb; day_from date; day_to date;
BEGIN
  IF NOT coalesce(public.is_staff(auth.uid()),false) THEN RAISE EXCEPTION 'Price forecast comparisons are staff-only' USING ERRCODE='42501'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('prospective','replay') THEN RAISE EXCEPTION 'Unknown TEST weather price cohort' USING ERRCODE='22023'; END IF;
  IF scoped_home IS NULL THEN
    RETURN jsonb_build_object('enabled',false,'kind',p_kind,'updated_at',clock_timestamp(),
      'report',jsonb_build_object('truth_cutoff',0,'pair_count',0,'scores','[]'::jsonb,'days','[]'::jsonb,'pairs','[]'::jsonb),'selected',NULL,'targets','[]'::jsonb);
  END IF;
  IF p_kind='replay' THEN day_from:='2026-11-03'; day_to:='2026-11-10'; END IF;
  report:=private.test_weather_price_report(scoped_home,p_kind,day_from,day_to)||jsonb_build_object(
    'truth_cutoff',coalesce((SELECT max(sequence) FROM public.energy_test_price_observations WHERE home_id=scoped_home),0),
    'pair_count',(SELECT count(*) FROM public.energy_test_weather_price_runs WHERE home_id=scoped_home AND kind=p_kind),
    'pairs',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.reserved_at DESC,s.id) FROM (
      SELECT r.id,CASE r.status WHEN 'forecast' THEN 'paired' ELSE 'unavailable' END status,r.origin_at reserved_at,r.origin_at saved_at,
        (SELECT count(*) FROM public.energy_test_weather_price_targets WHERE run_id=r.id) target_count,
        (SELECT count(*) FROM public.energy_test_weather_price_targets WHERE run_id=r.id AND candidate IS NOT NULL) eligible_count,
        (SELECT count(*) FROM private.test_weather_price_outcomes WHERE run_id=r.id AND candidate IS NOT NULL) scored_count
      FROM public.energy_test_weather_price_runs r WHERE home_id=scoped_home AND kind=p_kind ORDER BY origin_at DESC,id LIMIT 100) s),'[]'::jsonb));
  IF p_run_id IS NULL THEN
    SELECT * INTO selected FROM public.energy_test_weather_price_runs WHERE home_id=scoped_home AND kind=p_kind ORDER BY origin_at DESC,id LIMIT 1;
  ELSE
    SELECT * INTO selected FROM public.energy_test_weather_price_runs WHERE home_id=scoped_home AND id=p_run_id AND kind=p_kind;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown TEST weather price forecast' USING ERRCODE='22023'; END IF;
  END IF;
  IF selected.id IS NOT NULL THEN
    selected_json:=jsonb_build_object('id',selected.id,'status',CASE selected.status WHEN 'forecast' THEN 'paired' ELSE 'unavailable' END,
      'reserved_at',selected.origin_at,'saved_at',selected.origin_at,'reason',selected.reason,'training_quarters',selected.training_quarters,
      'baseline_generated_at',selected.origin_at,
      'target_count',(SELECT count(*) FROM public.energy_test_weather_price_targets WHERE run_id=selected.id),
      'eligible_count',(SELECT count(*) FROM public.energy_test_weather_price_targets WHERE run_id=selected.id AND candidate IS NOT NULL));
    SELECT coalesce(jsonb_agg(jsonb_build_object('start',t.start_ts,'target_day',t.target_day,'lead_day',t.lead_day,
      'reduced',t.baseline,'full',t.candidate,'actual',o.actual,'truth_sequence',o.truth_sequence) ORDER BY t.start_ts),'[]'::jsonb) INTO targets
      FROM public.energy_test_weather_price_targets t LEFT JOIN private.test_weather_price_outcomes o ON o.run_id=t.run_id AND o.start_ts=t.start_ts
      WHERE t.run_id=selected.id AND t.candidate IS NOT NULL;
  END IF;
  RETURN jsonb_build_object('enabled',true,'kind',p_kind,'updated_at',clock_timestamp(),'home_name',(SELECT name FROM public.homes WHERE id=scoped_home),
    'holdout',CASE WHEN p_kind='replay' THEN jsonb_build_object('from',day_from,'to',day_to) END,
    'report',report,'selected',selected_json,'targets',coalesce(targets,'[]'::jsonb));
END; $$;

CREATE FUNCTION private.request_test_weather_price(p_tick timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
  SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
  IF NOT FOUND OR NOT config.weather_price_enabled THEN RETURN; END IF;
  IF config.function_url<>'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive' THEN RAISE EXCEPTION 'TEST weather price study requires TEST archive'; END IF;
  PERFORM net.http_post(url:='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-price-weather-experiment',
    headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
    body:=CASE WHEN p_tick IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('tick',p_tick) END,timeout_milliseconds:=180000);
END; $$;
-- Requests the walk-forward replay for 6-hourly ticks that have a deployed forecast and no saved run yet.
CREATE FUNCTION private.replay_test_weather_price(p_from timestamptz,p_to timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid:=private.test_weather_price_home(); tick timestamptz; requested integer:=0;
BEGIN
  IF scoped_home IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to-p_from>interval '31 days' THEN RETURN 0; END IF;
  FOR tick IN SELECT generate_series(p_from,least(p_to,clock_timestamp()),interval '6 hours') LOOP
    IF EXISTS(SELECT 1 FROM public.energy_price_forecast_generations b WHERE b.home_id=scoped_home AND b.generated_at<=tick AND b.generated_at>tick-interval '30 minutes'
      AND b.id=(SELECT id FROM public.energy_price_forecast_generations WHERE home_id=scoped_home AND generated_at<=tick AND generated_at>tick-interval '30 minutes' ORDER BY generated_at DESC,id DESC LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM public.energy_test_weather_price_runs r WHERE r.home_id=scoped_home AND r.baseline_id=b.id)) THEN
      PERFORM private.request_test_weather_price(tick); requested:=requested+1;
    END IF;
  END LOOP;
  RETURN requested;
END; $$;
CREATE FUNCTION private.enable_test_weather_price()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton AND price_experiment_home_id IS NOT NULL
    AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive') THEN RAISE EXCEPTION 'Enable the scoped TEST price ledger first'; END IF;
  UPDATE private.test_market_archive_config SET weather_price_enabled=true WHERE singleton;
  -- After the weather (:17), context (:27) and regional (:47) collections; the same ticks as the validation.
  PERFORM cron.schedule('test-energy-price-weather','50 */6 * * *','SELECT private.request_test_weather_price()');
END; $$;

REVOKE ALL ON FUNCTION private.test_weather_price_home(),private.test_weather_price_targets(uuid,bigint),private.test_weather_price_report(uuid,text,date,date),
  private.request_test_weather_price(timestamptz),private.replay_test_weather_price(timestamptz,timestamptz),private.enable_test_weather_price()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.read_test_weather_price_context(timestamptz),public.record_test_weather_price(uuid,jsonb),
  public.get_test_weather_price_comparison(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_test_weather_price_context(timestamptz),public.record_test_weather_price(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_test_weather_price_comparison(uuid,text) TO authenticated;
REVOKE ALL ON private.test_weather_price_outcomes FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.energy_test_weather_price_runs IS 'TEST research: weather-driven D+2/D+3 price forecasts beside the deployed estimate. Never read by household planning.';
