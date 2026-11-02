-- Reporting-only query optimization; preserve the evidence and scoring contract.
-- Keep timestamp parsing materialized and defer JavaScript room-key ordering
-- until after selection instead of sorting every room object in every replan.
CREATE OR REPLACE FUNCTION public.read_energy_accuracy_evidence(p_home_id uuid,p_scheduled_at timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private SET timezone='UTC' AS $$
WITH bounds AS (
  SELECT floor(extract(epoch FROM p_scheduled_at)*1000)::bigint AS until_ms,
    floor(extract(epoch FROM p_scheduled_at-interval '7 days')*1000)::bigint AS from_ms
), archive AS MATERIALIZED (
  SELECT plan_id,published_at,forecast,
    floor(extract(epoch FROM published_at)*1000)::bigint AS published_ms,
    row_number() OVER (ORDER BY floor(extract(epoch FROM published_at)*1000),plan_id::text COLLATE "C") AS seq
  FROM public.energy_forecast_records
  WHERE home_id=p_home_id AND horizon_end>=p_scheduled_at-interval '7 days' AND published_at<=p_scheduled_at
), slot_times AS MATERIALIZED (
  -- Parse each timestamp once. Inlining a lateral expression repeats this
  -- exception-safe conversion in every eligibility check and projection.
  SELECT a.seq,q.n,private.energy_accuracy_ms(q.slot->>'start') AS at,
    private.energy_accuracy_number(q.slot->'duration_hours') AS duration,
    private.energy_accuracy_number(q.slot->'estimated_import_sek_per_kwh') AS estimate,
    q.slot->'room_temperature_c' AS rooms
  FROM archive a
  CROSS JOIN LATERAL jsonb_array_elements(a.forecast->'slots') WITH ORDINALITY AS q(slot,n)
), slot_index AS MATERIALIZED (
  SELECT s.*,
    s.at+900000<=b.until_ms AND s.at>=a.published_ms AND s.duration=.25 AS eligible
  FROM slot_times s JOIN archive a USING(seq) CROSS JOIN bounds b
  WHERE s.at>=b.from_ms
), energy_rank AS (
  SELECT seq,n,at,row_number() OVER (PARTITION BY at ORDER BY seq DESC,n DESC) AS rank,
    min(ARRAY[seq,n]) OVER (PARTITION BY at) AS first_seen
  FROM slot_index WHERE eligible
), energy AS (
  SELECT e.at,e.first_seen,jsonb_build_object('at',e.at,'plan_id',a.plan_id,'published_at',a.published_ms,
    'model_version',a.forecast->'model_version','keys',private.energy_accuracy_keys(a.forecast),
    'slot',a.forecast->'slots'->(e.n::int-1)) AS value
  FROM energy_rank e JOIN archive a USING(seq) WHERE e.rank=1
), room_values AS MATERIALIZED (
  SELECT s.seq,s.n,s.at+900000 AS at,r.key,
    private.energy_accuracy_number(r.value) AS value,r.ord
  FROM slot_index s CROSS JOIN LATERAL
    jsonb_each(CASE WHEN jsonb_typeof(s.rooms)='object' THEN s.rooms ELSE '{}'::jsonb END)
      WITH ORDINALITY AS r(key,value,ord)
  WHERE s.eligible
), room_rank AS (
  SELECT *,row_number() OVER(PARTITION BY at,key ORDER BY seq DESC,n DESC) AS rank,
    min(ARRAY[seq,n,ord]) OVER(PARTITION BY at,key) AS first_seen
  FROM room_values WHERE value IS NOT NULL
), estimates AS (
  SELECT *,row_number() OVER(PARTITION BY at ORDER BY seq DESC,n DESC) AS rank
  FROM slot_index WHERE estimate IS NOT NULL
), names AS (
  SELECT 'baseline'::text AS key,'Baseline'::text AS name,ARRAY[0::bigint,0::bigint] AS pos
  UNION ALL SELECT 'solar','Solar',ARRAY[0::bigint,1::bigint]
  UNION ALL SELECT 'battery','House battery',ARRAY[0::bigint,2::bigint]
  UNION ALL SELECT 'device:'||(d->>'key'),d->>'name',ARRAY[a.seq,n]
    FROM archive a CROSS JOIN LATERAL jsonb_array_elements(a.forecast->'devices') WITH ORDINALITY x(d,n)
), named AS (
  SELECT *,row_number() OVER(PARTITION BY key ORDER BY pos DESC) AS rank,
    min(pos) OVER(PARTITION BY key) AS first_seen FROM names
), room_names AS (
  SELECT r->>'key' AS key,r->>'name' AS name,ARRAY[a.seq,n] AS pos
  FROM archive a CROSS JOIN LATERAL jsonb_array_elements(a.forecast->'rooms') WITH ORDINALITY x(r,n)
), named_rooms AS (
  SELECT *,row_number() OVER(PARTITION BY key ORDER BY pos DESC) AS rank,
    min(pos) OVER(PARTITION BY key) AS first_seen FROM room_names
), latest AS (SELECT forecast FROM archive ORDER BY seq DESC LIMIT 1)
SELECT jsonb_build_object(
  'energy',coalesce((SELECT jsonb_agg(value ORDER BY first_seen) FROM energy),'[]'::jsonb),
  'rooms',coalesce((SELECT jsonb_agg(jsonb_build_object('at',r.at,'key',r.key,'plan_id',a.plan_id,'value',r.value)
      ORDER BY r.first_seen[1:2],private.energy_accuracy_property_index(r.key) NULLS LAST,r.first_seen[3])
    FROM room_rank r JOIN archive a USING(seq) WHERE r.rank=1),'[]'::jsonb),
  'estimates',coalesce((SELECT jsonb_agg(jsonb_build_object('at',e.at,'plan_id',a.plan_id,'value',e.estimate) ORDER BY e.at)
    FROM estimates e JOIN archive a USING(seq) WHERE e.rank=1),'[]'::jsonb),
  'catalog',jsonb_build_object(
    'names',(SELECT jsonb_agg(jsonb_build_array(key,name) ORDER BY first_seen) FROM named WHERE rank=1),
    'room_names',coalesce((SELECT jsonb_agg(jsonb_build_array(key,name) ORDER BY first_seen) FROM named_rooms WHERE rank=1),'[]'::jsonb),
    'latest_keys',coalesce((SELECT private.energy_accuracy_keys(forecast) FROM latest),'[]'::jsonb),
    'latest_rooms',coalesce((SELECT forecast->'rooms' FROM latest),'[]'::jsonb)),
  'actuals',coalesce((SELECT jsonb_agg(jsonb_build_object('start_ts',start_ts,'total_load_kwh',total_load_kwh,
    'solar_production_kwh',solar_production_kwh,'battery_charge_kwh',battery_charge_kwh,
    'battery_discharge_kwh',battery_discharge_kwh,'battery_soc',battery_soc) ORDER BY start_ts)
    FROM public.energy_optimisation_actual_slots WHERE home_id=p_home_id
      AND start_ts>=p_scheduled_at-interval '7 days' AND start_ts<p_scheduled_at),'[]'::jsonb),
  'device_actuals',coalesce((SELECT jsonb_agg(jsonb_build_object('start_ts',s.start_ts,'device_key',d.device_key,
    'energy_kwh',s.energy_kwh) ORDER BY s.start_ts,s.device_id)
    FROM public.energy_optimisation_device_slots s JOIN public.energy_optimisation_devices d ON d.id=s.device_id AND d.home_id=s.home_id
    WHERE s.home_id=p_home_id AND s.start_ts>=p_scheduled_at-interval '7 days' AND s.start_ts<p_scheduled_at),'[]'::jsonb),
  'prices',coalesce((SELECT jsonb_agg(jsonb_build_object('start_ts',start_ts,
    'import_price_sek_per_kwh',coalesce(import_price_sek_per_kwh,0)) ORDER BY start_ts)
    FROM public.energy_optimisation_price_slots WHERE home_id=p_home_id AND start_ts>=p_scheduled_at-interval '7 days'),'[]'::jsonb),
  'room_actuals',coalesce((SELECT jsonb_agg(jsonb_build_object('start_ts',start_ts,'room_key',room_key,
    'room_temperature_c',room_temperature_c) ORDER BY start_ts,room_key)
    FROM public.energy_optimisation_thermal_slots WHERE home_id=p_home_id
      AND start_ts>=p_scheduled_at-interval '7 days' AND start_ts<=p_scheduled_at),'[]'::jsonb));
$$;
