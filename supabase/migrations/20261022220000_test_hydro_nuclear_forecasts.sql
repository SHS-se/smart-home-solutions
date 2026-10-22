-- Add public Swedish hydrology and ENTSO-E availability to the TEST experiment.
ALTER TABLE public.energy_market_forecast_observations
  DROP CONSTRAINT energy_market_forecast_observations_dataset_check,
  ADD CONSTRAINT energy_market_forecast_observations_dataset_check CHECK(dataset IN (
    'wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual',
    'sweden_hydrology','production_outages','generation_outages','installed_generation_units'));

CREATE OR REPLACE FUNCTION private.validate_generation_forecast_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE dataset_name text; observation_id uuid; expected text[];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN
    RAISE EXCEPTION 'TEST market archive is not enabled';
  END IF;
  IF NEW.forecast->>'origin' IS DISTINCT FROM to_char(NEW.origin AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR NEW.forecast->>'algorithm' IS DISTINCT FROM NEW.algorithm
    OR NEW.forecast->>'zone' IS DISTINCT FROM NEW.zone THEN
    RAISE EXCEPTION 'Forecast identity does not match frozen model output';
  END IF;
  expected := ARRAY['wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual'];
  IF NEW.algorithm='se3-generation-analog-v2' THEN
    expected := expected || ARRAY['sweden_hydrology','production_outages','generation_outages','installed_generation_units'];
  ELSIF NEW.algorithm<>'se3-generation-analog-v1' THEN
    RAISE EXCEPTION 'Unknown generation algorithm';
  END IF;
  IF NEW.source_refs - expected <> '{}'::jsonb THEN RAISE EXCEPTION 'Unknown generation evidence dataset'; END IF;
  FOREACH dataset_name IN ARRAY expected LOOP
    IF NOT (NEW.source_refs ? dataset_name) THEN RAISE EXCEPTION 'Missing generation evidence dataset'; END IF;
    observation_id := (NEW.source_refs->>dataset_name)::uuid;
    IF observation_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.energy_market_forecast_observations o WHERE o.id=observation_id AND o.dataset=dataset_name
    ) THEN RAISE EXCEPTION 'Generation evidence reference does not match dataset'; END IF;
  END LOOP;
  RETURN NEW;
END; $$;
