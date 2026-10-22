-- Prospective TEST-only price research. Inert until explicit TEST activation.
ALTER TABLE private.test_market_archive_config
  ADD COLUMN price_experiment_home_id uuid REFERENCES public.homes(id);

CREATE TABLE public.energy_test_price_observations (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  home_id uuid NOT NULL REFERENCES public.homes(id),
  start_ts timestamptz NOT NULL,
  import_price_sek_per_kwh numeric NOT NULL CHECK(import_price_sek_per_kwh NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  event text NOT NULL CHECK(event IN ('initial_seed','insert','revision','reconcile')),
  source text NOT NULL,
  source_received_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX energy_test_price_observations_home_start
  ON public.energy_test_price_observations(home_id,start_ts,sequence DESC);

CREATE TABLE public.energy_test_price_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES public.homes(id),
  mix_run_id uuid NOT NULL REFERENCES public.energy_generation_forecast_runs(id),
  algorithm text NOT NULL CHECK(algorithm='se3-price-mix-pair-v1'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paired','unavailable')),
  context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),
  forecast jsonb,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  saved_at timestamptz,
  eligibility_cutoff bigint,
  UNIQUE(home_id,mix_run_id,algorithm),
  CHECK((status='pending' AND forecast IS NULL AND saved_at IS NULL AND eligibility_cutoff IS NULL)
    OR (status<>'pending' AND jsonb_typeof(forecast)='object' AND saved_at IS NOT NULL AND eligibility_cutoff IS NOT NULL))
);
CREATE INDEX energy_test_price_pairs_pending ON public.energy_test_price_pairs(home_id,reserved_at,id) WHERE status='pending';

CREATE TABLE public.energy_test_price_targets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pair_id uuid NOT NULL REFERENCES public.energy_test_price_pairs(id),
  home_id uuid NOT NULL REFERENCES public.homes(id),
  start_ts timestamptz NOT NULL,
  target_day date NOT NULL,
  lead_day integer NOT NULL,
  reduced numeric,
  "full" numeric,
  reason text,
  eligible boolean NOT NULL,
  eligibility_reason text NOT NULL CHECK(eligibility_reason IN ('eligible','unavailable','not_future','already_known')),
  UNIQUE(pair_id,start_ts),
  CHECK(NOT eligible OR (reduced IS NOT NULL AND "full" IS NOT NULL AND reason IS NULL AND eligibility_reason='eligible'))
);
CREATE INDEX energy_test_price_targets_outcome ON public.energy_test_price_targets(home_id,start_ts,pair_id) WHERE eligible;

ALTER TABLE public.energy_test_price_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_test_price_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_test_price_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_test_price_observations,public.energy_test_price_pairs,public.energy_test_price_targets
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.energy_test_price_observations,public.energy_test_price_pairs,public.energy_test_price_targets TO service_role;
REVOKE ALL ON SEQUENCE public.energy_test_price_observations_sequence_seq,public.energy_test_price_targets_id_seq
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.lock_test_price_experiment()
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'TEST price research requires READ COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock(726345982016103::bigint);
END; $$;

CREATE FUNCTION private.immutable_test_price_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  RAISE EXCEPTION 'TEST price evidence is immutable';
END; $$;
CREATE TRIGGER immutable_test_price_observation BEFORE UPDATE OR DELETE ON public.energy_test_price_observations
  FOR EACH ROW EXECUTE FUNCTION private.immutable_test_price_evidence();
CREATE TRIGGER immutable_test_price_target BEFORE UPDATE OR DELETE ON public.energy_test_price_targets
  FOR EACH ROW EXECUTE FUNCTION private.immutable_test_price_evidence();

