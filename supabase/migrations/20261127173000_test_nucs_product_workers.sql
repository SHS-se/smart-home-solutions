-- Each native NUCS product gets a fresh hosted CPU budget, retaining a common frozen intent.
CREATE FUNCTION public.request_test_nucs_product(p_batch_id uuid,p_request_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
 SELECT * INTO config FROM private.test_market_archive_config WHERE singleton AND
  function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
 IF NOT FOUND THEN RAISE EXCEPTION 'TEST archive is not configured'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.energy_market_collection_batches b CROSS JOIN LATERAL jsonb_array_elements(b.plan) r
   WHERE b.id=p_batch_id AND b.kind IN ('nucs_week_context','nucs_month_context') AND r->>'key'=p_request_key) THEN
  RAISE EXCEPTION 'NUCS product intent missing';
 END IF;
 PERFORM net.http_post(url:=config.function_url,
  headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
  body:=jsonb_build_object('nucsProduct',jsonb_build_object('batch_id',p_batch_id,'request_key',p_request_key)),timeout_milliseconds:=180000);
END; $$;
REVOKE ALL ON FUNCTION public.request_test_nucs_product(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_test_nucs_product(uuid,text) TO service_role;

CREATE FUNCTION public.read_test_nucs_product(p_batch_id uuid,p_request_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE batch public.energy_market_collection_batches%ROWTYPE; linked jsonb; dataset text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton AND
  function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive') THEN RAISE EXCEPTION 'TEST archive is not configured'; END IF;
 SELECT * INTO batch FROM public.energy_market_collection_batches WHERE id=p_batch_id AND kind IN ('nucs_week_context','nucs_month_context');
 SELECT r->>'dataset' INTO dataset FROM jsonb_array_elements(batch.plan) r WHERE r->>'key'=p_request_key;
 IF dataset IS NULL THEN RAISE EXCEPTION 'NUCS product intent missing'; END IF;
 IF dataset LIKE '%_domain' THEN
  -- Only publication identity is needed here; avoid loading raw XML and position arrays into the domain worker.
  SELECT jsonb_build_object('id',o.id,'evidence',jsonb_build_object('request',o.result->'request','status',o.result->>'status',
    'document',jsonb_build_object('horizon',o.result->'document'->'horizon','publications',
      coalesce((SELECT jsonb_agg(p-'positions') FROM jsonb_array_elements(o.result->'document'->'publications') p),'[]'::jsonb))))
  INTO linked FROM public.energy_market_forecast_observations o
  WHERE o.batch_id=p_batch_id AND o.dataset=replace(dataset,'_domain','_available');
 END IF;
 RETURN jsonb_build_object('batch',jsonb_build_object('id',batch.id,'kind',batch.kind,'requested_at',batch.requested_at,'plan',batch.plan),'available',linked);
END; $$;
REVOKE ALL ON FUNCTION public.read_test_nucs_product(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_test_nucs_product(uuid,text) TO service_role;
