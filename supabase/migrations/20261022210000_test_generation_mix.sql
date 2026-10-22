-- Experimental generation forecasts share the TEST collector, never the planner.
ALTER TABLE public.energy_market_forecast_observations
  DROP CONSTRAINT energy_market_forecast_observations_dataset_check,
  ADD CONSTRAINT energy_market_forecast_observations_dataset_check CHECK(dataset IN (
    'wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual'));

CREATE TABLE public.energy_generation_forecast_runs (
  id uuid PRIMARY KEY,
  zone text NOT NULL CHECK(zone='SE3'),
  origin timestamptz NOT NULL,
  algorithm text NOT NULL,
  source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='object'),
  forecast jsonb NOT NULL CHECK(jsonb_typeof(forecast)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX energy_generation_forecast_runs_origin ON public.energy_generation_forecast_runs(zone,origin);
ALTER TABLE public.energy_generation_forecast_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_generation_forecast_runs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.energy_generation_forecast_runs TO service_role;

CREATE FUNCTION private.validate_generation_forecast_run()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE dataset_name text; observation_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN
    RAISE EXCEPTION 'TEST market archive is not enabled';
  END IF;
  IF NEW.forecast->>'origin' IS DISTINCT FROM to_char(NEW.origin AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR NEW.forecast->>'algorithm' IS DISTINCT FROM NEW.algorithm
    OR NEW.forecast->>'zone' IS DISTINCT FROM NEW.zone THEN
    RAISE EXCEPTION 'Forecast identity does not match frozen model output';
  END IF;
  IF NEW.source_refs - ARRAY['wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Unknown generation evidence dataset';
  END IF;
  FOREACH dataset_name IN ARRAY ARRAY['wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual'] LOOP
    IF NOT (NEW.source_refs ? dataset_name) THEN RAISE EXCEPTION 'Missing generation evidence dataset'; END IF;
    observation_id := (NEW.source_refs->>dataset_name)::uuid;
    IF observation_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.energy_market_forecast_observations o
      WHERE o.id=observation_id AND o.dataset=dataset_name) THEN
      RAISE EXCEPTION 'Generation evidence reference does not match dataset';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER validate_generation_forecast_run BEFORE INSERT ON public.energy_generation_forecast_runs
  FOR EACH ROW EXECUTE FUNCTION private.validate_generation_forecast_run();
REVOKE ALL ON FUNCTION private.validate_generation_forecast_run() FROM PUBLIC,anon,authenticated,service_role;

-- Existing ingest preserves this context verbatim. Pin the committed research
-- run before each price calculation without deploying or changing that producer.
CREATE OR REPLACE FUNCTION public.read_test_price_forecast_context()
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton)
    THEN jsonb_build_object('known_at',clock_timestamp(),'generation_mix_run_id',(
      SELECT id FROM public.energy_generation_forecast_runs ORDER BY recorded_at DESC,id DESC LIMIT 1
    ),'datasets',(
      SELECT jsonb_object_agg(dataset,jsonb_build_object(
        'latest_attempt_id',(SELECT id FROM public.energy_market_forecast_observations o WHERE o.dataset=d.dataset ORDER BY sequence DESC LIMIT 1),
        'latest_data_id',(SELECT id FROM public.energy_market_forecast_observations o WHERE o.dataset=d.dataset AND o.result->>'status'='data' ORDER BY sequence DESC LIMIT 1)))
      FROM (VALUES('wind_day_ahead'),('load_day_ahead'),('load_week_ahead'),('weather_medium_range')) AS d(dataset)))
    ELSE NULL END;
$$;

CREATE FUNCTION private.validate_price_generation_mix_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
  IF NEW.market_context->>'generation_mix_run_id' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.energy_generation_forecast_runs WHERE id=(NEW.market_context->>'generation_mix_run_id')::uuid
  ) THEN RAISE EXCEPTION 'Unknown generation mix run'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER validate_price_generation_mix_reference BEFORE INSERT ON public.energy_price_forecast_generations
  FOR EACH ROW EXECUTE FUNCTION private.validate_price_generation_mix_reference();
REVOKE ALL ON FUNCTION private.validate_price_generation_mix_reference() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.request_test_generation_forecast()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
  SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM net.http_post(url:=config.function_url,
    headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
    body:='{"generation":true}'::jsonb,timeout_milliseconds:=180000);
END; $$;

CREATE FUNCTION private.enable_test_generation_forecast()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN
    RAISE EXCEPTION 'Enable the TEST market archive first';
  END IF;
  PERFORM cron.schedule('test-energy-generation-forecast','17 */6 * * *','SELECT private.request_test_generation_forecast()');
END; $$;
REVOKE ALL ON FUNCTION private.request_test_generation_forecast(),private.enable_test_generation_forecast()
  FROM PUBLIC,anon,authenticated,service_role;
