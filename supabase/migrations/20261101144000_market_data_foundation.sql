-- Append-only acquisition intent and quality projections. Installation alone enables no collection.
CREATE TABLE public.energy_market_collection_batches (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('day_ahead','generation','market_context')),
  requested_at timestamptz NOT NULL,
  plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='array' AND jsonb_array_length(plan)>0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.energy_market_collection_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_market_collection_batches FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.energy_market_collection_batches TO service_role;

ALTER TABLE public.energy_market_forecast_observations
  DROP CONSTRAINT energy_market_forecast_observations_dataset_check,
  DROP CONSTRAINT energy_market_forecast_observations_zone_check,
  ADD COLUMN batch_id uuid REFERENCES public.energy_market_collection_batches(id),
  ADD COLUMN request_key text,
  ADD CONSTRAINT energy_market_observation_product CHECK(
    (zone='SE3' AND dataset IN ('wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range',
      'generation_actual','sweden_hydrology','production_outages','generation_outages','installed_generation_units','load_actual')) OR
    (zone IN ('SE2','SE4','NO1','FI','DK1') AND dataset IN ('neighbour_load_day_ahead','neighbour_wind_day_ahead')) OR
    (zone='NORDIC_CCR' AND dataset IN ('jao_max_net_positions','jao_max_exchanges'))),
  -- Historical batches are unknown. Enforce intent on new writes without fabricating old identities.
  ADD CONSTRAINT energy_market_observation_batch_required CHECK(batch_id IS NOT NULL AND request_key IS NOT NULL) NOT VALID,
  ADD CONSTRAINT energy_market_observation_batch_request UNIQUE(batch_id,request_key);
CREATE INDEX energy_market_observation_product_latest ON public.energy_market_forecast_observations(dataset,zone,sequence DESC);
REVOKE INSERT ON public.energy_market_forecast_observations FROM service_role;

CREATE TABLE public.energy_market_observation_assessments (
  observation_id uuid NOT NULL REFERENCES public.energy_market_forecast_observations(id),
  assessor_version text NOT NULL CHECK(assessor_version='market-quality-v1'),
  status text NOT NULL CHECK(status IN ('data','no_data','provider_error','transport_error','parse_error')),
  http_status integer,
  error_code text,
  body_sha256 text,
  facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(observation_id,assessor_version)
);
ALTER TABLE public.energy_market_observation_assessments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_market_observation_assessments FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.energy_market_observation_assessments TO service_role;

