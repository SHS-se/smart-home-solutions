CREATE INDEX energy_market_jao_border_flow_day ON public.energy_market_forecast_observations(requested_from,sequence DESC)
 WHERE dataset='jao_day_ahead_border_flows' AND result->>'status'='data';

CREATE TABLE private.test_se3_gross_flow_forecasts (
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
CREATE INDEX test_se3_gross_flow_forecasts_delivery ON private.test_se3_gross_flow_forecasts(delivery_day);
ALTER TABLE private.test_se3_gross_flow_forecasts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.test_se3_gross_flow_forecasts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.request_test_se3_border_flow_history(p_day date)
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
   body:=jsonb_build_object('borderFlowHistory',p_day),timeout_milliseconds:=180000);
END; $$;

-- The chart combines the two SE4 paths before classifying each of the five
-- bidding-zone borders. Work in SE3's sign convention (imports positive).
CREATE FUNCTION private.se3_gross_border_flows(p_values jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('imports_mw',sum(greatest(0,mw)), 'exports_mw',sum(least(0,mw)))
 FROM (VALUES
  (-(p_values->>'border_SE3_SE2')::numeric),
  (-(p_values->>'border_SE3_NO1')::numeric),
  (-(p_values->>'border_SE3_SE3FS')::numeric),
  (-(p_values->>'border_SE3_SE3KS')::numeric),
  (-(p_values->>'border_SE3_SE4')::numeric-(p_values->>'border_SE3_SE3SWL')::numeric)
 ) b(mw)
 HAVING count(mw)=5;
$$;

-- Both flow forecasts use the same issue clock, Stockholm quarter matching and
-- immutable vintage rule. They retain their own source observation IDs.
CREATE FUNCTION private.record_test_se3_four_week_flows(p_dataset text,p_origin date)
RETURNS integer LANGUAGE plpgsql SET search_path=public,private SET TimeZone='UTC' AS $$
DECLARE
 tz constant text:='Europe/Stockholm';
 issued_at timestamptz:=clock_timestamp();
 today date:=(issued_at AT TIME ZONE tz)::date;
 origin date:=coalesce(p_origin,today);
 historical boolean:=p_origin IS NOT NULL;
 gross boolean:=p_dataset='jao_day_ahead_border_flows';
 inserted integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'Enable the TEST archive first'; END IF;
 IF historical AND origin>=today THEN RAISE EXCEPTION 'Reconstruction requires a past issue date'; END IF;
 IF historical THEN issued_at:=(origin+time '15:00') AT TIME ZONE tz;
 ELSIF (issued_at AT TIME ZONE tz)::time<time '15:00' THEN RETURN 0;
 END IF;
 WITH targets AS (
  SELECT lead,origin+lead AS delivery FROM (VALUES(2),(3)) l(lead)
  WHERE CASE WHEN gross THEN origin+lead>=date '2026-10-22'
    AND NOT EXISTS(SELECT 1 FROM private.test_se3_gross_flow_forecasts f WHERE f.origin_day=origin AND f.lead_days=l.lead)
   ELSE NOT EXISTS(SELECT 1 FROM private.test_se3_net_import_forecasts f WHERE f.origin_day=origin AND f.lead_days=l.lead) END
 ), sources AS MATERIALIZED (
  SELECT t.lead,t.delivery,w.week,o.id,o.document
  FROM targets t CROSS JOIN generate_series(1,4) w(week)
  JOIN LATERAL (
   SELECT id,result->'document' AS document FROM public.energy_market_forecast_observations
   WHERE dataset=p_dataset AND result->>'status'='data'
     AND requested_from=(t.delivery-w.week*7)::timestamp AT TIME ZONE tz
     AND requested_to=(t.delivery-w.week*7+1)::timestamp AT TIME ZONE tz
     AND (historical OR recorded_at<=issued_at)
   ORDER BY sequence DESC LIMIT 1
  ) o ON true
 ), evidence AS (
  SELECT lead,array_agg(id ORDER BY week) AS ids FROM sources GROUP BY lead HAVING count(*)=4
 ), observations AS (
  SELECT s.lead,s.week,(r->>'start')::timestamptz AS start,
   CASE WHEN gross THEN private.se3_gross_border_flows(r->'values')
    WHEN jsonb_typeof(r->'values'->'hub_SE3')='number' THEN jsonb_build_object('net_mw',-(r->'values'->>'hub_SE3')::numeric)
   END AS flows
  FROM sources s JOIN evidence e USING(lead)
  CROSS JOIN LATERAL jsonb_array_elements(s.document->'records') r
  WHERE ((r->>'start')::timestamptz AT TIME ZONE tz)::date=s.delivery-s.week*7
    AND (NOT historical OR (r->>'provider_modified_at')::timestamptz<=issued_at)
 ), native_quarters AS (
  SELECT lead,week,start,
   CASE WHEN count(flows)=count(*) AND count(DISTINCT flows)=1 THEN min(flows::text)::jsonb END AS flows
  FROM observations GROUP BY lead,week,start
 ), weekly AS (
  SELECT lead,week,(start AT TIME ZONE tz)::time AS quarter,
   avg((flows->>'net_mw')::numeric) AS net_mw,
   avg((flows->>'imports_mw')::numeric) AS imports_mw,
   avg((flows->>'exports_mw')::numeric) AS exports_mw
  FROM native_quarters GROUP BY lead,week,(start AT TIME ZONE tz)::time HAVING count(flows)=count(*)
 ), profile AS (
  SELECT lead,quarter,avg(net_mw) AS net_mw,avg(imports_mw) AS imports_mw,avg(exports_mw) AS exports_mw
  FROM weekly GROUP BY lead,quarter HAVING count(*)=4
 ), forecast AS (
  SELECT t.lead,jsonb_object_agg((extract(epoch FROM q.start)::bigint)::text,
   CASE WHEN gross THEN jsonb_build_object('imports_mw',p.imports_mw,'exports_mw',p.exports_mw) ELSE to_jsonb(p.net_mw) END) AS quarters
  FROM targets t JOIN profile p USING(lead)
  JOIN LATERAL generate_series(t.delivery::timestamp AT TIME ZONE tz,
    (t.delivery+1)::timestamp AT TIME ZONE tz - interval '15 minutes',interval '15 minutes') q(start)
    ON (q.start AT TIME ZONE tz)::time=p.quarter
  GROUP BY t.lead
 ), net_saved AS (
  INSERT INTO private.test_se3_net_import_forecasts(origin_day,lead_days,as_of,reconstructed,source_ids,quarters)
  SELECT origin,f.lead,issued_at,historical,e.ids,f.quarters FROM forecast f JOIN evidence e USING(lead) WHERE NOT gross
  ON CONFLICT(origin_day,lead_days) DO NOTHING RETURNING 1
 ), gross_saved AS (
  INSERT INTO private.test_se3_gross_flow_forecasts(origin_day,lead_days,as_of,reconstructed,source_ids,quarters)
  SELECT origin,f.lead,issued_at,historical,e.ids,f.quarters FROM forecast f JOIN evidence e USING(lead) WHERE gross
  ON CONFLICT(origin_day,lead_days) DO NOTHING RETURNING 1
 )
 SELECT (SELECT count(*) FROM net_saved)+(SELECT count(*) FROM gross_saved) INTO inserted;
 RETURN inserted;
END; $$;

CREATE OR REPLACE FUNCTION private.record_test_se3_net_import_forecasts(p_origin date DEFAULT NULL)
RETURNS integer LANGUAGE sql SET search_path=public,private AS $$
 SELECT private.record_test_se3_four_week_flows('jao_day_ahead_net_position',p_origin);
$$;
CREATE FUNCTION private.record_test_se3_gross_flow_forecasts(p_origin date DEFAULT NULL)
RETURNS integer LANGUAGE sql SET search_path=public,private AS $$
 SELECT private.record_test_se3_four_week_flows('jao_day_ahead_border_flows',p_origin);
$$;

CREATE FUNCTION private.enable_test_se3_gross_flow_forecasts()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM private.test_market_archive_config WHERE singleton) THEN RAISE EXCEPTION 'Enable the TEST archive first'; END IF;
 PERFORM cron.schedule('test-energy-se3-gross-flow-forecast','32 * * * *','SELECT private.record_test_se3_gross_flow_forecasts()');
