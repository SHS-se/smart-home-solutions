-- Research is activated only by the TEST weather collector. Legacy runs retain their own evidence.
CREATE TABLE private.test_se3_generation_forecasts (
 source text NOT NULL CHECK(source IN ('ecmwf','gfs')),
 origin_day date NOT NULL,
 issued_at timestamptz NOT NULL,
 algorithm text NOT NULL CHECK(algorithm='se3-generation-regional-v1'),
 reconstructed boolean NOT NULL,
 weather_cycle timestamptz NOT NULL CHECK(weather_cycle<=issued_at),
 weather_collected_at timestamptz,
 actuals_id uuid NOT NULL REFERENCES public.energy_market_forecast_observations(id),
 weather jsonb NOT NULL,
 hours jsonb NOT NULL CHECK(jsonb_typeof(hours)='object' AND hours<>'{}'::jsonb),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(origin_day=(issued_at AT TIME ZONE 'Europe/Stockholm')::date),
 CHECK(reconstructed OR weather_collected_at<=issued_at AND weather_collected_at IS NOT NULL),
 PRIMARY KEY(source,origin_day)
);
ALTER TABLE private.test_se3_generation_forecasts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.test_se3_generation_forecasts FROM PUBLIC,anon,authenticated,service_role;

-- Keep the existing staff/TEST market history guard and flow projections.
ALTER FUNCTION public.get_test_se3_market_day(date) RENAME TO get_test_se3_market_day_with_flows;
ALTER FUNCTION public.get_test_se3_market_day_with_flows(date) SET SCHEMA private;
REVOKE ALL ON FUNCTION private.get_test_se3_market_day_with_flows(date) FROM authenticated;

CREATE FUNCTION public.get_test_se3_market_day(p_day date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH market_day AS MATERIALIZED (SELECT private.get_test_se3_market_day_with_flows(p_day) AS quarters),
 runs AS MATERIALIZED (
  SELECT source, p_day-origin_day AS lead, reconstructed, hours
  FROM private.test_se3_generation_forecasts WHERE origin_day IN (p_day-2,p_day-3)
 )
 SELECT coalesce(jsonb_agg(q.quarter || jsonb_build_object('generation_forecasts',f.value) ORDER BY q.ordinality),'[]'::jsonb)
 FROM market_day m CROSS JOIN LATERAL jsonb_array_elements(m.quarters) WITH ORDINALITY q(quarter,ordinality)
 CROSS JOIN LATERAL (
  SELECT jsonb_object_agg(r.source||'_d'||r.lead,jsonb_build_object('reconstructed',r.reconstructed,'mw',r.hours->k.hour)) AS value
  FROM runs r CROSS JOIN LATERAL (
   SELECT (floor(extract(epoch FROM (q.quarter->>'start')::timestamptz)/3600)::bigint*3600)::text AS hour
  ) k
 ) f;
$$;
REVOKE ALL ON FUNCTION public.get_test_se3_market_day(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_test_se3_market_day(date) TO authenticated;