CREATE FUNCTION private.validate_test_price_pair_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TEST price pair is immutable'; END IF;
  IF OLD.status<>'pending' OR NEW.status='pending'
    OR (to_jsonb(NEW)-ARRAY['status','forecast','saved_at','eligibility_cutoff'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','forecast','saved_at','eligibility_cutoff']) THEN
    RAISE EXCEPTION 'TEST price pair is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER validate_test_price_pair_transition BEFORE UPDATE OR DELETE ON public.energy_test_price_pairs
  FOR EACH ROW EXECUTE FUNCTION private.validate_test_price_pair_transition();

-- Installed only during explicit TEST activation. A row upsert has already
-- taken its source row locks; this function never locks a source row itself.
CREATE FUNCTION private.capture_test_price_knowledge()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; prior numeric;
BEGIN
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config
    WHERE singleton AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  IF scoped_home IS NULL OR NEW.home_id<>scoped_home THEN RETURN NEW; END IF;
  SELECT o.import_price_sek_per_kwh INTO prior FROM public.energy_test_price_observations o
    WHERE o.home_id=NEW.home_id AND o.start_ts=NEW.start_ts ORDER BY o.sequence DESC LIMIT 1;
  IF NOT FOUND OR prior IS DISTINCT FROM NEW.import_price_sek_per_kwh THEN
    INSERT INTO public.energy_test_price_observations(home_id,start_ts,import_price_sek_per_kwh,event,source,source_received_at)
      VALUES(NEW.home_id,NEW.start_ts,NEW.import_price_sek_per_kwh,
        CASE WHEN TG_OP='INSERT' THEN 'insert' ELSE 'revision' END,NEW.source,NEW.received_at);
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION private.request_test_price_experiment()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
  SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
  IF NOT FOUND OR config.price_experiment_home_id IS NULL THEN RETURN; END IF;
  IF config.function_url<>'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive' THEN
    RAISE EXCEPTION 'TEST price research requires the TEST collector';
  END IF;
  PERFORM net.http_post(url:='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-price-experiment',
    headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
    body:='{}'::jsonb,timeout_milliseconds:=180000);
END; $$;

CREATE FUNCTION private.enable_test_price_experiment(p_home_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
  -- Exclude writers before acquiring the advisory lock: existing price writers
  -- finish their row-trigger transaction first, avoiding an inverse lock order.
  LOCK TABLE public.energy_optimisation_price_slots IN SHARE ROW EXCLUSIVE MODE;
  PERFORM private.lock_test_price_experiment();
  SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
  IF NOT FOUND OR config.function_url<>'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive' THEN
    RAISE EXCEPTION 'Enable the exact TEST market archive first';
  END IF;
  IF p_home_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.homes WHERE id=p_home_id) THEN RAISE EXCEPTION 'Unknown TEST research home'; END IF;
  IF config.price_experiment_home_id IS NOT NULL AND config.price_experiment_home_id<>p_home_id THEN RAISE EXCEPTION 'TEST price experiment already has a different home'; END IF;
  UPDATE private.test_market_archive_config SET price_experiment_home_id=p_home_id WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.energy_optimisation_price_slots'::regclass AND tgname='capture_test_price_knowledge' AND NOT tgisinternal) THEN
    CREATE TRIGGER capture_test_price_knowledge AFTER INSERT OR UPDATE ON public.energy_optimisation_price_slots
      FOR EACH ROW EXECUTE FUNCTION private.capture_test_price_knowledge();
  END IF;
  INSERT INTO public.energy_test_price_observations(home_id,start_ts,import_price_sek_per_kwh,event,source,source_received_at)
    SELECT p.home_id,p.start_ts,p.import_price_sek_per_kwh,
      CASE WHEN prior.sequence IS NULL THEN 'initial_seed' ELSE 'reconcile' END,p.source,p.received_at
    FROM public.energy_optimisation_price_slots p
    LEFT JOIN LATERAL(SELECT o.sequence,o.import_price_sek_per_kwh FROM public.energy_test_price_observations o
      WHERE o.home_id=p.home_id AND o.start_ts=p.start_ts ORDER BY sequence DESC LIMIT 1) prior ON true
    WHERE p.home_id=p_home_id AND (prior.sequence IS NULL OR prior.import_price_sek_per_kwh IS DISTINCT FROM p.import_price_sek_per_kwh);
  PERFORM cron.schedule('test-energy-price-experiment','27 * * * *','SELECT private.request_test_price_experiment()');
END; $$;

CREATE FUNCTION public.begin_test_price_pair()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; pair public.energy_test_price_pairs%ROWTYPE;
  mix public.energy_generation_forecast_runs%ROWTYPE; known_at timestamptz; cutoff bigint; frozen_prices jsonb; frozen_context jsonb;
BEGIN
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config
    WHERE singleton AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  IF scoped_home IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO pair FROM public.energy_test_price_pairs
    WHERE home_id=scoped_home AND algorithm='se3-price-mix-pair-v1' AND status='pending' ORDER BY reserved_at,id LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('id',pair.id,'status',pair.status,'context',pair.context); END IF;
  SELECT * INTO mix FROM public.energy_generation_forecast_runs
    WHERE zone='SE3' AND algorithm='se3-generation-analog-v2' ORDER BY recorded_at DESC,id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO pair FROM public.energy_test_price_pairs
    WHERE home_id=scoped_home AND mix_run_id=mix.id AND algorithm='se3-price-mix-pair-v1';
  IF FOUND THEN RETURN jsonb_build_object('id',pair.id,'status',pair.status,'context',pair.context); END IF;
  known_at := clock_timestamp();
  SELECT coalesce(max(sequence),0) INTO cutoff FROM public.energy_test_price_observations WHERE home_id=scoped_home;
  SELECT coalesce(jsonb_agg(jsonb_build_object('start_ts',p.start_ts,
      'import_price_sek_per_kwh',p.import_price_sek_per_kwh) ORDER BY p.start_ts),'[]'::jsonb) INTO frozen_prices
    FROM (SELECT DISTINCT ON(start_ts) start_ts,import_price_sek_per_kwh FROM public.energy_test_price_observations
      WHERE home_id=scoped_home AND sequence<=cutoff AND start_ts>=known_at-interval '90 days' ORDER BY start_ts,sequence DESC) p;
  frozen_context := jsonb_build_object('homeId',scoped_home,'mixRunId',mix.id,'knownAt',known_at,'origin',known_at,
    'prices',frozen_prices,'generation',mix.forecast,'actualObservationId',mix.source_refs->>'generation_actual','priceCutoff',cutoff);
  INSERT INTO public.energy_test_price_pairs(home_id,mix_run_id,algorithm,context,reserved_at)
    VALUES(scoped_home,mix.id,'se3-price-mix-pair-v1',frozen_context,known_at) RETURNING * INTO pair;
  RETURN jsonb_build_object('id',pair.id,'status',pair.status,'context',pair.context);
END; $$;

CREATE FUNCTION public.complete_test_price_pair(p_id uuid,p_forecast jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; pair public.energy_test_price_pairs%ROWTYPE; saved timestamptz; cutoff bigint;
  target jsonb; start_time timestamptz; reduced_value numeric; full_value numeric; missing_reason text;
  forecast_status text; actual_count integer; expected_count integer; target_day date; lead_day integer; eligibility text;
BEGIN
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config
    WHERE singleton AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  SELECT * INTO pair FROM public.energy_test_price_pairs WHERE id=p_id AND home_id=scoped_home;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown TEST price pair'; END IF;
  IF pair.status<>'pending' THEN
    IF pair.forecast IS DISTINCT FROM p_forecast THEN RAISE EXCEPTION 'Conflicting completed TEST price pair'; END IF;
    RETURN jsonb_build_object('id',pair.id,'status',pair.status,
      'target_count',(SELECT count(*) FROM public.energy_test_price_targets WHERE pair_id=pair.id),
      'eligible_count',(SELECT count(*) FROM public.energy_test_price_targets WHERE pair_id=pair.id AND eligible));
  END IF;
  IF p_forecast IS NULL OR jsonb_typeof(p_forecast)<>'object'
    OR p_forecast-ARRAY['status','reason','fit','targets']<>'{}'::jsonb
    OR NOT(p_forecast ?& ARRAY['status','fit','targets']) THEN RAISE EXCEPTION 'Invalid TEST price pair output'; END IF;
  forecast_status := p_forecast->>'status';
  IF forecast_status NOT IN ('paired','unavailable') OR forecast_status IS NULL
    OR jsonb_typeof(p_forecast->'targets')<>'array'
    OR jsonb_typeof(p_forecast->'fit') NOT IN ('object','null')
    OR (forecast_status='paired' AND jsonb_typeof(p_forecast->'fit')<>'object')
    OR (p_forecast ? 'reason' AND jsonb_typeof(p_forecast->'reason') NOT IN ('string','null')) THEN
    RAISE EXCEPTION 'Invalid TEST price pair status or fit';
  END IF;
  IF jsonb_typeof(pair.context->'generation'->'hours')<>'array'
    OR jsonb_array_length(pair.context->'generation'->'hours')<>72 THEN RAISE EXCEPTION 'Pinned generation has no 72-hour target grid'; END IF;
  SELECT count(*) INTO expected_count FROM (
    SELECT DISTINCT (h->>'start')::timestamptz + q*interval '15 minutes' AS start_ts
    FROM jsonb_array_elements(pair.context->'generation'->'hours') h CROSS JOIN generate_series(0,3) q
  ) expected;
  actual_count := jsonb_array_length(p_forecast->'targets');
  IF expected_count<>288 OR actual_count<>expected_count THEN RAISE EXCEPTION 'TEST price pair target grid must match 72 pinned hours'; END IF;
  -- All shape and value checks precede mutation. A failed complete remains pending.
  FOR target IN SELECT value FROM jsonb_array_elements(p_forecast->'targets') LOOP
    IF jsonb_typeof(target)<>'object' OR target-ARRAY['start','reduced','full','reason']<>'{}'::jsonb
      OR NOT(target ?& ARRAY['start','reduced','full','reason']) OR jsonb_typeof(target->'start')<>'string'
      OR jsonb_typeof(target->'reduced') NOT IN ('number','null') OR jsonb_typeof(target->'full') NOT IN ('number','null')
      OR jsonb_typeof(target->'reason') NOT IN ('string','null') THEN RAISE EXCEPTION 'Invalid TEST price target shape'; END IF;
    start_time := (target->>'start')::timestamptz;
    IF NOT isfinite(start_time) OR extract(epoch FROM start_time)::numeric % 900<>0 OR NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(pair.context->'generation'->'hours') h CROSS JOIN generate_series(0,3) q
        WHERE (h->>'start')::timestamptz + q*interval '15 minutes'=start_time) THEN RAISE EXCEPTION 'TEST price target is outside the pinned grid'; END IF;
    IF (target->>'reduced')::numeric IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
      OR (target->>'full')::numeric IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) THEN RAISE EXCEPTION 'TEST price target must be finite'; END IF;
    IF (((target->>'reduced') IS NULL OR (target->>'full') IS NULL) AND (target->>'reason') IS NULL)
      OR (((target->>'reduced') IS NOT NULL AND (target->>'full') IS NOT NULL) AND (target->>'reason') IS NOT NULL) THEN RAISE EXCEPTION 'TEST price target availability requires an explicit reason'; END IF;
    IF forecast_status='unavailable' AND (target->>'reduced') IS NOT NULL AND (target->>'full') IS NOT NULL THEN RAISE EXCEPTION 'Unavailable TEST pair cannot contain paired predictions'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'start')::timestamptz) FROM jsonb_array_elements(p_forecast->'targets'))<>expected_count THEN
    RAISE EXCEPTION 'TEST price target grid contains duplicates';
  END IF;
  saved := clock_timestamp();
  SELECT coalesce(max(sequence),0) INTO cutoff FROM public.energy_test_price_observations WHERE home_id=scoped_home;
  FOR target IN SELECT value FROM jsonb_array_elements(p_forecast->'targets') LOOP
    start_time := (target->>'start')::timestamptz;
    reduced_value := (target->>'reduced')::numeric; full_value := (target->>'full')::numeric; missing_reason := target->>'reason';
    target_day := (start_time AT TIME ZONE 'Europe/Stockholm')::date;
    lead_day := target_day-((pair.context->>'knownAt')::timestamptz AT TIME ZONE 'Europe/Stockholm')::date;
    eligibility := CASE WHEN reduced_value IS NULL OR full_value IS NULL THEN 'unavailable' WHEN start_time<=saved THEN 'not_future'
      WHEN EXISTS(SELECT 1 FROM public.energy_test_price_observations o WHERE o.home_id=scoped_home AND o.start_ts=start_time)
        THEN 'already_known' ELSE 'eligible' END;
    INSERT INTO public.energy_test_price_targets(pair_id,home_id,start_ts,target_day,lead_day,reduced,"full",reason,eligible,eligibility_reason)
      VALUES(pair.id,scoped_home,start_time,target_day,lead_day,reduced_value,full_value,missing_reason,eligibility='eligible',eligibility);
  END LOOP;
  UPDATE public.energy_test_price_pairs SET status=forecast_status,forecast=p_forecast,saved_at=saved,eligibility_cutoff=cutoff WHERE id=pair.id;
  RETURN jsonb_build_object('id',pair.id,'status',forecast_status,'target_count',actual_count,
    'eligible_count',(SELECT count(*) FROM public.energy_test_price_targets WHERE pair_id=pair.id AND eligible));
