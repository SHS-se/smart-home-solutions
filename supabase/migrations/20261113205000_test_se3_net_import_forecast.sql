ALTER TABLE public.energy_market_forecast_observations
 DROP CONSTRAINT energy_market_observation_product,
 ADD CONSTRAINT energy_market_observation_product CHECK(
  (zone='SE3' AND dataset IN ('wind_day_ahead','load_day_ahead','load_week_ahead','weather_medium_range','generation_actual',
   'sweden_hydrology','production_outages','generation_outages','installed_generation_units','load_actual','smhi_wind_10m_observed','smhi_temperature_2m_observed',
   'nucs_week_ahead_ntc','nucs_transmission_outages','spot_price','svk_physical_imports','svk_physical_exports')) OR
  (zone IN ('SE2','SE4','NO1','FI','DK1') AND dataset IN ('neighbour_load_day_ahead','neighbour_wind_day_ahead')) OR
  (zone='NORDIC_CCR' AND dataset IN ('jao_max_net_positions','jao_max_exchanges','jao_day_ahead_border_flows','jao_day_ahead_net_position')));

CREATE OR REPLACE FUNCTION public.market_collection_is_current(p_kind text,p_plan jsonb,p_requested_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE p_kind
   WHEN 'market_history' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan) r WHERE r->>'dataset'='spot_price')
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan) r WHERE r->>'dataset'='generation_actual')
   WHEN 'regional_context' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan) r WHERE (r->>'to')::timestamptz>p_requested_at)
   ELSE true END;
$$;

CREATE INDEX energy_market_jao_net_position_day ON public.energy_market_forecast_observations(requested_from,sequence DESC)
 WHERE dataset='jao_day_ahead_net_position' AND result->>'status'='data';

CREATE TABLE private.test_se3_net_import_forecasts (
 origin_day date NOT NULL,
 lead_days smallint NOT NULL CHECK(lead_days IN (2,3)),
 delivery_day date GENERATED ALWAYS AS (origin_day+lead_days::integer) STORED,
 as_of timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reconstructed boolean NOT NULL,
 source_ids uuid[] NOT NULL CHECK(cardinality(source_ids)=4),
 quarters jsonb NOT NULL CHECK(jsonb_typeof(quarters)='object' AND quarters<>'{}'::jsonb),
 PRIMARY KEY(origin_day,lead_days)
);
CREATE INDEX test_se3_net_import_forecasts_delivery ON private.test_se3_net_import_forecasts(delivery_day);
ALTER TABLE private.test_se3_net_import_forecasts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.test_se3_net_import_forecasts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.request_test_se3_net_position_history(p_day date)
RETURNS bigint LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE config private.test_market_archive_config%ROWTYPE;
BEGIN
 SELECT * INTO config FROM private.test_market_archive_config WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Enable the TEST archive first'; END IF;
 IF p_day IS NULL OR p_day >= (now() AT TIME ZONE 'Europe/Stockholm')::date THEN
   RAISE EXCEPTION 'Backfill requires a completed Stockholm day';
 END IF;
 RETURN net.http_post(url:=config.function_url,
   headers:=jsonb_build_object('Content-Type','application/json','x-energy-market-archive-token',config.token::text),
   body:=jsonb_build_object('netPositionHistory',p_day),timeout_milliseconds:=180000);
END; $$;

