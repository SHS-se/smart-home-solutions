-- Public market evidence in the TEST archive. Schema installation starts no jobs.
ALTER TABLE public.energy_market_collection_batches DROP CONSTRAINT energy_market_collection_batches_kind_check,
 ADD CONSTRAINT energy_market_collection_batches_kind_check CHECK(kind IN ('day_ahead','generation','market_context','weather_truth','regional_context','market_history'));
ALTER TABLE public.energy_market_forecast_observations DROP CONSTRAINT energy_market_observation_product,
 ADD CONSTRAINT energy_market_observation_product CHECK(
  (zone='SE3' AND dataset IN ('wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual',
   'sweden_hydrology','production_outages','generation_outages','installed_generation_units','load_actual','smhi_wind_10m_observed','smhi_temperature_2m_observed',
   'nucs_week_ahead_ntc','nucs_transmission_outages','spot_price','svk_physical_imports','svk_physical_exports')) OR
  (zone IN ('SE2','SE4','NO1','FI','DK1') AND dataset IN ('neighbour_load_day_ahead','neighbour_wind_day_ahead')) OR
  (zone='NORDIC_CCR' AND dataset IN ('jao_max_net_positions','jao_max_exchanges','jao_day_ahead_border_flows')));

CREATE OR REPLACE FUNCTION public.market_collection_is_current(p_kind text,p_plan jsonb,p_requested_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE p_kind
   WHEN 'market_history' THEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan) r WHERE r->>'dataset'='generation_actual')
   WHEN 'regional_context' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan) r WHERE (r->>'to')::timestamptz>p_requested_at)
   ELSE true END;
$$;

