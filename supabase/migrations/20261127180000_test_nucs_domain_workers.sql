-- Separate domain horizons so concurrent large downloads cannot exhaust one isolate.
CREATE OR REPLACE FUNCTION public.request_test_nucs_product(p_batch_id uuid,p_request_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE; target_dataset text; target_url text;
BEGIN
 SELECT * INTO config FROM private.test_market_archive_config WHERE singleton AND
  function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive';
 IF NOT FOUND THEN RAISE EXCEPTION 'TEST archive is not configured'; END IF;
 SELECT r->>'dataset' INTO target_dataset FROM public.energy_market_collection_batches b CROSS JOIN LATERAL jsonb_array_elements(b.plan) r
   WHERE b.id=p_batch_id AND b.kind IN ('nucs_week_context','nucs_month_context') AND r->>'key'=p_request_key;
 IF target_dataset IS NULL THEN RAISE EXCEPTION 'NUCS product intent missing'; END IF;
 target_url:=CASE target_dataset WHEN 'nucs_week_ahead_domain' THEN replace(config.function_url,'energy-market-archive','energy-market-nucs-week')
   WHEN 'nucs_month_ahead_domain' THEN replace(config.function_url,'energy-market-archive','energy-market-nucs-month') ELSE config.function_url END;
 PERFORM net.http_post(url:=target_url,
  headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
  body:=jsonb_build_object('nucsProduct',jsonb_build_object('batch_id',p_batch_id,'request_key',p_request_key)),timeout_milliseconds:=180000);
END; $$;
REVOKE ALL ON FUNCTION public.request_test_nucs_product(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_test_nucs_product(uuid,text) TO service_role;