-- The backtest averaged the same Stockholm quarter from 7, 14, 21 and 28 days
-- before delivery. A repeated clock quarter contributes one mean for its week.
CREATE FUNCTION private.record_test_se3_net_import_forecasts(p_origin date DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SET search_path=public,private SET TimeZone='UTC' AS $$
DECLARE
 tz constant text:='Europe/Stockholm';
 issued_at timestamptz:=clock_timestamp();
 today date:=(issued_at AT TIME ZONE tz)::date;
 origin date:=coalesce(p_origin,today);
 historical boolean:=p_origin IS NOT NULL;
 inserted integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'Enable the TEST archive first'; END IF;
 IF historical AND origin>=today THEN RAISE EXCEPTION 'Reconstruction requires a past issue date'; END IF;
 IF historical THEN issued_at:=(origin+time '15:00') AT TIME ZONE tz;
 ELSIF (issued_at AT TIME ZONE tz)::time<time '15:00' THEN RETURN 0;
 END IF;
 WITH targets AS (
  SELECT lead,origin+lead AS delivery FROM (VALUES(2),(3)) l(lead)
  WHERE NOT EXISTS(SELECT 1 FROM private.test_se3_net_import_forecasts f WHERE f.origin_day=origin AND f.lead_days=l.lead)
 ), sources AS MATERIALIZED (
  SELECT t.lead,t.delivery,w.week,o.id,o.document
  FROM targets t CROSS JOIN generate_series(1,4) w(week)
  JOIN LATERAL (
   SELECT id,result->'document' AS document FROM public.energy_market_forecast_observations
   WHERE dataset='jao_day_ahead_net_position' AND result->>'status'='data'
     AND requested_from=(t.delivery-w.week*7)::timestamp AT TIME ZONE tz
     AND requested_to=(t.delivery-w.week*7+1)::timestamp AT TIME ZONE tz
     AND (historical OR recorded_at<=issued_at)
   ORDER BY sequence DESC LIMIT 1
  ) o ON true
 ), evidence AS (
  SELECT lead,array_agg(id ORDER BY week) AS ids FROM sources GROUP BY lead HAVING count(*)=4
 ), native_quarters AS (
  SELECT s.lead,s.week,(r->>'start')::timestamptz AS start,
   CASE WHEN count(DISTINCT r->'values'->'hub_SE3')=1
     AND count(*) FILTER(WHERE jsonb_typeof(r->'values'->'hub_SE3')='number')=count(*)
     THEN -min((r->'values'->>'hub_SE3')::numeric) END AS net_mw
  FROM sources s JOIN evidence e USING(lead)
  CROSS JOIN LATERAL jsonb_array_elements(s.document->'records') r
  WHERE ((r->>'start')::timestamptz AT TIME ZONE tz)::date=s.delivery-s.week*7
    AND (NOT historical OR (r->>'provider_modified_at')::timestamptz<=issued_at)
  GROUP BY s.lead,s.week,(r->>'start')::timestamptz
 ), weekly AS (
  SELECT lead,week,(start AT TIME ZONE tz)::time AS quarter,avg(net_mw) AS net_mw
  FROM native_quarters GROUP BY lead,week,(start AT TIME ZONE tz)::time HAVING count(net_mw)=count(*)
 ), profile AS (
  SELECT lead,quarter,avg(net_mw) AS net_mw FROM weekly GROUP BY lead,quarter HAVING count(*)=4
 ), forecast AS (
  SELECT t.lead,jsonb_object_agg((extract(epoch FROM q.start)::bigint)::text,p.net_mw) AS quarters
  FROM targets t JOIN profile p USING(lead)
  JOIN LATERAL generate_series(t.delivery::timestamp AT TIME ZONE tz,
    (t.delivery+1)::timestamp AT TIME ZONE tz - interval '15 minutes',interval '15 minutes') q(start)
    ON (q.start AT TIME ZONE tz)::time=p.quarter
  GROUP BY t.lead
 )
 INSERT INTO private.test_se3_net_import_forecasts(origin_day,lead_days,as_of,reconstructed,source_ids,quarters)
 SELECT origin,f.lead,issued_at,historical,e.ids,f.quarters FROM forecast f JOIN evidence e USING(lead)
 ON CONFLICT(origin_day,lead_days) DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 RETURN inserted;
END; $$;

CREATE FUNCTION private.enable_test_se3_net_import_forecasts()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'Enable the TEST archive first'; END IF;
 PERFORM cron.schedule('test-energy-se3-net-import-forecast','29 * * * *','SELECT private.record_test_se3_net_import_forecasts()');
END; $$;
REVOKE ALL ON FUNCTION private.request_test_se3_net_position_history(date),private.record_test_se3_net_import_forecasts(date),
 private.enable_test_se3_net_import_forecasts() FROM PUBLIC,anon,authenticated,service_role;

-- Keep one implementation of the existing staff market day projection.
ALTER FUNCTION public.get_test_se3_market_day(date) SET SCHEMA private;
REVOKE ALL ON FUNCTION private.get_test_se3_market_day(date) FROM authenticated;
CREATE FUNCTION public.get_test_se3_market_day(p_day date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH market_day AS MATERIALIZED (SELECT private.get_test_se3_market_day(p_day) AS quarters),
 forecasts AS MATERIALIZED (
  SELECT lead_days,reconstructed,quarters FROM private.test_se3_net_import_forecasts WHERE delivery_day=p_day
 )
 SELECT coalesce(jsonb_agg(q.quarter || jsonb_build_object(
  'forecast_d2',d2.quarters->q.key,'forecast_d3',d3.quarters->q.key,
  'reconstructed_d2',d2.reconstructed,'reconstructed_d3',d3.reconstructed
 ) ORDER BY q.ordinality),'[]'::jsonb)
 FROM market_day m CROSS JOIN LATERAL jsonb_array_elements(m.quarters) WITH ORDINALITY v(quarter,ordinality)
 CROSS JOIN LATERAL (SELECT v.*, (extract(epoch FROM (v.quarter->>'start')::timestamptz)::bigint)::text AS key) q
 LEFT JOIN forecasts d2 ON d2.lead_days=2
 LEFT JOIN forecasts d3 ON d3.lead_days=3;
$$;
REVOKE ALL ON FUNCTION public.get_test_se3_market_day(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_test_se3_market_day(date) TO authenticated;