END; $$;

CREATE VIEW public.energy_test_price_pair_outcomes AS
  SELECT p.id AS pair_id,t.id AS target_id,p.home_id,p.mix_run_id,p.algorithm,p.context->>'origin' AS origin,
    p.saved_at,p.eligibility_cutoff,t.start_ts,t.target_day,t.lead_day,t.reduced,t."full",
    truth.sequence AS truth_sequence,truth.recorded_at AS truth_recorded_at,
    truth.import_price_sek_per_kwh AS actual,
    t.reduced-truth.import_price_sek_per_kwh AS reduced_error,
    t."full"-truth.import_price_sek_per_kwh AS full_error,
    abs(t.reduced-truth.import_price_sek_per_kwh) AS reduced_absolute_error,
    abs(t."full"-truth.import_price_sek_per_kwh) AS full_absolute_error
  FROM public.energy_test_price_targets t
  JOIN public.energy_test_price_pairs p ON p.id=t.pair_id AND p.status='paired'
  JOIN LATERAL(SELECT o.sequence,o.recorded_at,o.import_price_sek_per_kwh FROM public.energy_test_price_observations o
    WHERE o.home_id=t.home_id AND o.start_ts=t.start_ts ORDER BY o.sequence DESC LIMIT 1) truth ON true
  WHERE t.eligible AND truth.sequence>p.eligibility_cutoff;

