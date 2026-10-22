-- Research is inert until explicitly enabled in TEST. No price-policy changes.
CREATE TABLE public.energy_market_forecast_observations (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  dataset text NOT NULL CHECK(dataset IN ('wind_day_ahead','load_day_ahead','load_week_ahead')),
  zone text NOT NULL CHECK(zone='SE3'),
  requested_from timestamptz NOT NULL,
  requested_to timestamptz NOT NULL CHECK(requested_to>requested_from),
  requested_at timestamptz NOT NULL,
  resolved_at timestamptz NOT NULL,
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND result ? 'status' AND result->>'status' IN ('data','no_data','provider_error','transport_error','parse_error')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX energy_market_forecast_observations_latest
  ON public.energy_market_forecast_observations(dataset,sequence DESC);
ALTER TABLE public.energy_market_forecast_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_market_forecast_observations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.energy_market_forecast_observations TO service_role;
REVOKE ALL ON SEQUENCE public.energy_market_forecast_observations_sequence_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SEQUENCE public.energy_market_forecast_observations_sequence_seq TO service_role;

CREATE TABLE public.energy_price_forecast_generations (
  id uuid PRIMARY KEY,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  generated_at timestamptz NOT NULL,
  model_as_of timestamptz NOT NULL,
  timezone text NOT NULL,
  zone text NOT NULL CHECK(zone='SE3'),
  algorithm text NOT NULL,
  market_context jsonb NOT NULL CHECK(jsonb_typeof(market_context)='object'),
  inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object'),
  outlook jsonb NOT NULL CHECK(jsonb_typeof(outlook)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX energy_price_forecast_generations_home
  ON public.energy_price_forecast_generations(home_id,generated_at);
ALTER TABLE public.energy_price_forecast_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_price_forecast_generations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.energy_price_forecast_generations TO service_role;

CREATE TABLE private.test_market_archive_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  token uuid NOT NULL,
  function_url text NOT NULL CHECK(function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive')
);
ALTER TABLE private.test_market_archive_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.test_market_archive_config FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.verify_test_market_archive_token(p_token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton AND token::text=p_token);
$$;

-- This snapshot pins committed observations before the price calculation. Provider
-- issue dates are provenance, never substitutes for local observation order.
CREATE FUNCTION public.read_test_price_forecast_context()
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton)
    THEN jsonb_build_object('known_at',clock_timestamp(),'datasets',(
      SELECT jsonb_object_agg(dataset,jsonb_build_object(
        'latest_attempt_id',(SELECT id FROM public.energy_market_forecast_observations o WHERE o.dataset=d.dataset ORDER BY sequence DESC LIMIT 1),
        'latest_data_id',(SELECT id FROM public.energy_market_forecast_observations o WHERE o.dataset=d.dataset AND o.result->>'status'='data' ORDER BY sequence DESC LIMIT 1)))
      FROM (VALUES('wind_day_ahead'),('load_day_ahead'),('load_week_ahead')) AS d(dataset)))
    ELSE NULL END;
$$;

CREATE FUNCTION public.record_test_price_forecast_generation(p_generation jsonb)
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
  -- Validate the timestamp without applying a source-age or forecast-admission gate.
  PERFORM (candidate.market_context->>'known_at')::timestamptz;
  FOREACH dataset_name IN ARRAY ARRAY['wind_day_ahead','load_day_ahead','load_week_ahead'] LOOP
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

CREATE FUNCTION private.request_test_market_archive()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
  SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM net.http_post(url:=config.function_url,
    headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
    body:='{}'::jsonb,timeout_milliseconds:=180000);
END; $$;

CREATE FUNCTION private.enable_test_market_archive()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
  INSERT INTO private.test_market_archive_config(singleton,token,function_url)
    VALUES(true,gen_random_uuid(),'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive')
    ON CONFLICT(singleton) DO NOTHING;
  PERFORM cron.schedule('test-energy-market-forecast-archive','7 * * * *','SELECT private.request_test_market_archive()');
END; $$;

REVOKE ALL ON FUNCTION public.verify_test_market_archive_token(text),public.read_test_price_forecast_context(),
  public.record_test_price_forecast_generation(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.verify_test_market_archive_token(text),public.read_test_price_forecast_context(),
  public.record_test_price_forecast_generation(jsonb) TO service_role;
REVOKE ALL ON FUNCTION private.request_test_market_archive(),private.enable_test_market_archive() FROM PUBLIC,anon,authenticated,service_role;
