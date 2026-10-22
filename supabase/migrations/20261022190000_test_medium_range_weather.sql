-- Extend the inert research archive. Existing evidence and production policy
-- remain unchanged; new generations pin the weather observed before calculation.
ALTER TABLE public.energy_market_forecast_observations
  DROP CONSTRAINT energy_market_forecast_observations_dataset_check,
  ADD CONSTRAINT energy_market_forecast_observations_dataset_check
    CHECK(dataset IN ('wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range')),
  ADD CONSTRAINT energy_market_forecast_observations_weather_evidence_check CHECK(
    dataset<>'weather_medium_range' OR (
      result->>'status' IN ('data','provider_error','transport_error','parse_error')
      AND result ? 'raw_body' AND result ? 'request'
      AND jsonb_typeof(result->'request') IS NOT DISTINCT FROM 'object'
      AND (jsonb_typeof(result->'raw_body') IS NOT DISTINCT FROM 'string'
        OR (result->>'status'='transport_error' AND result->'raw_body'='null'::jsonb))
    )
  );

CREATE OR REPLACE FUNCTION public.read_test_price_forecast_context()
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton)
    THEN jsonb_build_object('known_at',clock_timestamp(),'datasets',(
      SELECT jsonb_object_agg(dataset,jsonb_build_object(
        'latest_attempt_id',(SELECT id FROM public.energy_market_forecast_observations o WHERE o.dataset=d.dataset ORDER BY sequence DESC LIMIT 1),
        'latest_data_id',(SELECT id FROM public.energy_market_forecast_observations o WHERE o.dataset=d.dataset AND o.result->>'status'='data' ORDER BY sequence DESC LIMIT 1)))
      FROM (VALUES('wind_day_ahead'),('load_day_ahead'),('load_week_ahead'),('weather_medium_range')) AS d(dataset)))
    ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION public.record_test_price_forecast_generation(p_generation jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE candidate public.energy_price_forecast_generations%ROWTYPE;
  existing public.energy_price_forecast_generations%ROWTYPE;
  dataset_name text; pointer text; observation_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN
    RAISE EXCEPTION 'TEST market archive is not enabled';
  END IF;
  IF jsonb_typeof(p_generation) IS DISTINCT FROM 'object' OR
    p_generation - ARRAY['id','home_id','generated_at','model_as_of','timezone','zone','algorithm','market_context','inputs','outlook'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Malformed price forecast generation';
  END IF;
  candidate := jsonb_populate_record(NULL::public.energy_price_forecast_generations,p_generation);
  IF jsonb_typeof(candidate.market_context->'datasets') IS DISTINCT FROM 'object' OR
    candidate.market_context->>'known_at' IS NULL THEN
    RAISE EXCEPTION 'Malformed market context';
  END IF;
  IF (candidate.market_context->'datasets') - ARRAY['wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Unknown market dataset context';
  END IF;
  -- Timestamp validity is not a source-age or forecast-admission gate.
  PERFORM (candidate.market_context->>'known_at')::timestamptz;
  FOREACH dataset_name IN ARRAY ARRAY['wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range'] LOOP
    IF jsonb_typeof(candidate.market_context->'datasets'->dataset_name) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Missing market dataset context: %',dataset_name;
    END IF;
    FOREACH pointer IN ARRAY ARRAY['latest_attempt_id','latest_data_id'] LOOP
      IF NOT (candidate.market_context->'datasets'->dataset_name ? pointer) THEN
        RAISE EXCEPTION 'Missing market observation pointer';
      END IF;
      observation_id := (candidate.market_context->'datasets'->dataset_name->>pointer)::uuid;
      IF observation_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM public.energy_market_forecast_observations o WHERE o.id=observation_id AND o.dataset=dataset_name
          AND (pointer<>'latest_data_id' OR o.result->>'status'='data')) THEN
        RAISE EXCEPTION 'Market observation pointer does not match dataset or outcome';
      END IF;
    END LOOP;
  END LOOP;
  INSERT INTO public.energy_price_forecast_generations(id,home_id,generated_at,model_as_of,timezone,zone,algorithm,market_context,inputs,outlook)
    VALUES(candidate.id,candidate.home_id,candidate.generated_at,candidate.model_as_of,candidate.timezone,candidate.zone,candidate.algorithm,candidate.market_context,candidate.inputs,candidate.outlook)
    ON CONFLICT(id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO STRICT existing FROM public.energy_price_forecast_generations WHERE id=candidate.id;
    IF (to_jsonb(existing)-'recorded_at') IS DISTINCT FROM (to_jsonb(candidate)-'recorded_at') THEN
      RAISE EXCEPTION 'Price forecast generation identity already has different evidence';
    END IF;
  END IF;
END; $$;