END; $$;
REVOKE ALL ON FUNCTION private.request_test_se3_border_flow_history(date),private.se3_gross_border_flows(jsonb),
 private.record_test_se3_four_week_flows(text,date),private.record_test_se3_gross_flow_forecasts(date),
 private.enable_test_se3_gross_flow_forecasts() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_test_se3_market_day(p_day date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH market_day AS MATERIALIZED (SELECT private.get_test_se3_market_day(p_day) AS quarters),
 forecasts AS MATERIALIZED (
  SELECT lead_days,reconstructed,quarters FROM private.test_se3_net_import_forecasts WHERE delivery_day=p_day
 ), gross_flows AS MATERIALIZED (
  SELECT lead_days,reconstructed,quarters FROM private.test_se3_gross_flow_forecasts WHERE delivery_day=p_day
 )
 SELECT coalesce(jsonb_agg(q.quarter || jsonb_build_object(
  'forecast_d2',d2.quarters->q.key,'forecast_d3',d3.quarters->q.key,
  'reconstructed_d2',d2.reconstructed,'reconstructed_d3',d3.reconstructed,
  'gross_forecast_d2',g2.quarters->q.key,'gross_forecast_d3',g3.quarters->q.key,
  'gross_reconstructed_d2',g2.reconstructed,'gross_reconstructed_d3',g3.reconstructed
 ) ORDER BY q.ordinality),'[]'::jsonb)
 FROM market_day m CROSS JOIN LATERAL jsonb_array_elements(m.quarters) WITH ORDINALITY v(quarter,ordinality)
 CROSS JOIN LATERAL (SELECT v.*, (extract(epoch FROM (v.quarter->>'start')::timestamptz)::bigint)::text AS key) q
 LEFT JOIN forecasts d2 ON d2.lead_days=2
 LEFT JOIN forecasts d3 ON d3.lead_days=3
 LEFT JOIN gross_flows g2 ON g2.lead_days=2
 LEFT JOIN gross_flows g3 ON g3.lead_days=3;
$$;