CREATE VIEW public.energy_test_price_pair_scores AS
  WITH quarters AS (
    SELECT home_id,algorithm,lead_day,count(*) AS scored_quarters,count(DISTINCT pair_id) AS origin_count,
      count(DISTINCT target_day) AS target_day_count,max(truth_sequence) AS truth_cutoff,
      avg(reduced_absolute_error) AS reduced_mae,avg(full_absolute_error) AS full_mae,
      avg(reduced_error) AS reduced_bias,avg(full_error) AS full_bias
    FROM public.energy_test_price_pair_outcomes GROUP BY home_id,algorithm,lead_day
  ), day_means AS (
    SELECT home_id,algorithm,lead_day,pair_id,target_day,count(*) AS scored_quarters,
      abs(avg(reduced_error)) AS reduced_daily_mean_absolute_error,
      abs(avg(full_error)) AS full_daily_mean_absolute_error,
      extract(epoch FROM ((target_day+1)::timestamp AT TIME ZONE 'Europe/Stockholm')-
        (target_day::timestamp AT TIME ZONE 'Europe/Stockholm'))/900 AS expected_day_quarters
    FROM public.energy_test_price_pair_outcomes GROUP BY home_id,algorithm,lead_day,pair_id,target_day
  ), daily AS (
    SELECT home_id,algorithm,lead_day,count(*) AS scored_day_origins,
      count(*) FILTER(WHERE scored_quarters=expected_day_quarters) AS complete_day_origins,
      avg(reduced_daily_mean_absolute_error) AS reduced_daily_mean_mae,
      avg(full_daily_mean_absolute_error) AS full_daily_mean_mae
    FROM day_means GROUP BY home_id,algorithm,lead_day
  ) SELECT q.*,q.reduced_mae-q.full_mae AS mae_improvement,
      d.scored_day_origins,d.complete_day_origins,d.reduced_daily_mean_mae,d.full_daily_mean_mae
    FROM quarters q JOIN daily d USING(home_id,algorithm,lead_day);