CREATE FUNCTION private.request_test_market_history(p_day date DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
 SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
 IF NOT FOUND OR config.function_url <> 'https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive' THEN
   RAISE EXCEPTION 'Enable the TEST archive first';
 END IF;
 IF p_day IS NOT NULL AND p_day >= (now() AT TIME ZONE 'Europe/Stockholm')::date THEN
   RAISE EXCEPTION 'Backfill requires a completed Stockholm day';
 END IF;
 RETURN net.http_post(url:=config.function_url,
   headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
   body:=jsonb_build_object('history',CASE WHEN p_day IS NULL THEN 'true'::jsonb ELSE to_jsonb(p_day) END),timeout_milliseconds:=180000);
END; $$;
CREATE FUNCTION private.enable_test_market_history()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton AND
    function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive') THEN
   RAISE EXCEPTION 'Enable the TEST archive first';
 END IF;
 PERFORM cron.schedule('test-energy-market-history','17 */6 * * *','SELECT private.request_test_market_history()');
END; $$;
REVOKE ALL ON FUNCTION private.request_test_market_history(date),private.enable_test_market_history() FROM PUBLIC,anon,authenticated,service_role;

CREATE INDEX energy_market_history_product_window ON public.energy_market_forecast_observations(dataset,requested_from,requested_to,sequence DESC)
 WHERE result->>'status'='data' AND dataset IN ('generation_actual','spot_price','svk_physical_imports','svk_physical_exports','jao_day_ahead_border_flows');

CREATE FUNCTION public.get_test_se3_market_day(p_day date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE day_start timestamptz; day_end timestamptz;
BEGIN
 IF NOT coalesce(public.is_staff(auth.uid()),false) THEN RAISE EXCEPTION 'Market history is staff-only' USING ERRCODE='42501'; END IF;
 IF p_day IS NULL OR NOT isfinite(p_day) THEN RAISE EXCEPTION 'Expected a Stockholm delivery day' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton AND
    function_url='https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive') THEN RETURN '[]'::jsonb; END IF;
 day_start:=p_day::timestamp AT TIME ZONE 'Europe/Stockholm';
 day_end:=(p_day+1)::timestamp AT TIME ZONE 'Europe/Stockholm';
 RETURN (
  WITH quarters AS MATERIALIZED (
   SELECT start, extract(epoch FROM start)*1000 AS start_ms
   FROM generate_series(day_start,day_end-interval '15 minutes',interval '15 minutes') start
  ), docs AS MATERIALIZED (
   SELECT id,dataset,sequence,requested_from,requested_to
   FROM public.energy_market_forecast_observations
   WHERE dataset IN ('generation_actual','spot_price','svk_physical_imports','svk_physical_exports','jao_day_ahead_border_flows')
     AND result->>'status'='data' AND requested_from<day_end AND requested_to>day_start
  ), picked AS MATERIALIZED (
   SELECT DISTINCT ON (q.start,d.dataset) q.start,q.start_ms,d.dataset,d.id
   FROM quarters q JOIN docs d ON d.requested_from<=q.start AND d.requested_to>=q.start+interval '15 minutes'
   ORDER BY q.start,d.dataset,d.sequence DESC
  ), latest AS MATERIALIZED (
   SELECT d.id,d.dataset,d.result->'document' AS doc FROM public.energy_market_forecast_observations d
   JOIN (SELECT DISTINCT id FROM picked) p USING(id)
  ), intervals AS MATERIALIZED (
   SELECT d.id, (v->>'startMs')::bigint AS start_ms, (v->>'endMs')::bigint AS end_ms,
     v->>'psrType' AS psr,(v->>'value')::numeric AS value
   FROM latest d CROSS JOIN LATERAL jsonb_array_elements(d.doc->'intervals') v
   WHERE d.dataset IN ('generation_actual','spot_price') AND v->>'resolution'='PT15M' AND (
     (d.dataset='generation_actual' AND v->>'flow'='production' AND v->>'unit'='MAW' AND v->>'psrType' IS NOT NULL) OR
     (d.dataset='spot_price' AND v->>'currency'='EUR' AND v->>'unit'='MWH'))
     AND (v->>'startMs')::bigint<extract(epoch FROM day_end)*1000 AND (v->>'endMs')::bigint>extract(epoch FROM day_start)*1000
  ), values_by_type AS (
   SELECT p.start,p.dataset,i.psr,CASE WHEN count(DISTINCT i.value)=1 THEN min(i.value) END AS value
   FROM picked p JOIN intervals i ON i.id=p.id AND i.start_ms<=p.start_ms AND i.end_ms>=p.start_ms+900000
   GROUP BY p.start,p.dataset,i.psr
  ), prices AS (
   SELECT start,value FROM values_by_type WHERE dataset='spot_price' AND psr IS NULL
  ), mix AS (
   SELECT start,jsonb_object_agg(psr,value) AS generation FROM values_by_type WHERE dataset='generation_actual' GROUP BY start
  ), flow_records AS MATERIALIZED (
   SELECT d.id,(v->>'start')::timestamptz AS start,v->'values' AS values
   FROM latest d CROSS JOIN LATERAL jsonb_array_elements(d.doc->'records') v
   WHERE d.dataset IN ('svk_physical_imports','svk_physical_exports','jao_day_ahead_border_flows') AND d.doc->>'unit'='MW'
  ), flow_cells AS (
   SELECT p.start,p.dataset,v.key,CASE WHEN count(DISTINCT v.value)=1 THEN min((v.value #>> '{}')::numeric) END AS value
   FROM picked p JOIN flow_records f ON f.id=p.id AND f.start=p.start
   CROSS JOIN LATERAL jsonb_each(f.values) v
   WHERE jsonb_typeof(v.value) IN ('number','null')
   GROUP BY p.start,p.dataset,v.key
  ), measured AS (
   SELECT start,jsonb_object_agg(key,value) AS flows FROM (
     SELECT start,key,CASE WHEN count(DISTINCT value)=1 AND count(value)=count(*) THEN min(value) END AS value
     FROM flow_cells WHERE dataset IN ('svk_physical_imports','svk_physical_exports') GROUP BY start,key
   ) cells GROUP BY start
  ), scheduled AS (
   SELECT start,jsonb_build_object('SE2',-max(value) FILTER(WHERE key='border_SE3_SE2'),
     'NO1',-max(value) FILTER(WHERE key='border_SE3_NO1'),
     'FI',-max(value) FILTER(WHERE key='border_SE3_SE3FS'),
     'DK1',-max(value) FILTER(WHERE key='border_SE3_SE3KS'),
     'SE4',-max(value) FILTER(WHERE key='border_SE3_SE4')-max(value) FILTER(WHERE key='border_SE3_SE3SWL')) AS flows
   FROM flow_cells WHERE dataset='jao_day_ahead_border_flows' GROUP BY start
  )
  SELECT jsonb_agg(jsonb_build_object('start',q.start,'spot',p.value,'generation',m.generation,
    'measured',a.flows,'scheduled',s.flows) ORDER BY q.start)
  FROM quarters q LEFT JOIN prices p USING(start) LEFT JOIN mix m USING(start)
  LEFT JOIN measured a USING(start) LEFT JOIN scheduled s USING(start)
 );
END; $$;
REVOKE ALL ON FUNCTION public.get_test_se3_market_day(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_test_se3_market_day(date) TO authenticated;