CREATE FUNCTION public.assess_test_market_observation(p_id uuid,p_assessment jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE source public.energy_market_forecast_observations%ROWTYPE;
  candidate public.energy_market_observation_assessments%ROWTYPE;
  existing public.energy_market_observation_assessments%ROWTYPE;
BEGIN
  SELECT * INTO STRICT source FROM public.energy_market_forecast_observations WHERE id=p_id;
  IF jsonb_typeof(p_assessment) IS DISTINCT FROM 'object' OR
    p_assessment - ARRAY['assessor_version','status','http_status','error_code','body_sha256','facts'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Malformed market assessment';
  END IF;
  candidate:=jsonb_populate_record(NULL::public.energy_market_observation_assessments,p_assessment);
  candidate.observation_id:=p_id;
  IF candidate.status IS DISTINCT FROM source.result->>'status' OR
    candidate.http_status IS DISTINCT FROM (source.result->>'http_status')::integer OR
    candidate.error_code IS DISTINCT FROM source.result->>'error_code' OR
    candidate.body_sha256 IS DISTINCT FROM source.result->>'body_sha256' THEN
    RAISE EXCEPTION 'Assessment does not match retained evidence';
  END IF;
  INSERT INTO public.energy_market_observation_assessments(observation_id,assessor_version,status,http_status,error_code,body_sha256,facts)
    VALUES(p_id,candidate.assessor_version,candidate.status,candidate.http_status,candidate.error_code,candidate.body_sha256,candidate.facts)
    ON CONFLICT(observation_id,assessor_version) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO STRICT existing FROM public.energy_market_observation_assessments
      WHERE observation_id=p_id AND assessor_version=candidate.assessor_version;
    IF to_jsonb(existing)-'recorded_at' IS DISTINCT FROM to_jsonb(candidate)-'recorded_at' THEN
      RAISE EXCEPTION 'Assessment identity already has different evidence';
    END IF;
  END IF;
END; $$;

CREATE FUNCTION public.record_test_market_observation(p_observation jsonb,p_assessment jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE candidate public.energy_market_forecast_observations%ROWTYPE;
  existing public.energy_market_forecast_observations%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton AND
    function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive') THEN
    RAISE EXCEPTION 'TEST archive is not enabled';
  END IF;
  IF jsonb_typeof(p_observation) IS DISTINCT FROM 'object' OR
    p_observation - ARRAY['id','batch_id','request_key','dataset','zone','requested_from','requested_to','requested_at','resolved_at','result'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Malformed market observation';
  END IF;
  candidate:=jsonb_populate_record(NULL::public.energy_market_forecast_observations,p_observation);
  IF NOT EXISTS(SELECT 1 FROM public.energy_market_collection_batches b CROSS JOIN LATERAL jsonb_array_elements(b.plan) r
    WHERE b.id=candidate.batch_id AND r->>'key'=candidate.request_key AND r->>'dataset'=candidate.dataset AND r->>'zone'=candidate.zone
      AND (r->>'from')::timestamptz=candidate.requested_from AND (r->>'to')::timestamptz=candidate.requested_to) THEN
    RAISE EXCEPTION 'Observation does not match expected batch request';
  END IF;
  INSERT INTO public.energy_market_forecast_observations(id,batch_id,request_key,dataset,zone,requested_from,requested_to,requested_at,resolved_at,result)
    VALUES(candidate.id,candidate.batch_id,candidate.request_key,candidate.dataset,candidate.zone,candidate.requested_from,candidate.requested_to,
      candidate.requested_at,candidate.resolved_at,candidate.result) ON CONFLICT(id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO STRICT existing FROM public.energy_market_forecast_observations WHERE id=candidate.id;
    IF to_jsonb(existing)-ARRAY['recorded_at','sequence'] IS DISTINCT FROM to_jsonb(candidate)-ARRAY['recorded_at','sequence'] THEN
      RAISE EXCEPTION 'Observation identity already has different evidence';
    END IF;
  END IF;
  PERFORM public.assess_test_market_observation(candidate.id,p_assessment);
END; $$;

CREATE VIEW public.energy_market_observation_index WITH(security_invoker=true) AS
 SELECT o.id,o.sequence,o.dataset,o.zone,o.batch_id,o.request_key,o.requested_from,o.requested_to,o.requested_at,o.resolved_at,o.recorded_at,
   o.result->>'status' status,a.assessor_version,a.http_status,a.error_code,a.body_sha256,a.facts
 FROM public.energy_market_forecast_observations o LEFT JOIN public.energy_market_observation_assessments a
 ON a.observation_id=o.id AND a.assessor_version='market-quality-v1';
REVOKE ALL ON public.energy_market_observation_index FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.energy_market_observation_index TO service_role;

-- One SQL snapshot freezes explicit membership, even if transactions commit out of sequence.
CREATE FUNCTION public.read_test_market_snapshot()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 SELECT jsonb_build_object('at',statement_timestamp(),'assessor_version','market-quality-v1',
   'observation_ids',coalesce((SELECT jsonb_agg(id ORDER BY sequence) FROM public.energy_market_forecast_observations),'[]'::jsonb),
   'assessed_ids',coalesce((SELECT jsonb_agg(observation_id ORDER BY observation_id) FROM public.energy_market_observation_assessments WHERE assessor_version='market-quality-v1'),'[]'::jsonb),
   'batches',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY recorded_at,id) FROM public.energy_market_collection_batches b),'[]'::jsonb));
$$;
CREATE FUNCTION public.read_test_market_documents(p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  IF cardinality(p_ids) IS NULL OR cardinality(p_ids)>8 THEN RAISE EXCEPTION 'Read at most eight parsed observations'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(o)-'result'||jsonb_build_object('result',
    (o.result-ARRAY['raw_xml','raw_body','raw_base64']) #- '{document,reports}') ORDER BY sequence)
    FROM public.energy_market_forecast_observations o WHERE id=ANY(p_ids)),'[]'::jsonb);
END; $$;
REVOKE ALL ON FUNCTION public.record_test_market_observation(jsonb,jsonb),public.assess_test_market_observation(uuid,jsonb),
 public.read_test_market_snapshot(),public.read_test_market_documents(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_test_market_observation(jsonb,jsonb),public.assess_test_market_observation(uuid,jsonb),
 public.read_test_market_snapshot(),public.read_test_market_documents(uuid[]) TO service_role;

CREATE FUNCTION private.request_test_market_context()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
  SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM net.http_post(url:=config.function_url,
    headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
    body:='{"context":true}'::jsonb,timeout_milliseconds:=180000);
END; $$;
CREATE FUNCTION private.enable_test_market_context()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'Enable the TEST archive first'; END IF;
  PERFORM cron.schedule('test-energy-market-context','27 */6 * * *','SELECT private.request_test_market_context()');
END; $$;
REVOKE ALL ON FUNCTION private.request_test_market_context(),private.enable_test_market_context() FROM PUBLIC,anon,authenticated,service_role;

-- Pin new research batches alongside existing SE3 pointers without changing their contracts.
CREATE OR REPLACE FUNCTION public.read_test_price_forecast_context()
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton)
    THEN jsonb_build_object('known_at',clock_timestamp(),'generation_mix_run_id',(
      SELECT id FROM public.energy_generation_forecast_runs ORDER BY recorded_at DESC,id DESC LIMIT 1),
    'research_batches',(
      SELECT jsonb_object_agg(kind,jsonb_build_object('batch_id',id,'observation_ids',
        (SELECT coalesce(jsonb_agg(o.id ORDER BY o.sequence),'[]'::jsonb) FROM public.energy_market_forecast_observations o WHERE o.batch_id=b.id)))
      FROM (SELECT DISTINCT ON(kind) kind,id FROM public.energy_market_collection_batches ORDER BY kind,recorded_at DESC,id DESC) b),
    'datasets',(
      SELECT jsonb_object_agg(dataset,jsonb_build_object(
        'latest_attempt_id',(SELECT id FROM public.energy_market_forecast_observations o WHERE o.dataset=d.dataset AND o.zone='SE3' ORDER BY sequence DESC LIMIT 1),
        'latest_data_id',(SELECT id FROM public.energy_market_forecast_observations o WHERE o.dataset=d.dataset AND o.zone='SE3' AND o.result->>'status'='data' ORDER BY sequence DESC LIMIT 1)))
      FROM (VALUES('wind_day_ahead'),('load_day_ahead'),('load_week_ahead'),('weather_medium_range')) AS d(dataset)))
    ELSE NULL END;
$$;