REVOKE ALL ON public.energy_test_price_pair_outcomes,public.energy_test_price_pair_scores FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.energy_test_price_pair_outcomes,public.energy_test_price_pair_scores TO service_role;

CREATE FUNCTION public.read_test_price_pair_report()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE scoped_home uuid; report jsonb;
BEGIN
  PERFORM private.lock_test_price_experiment();
  SELECT price_experiment_home_id INTO scoped_home FROM private.test_market_archive_config
    WHERE singleton AND function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
  -- One statement owns the snapshot for the entire cross-table report.
  SELECT jsonb_build_object(
    'truth_cutoff',coalesce((SELECT max(sequence) FROM public.energy_test_price_observations WHERE home_id=scoped_home),0),
    'pair_count',(SELECT count(*) FROM public.energy_test_price_pairs WHERE home_id=scoped_home),
    'scores',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.algorithm,s.lead_day) FROM public.energy_test_price_pair_scores s WHERE s.home_id=scoped_home),'[]'::jsonb),
    'pairs',coalesce((SELECT jsonb_agg(to_jsonb(summary) ORDER BY summary.reserved_at DESC,summary.id) FROM (
      SELECT p.id,p.home_id,p.mix_run_id,p.algorithm,p.status,p.reserved_at,p.saved_at,p.eligibility_cutoff,
        (SELECT count(*) FROM public.energy_test_price_targets t WHERE t.pair_id=p.id) AS target_count,
        (SELECT count(*) FROM public.energy_test_price_targets t WHERE t.pair_id=p.id AND eligible) AS eligible_count,
        (SELECT count(*) FROM public.energy_test_price_pair_outcomes o WHERE o.pair_id=p.id) AS scored_count
      FROM public.energy_test_price_pairs p WHERE p.home_id=scoped_home ORDER BY p.reserved_at DESC,p.id LIMIT 100
    ) summary),'[]'::jsonb)) INTO report;
  RETURN report;
END; $$;

REVOKE ALL ON FUNCTION private.lock_test_price_experiment(),private.immutable_test_price_evidence(),
  private.validate_test_price_pair_transition(),private.capture_test_price_knowledge(),
  private.request_test_price_experiment(),private.enable_test_price_experiment(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.begin_test_price_pair(),public.complete_test_price_pair(uuid,jsonb),public.read_test_price_pair_report()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.begin_test_price_pair(),public.complete_test_price_pair(uuid,jsonb),public.read_test_price_pair_report() TO service_role;
COMMENT ON TABLE public.energy_test_price_observations IS 'Append-only TEST-local knowledge of published all-in import prices; recorded_at is not exchange publication time.';
COMMENT ON TABLE public.energy_test_price_pairs IS 'Frozen prospective shadow ridge ablations; household planning and prices are unchanged.';
