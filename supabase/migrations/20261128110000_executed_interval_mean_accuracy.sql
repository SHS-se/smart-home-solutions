-- Accuracy is comparable only with the physical mode recorded at issuance.
-- Old endpoint-only temperatures and unrecorded actuator modes are not evidence
-- of executed interval-mean predictions. Baseline and solar remain comparable.
CREATE OR REPLACE FUNCTION private.energy_accuracy_keys(forecast jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
 SELECT '["baseline"]'::jsonb || coalesce((SELECT jsonb_agg('device:'||(d->>'key') ORDER BY n)
 FROM jsonb_array_elements(forecast->'devices') WITH ORDINALITY x(d,n)
 WHERE forecast->>'comparison_basis'='executed_interval_means_v1' AND d->>'mode'='controlling'),'[]'::jsonb)
 || '["solar"]'::jsonb || CASE WHEN forecast->'battery'='true'::jsonb
 AND forecast->>'comparison_basis'='executed_interval_means_v1' AND forecast->>'battery_mode'='controlling'
 THEN '["battery"]'::jsonb ELSE '[]'::jsonb END;
$$;
CREATE OR REPLACE FUNCTION public.read_energy_accuracy_evidence(p_home_id uuid, p_scheduled_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
 SET "TimeZone" TO 'UTC'
AS $function$
BEGIN
RETURN (
WITH bounds AS (
  SELECT floor(extract(epoch FROM p_scheduled_at)*1000)::bigint AS until_ms,
    floor(extract(epoch FROM p_scheduled_at-interval '7 days')*1000)::bigint AS from_ms
), archive AS MATERIALIZED (
  SELECT plan_id,published_at,forecast,
    floor(extract(epoch FROM published_at)*1000)::bigint AS published_ms,
    row_number() OVER (ORDER BY floor(extract(epoch FROM published_at)*1000),plan_id::text COLLATE "C") AS seq
  FROM public.energy_forecast_records
  WHERE home_id=p_home_id AND horizon_end>=p_scheduled_at-interval '7 days' AND published_at<=p_scheduled_at
), positions AS MATERIALIZED (
 SELECT e.kind,e.at,e.key,min(e.position) AS first_position,max(e.position) AS latest_position
 FROM archive a
 CROSS JOIN LATERAL (
  WITH parsed AS MATERIALIZED (
   SELECT q.slot,q.n,private.energy_accuracy_ms(q.slot->>'start') AS at,
    private.energy_accuracy_number(q.slot->'duration_hours') AS duration,
    private.energy_accuracy_number(q.slot->'estimated_import_sek_per_kwh') AS estimate
   FROM jsonb_array_elements(a.forecast->'slots') WITH ORDINALITY AS q(slot,n)
  ), eligible AS MATERIALIZED (
   SELECT *,at+900000<=b.until_ms AND at>=a.published_ms AND duration=.25 AS eligible
   FROM parsed CROSS JOIN bounds b WHERE at>=b.from_ms
  )
  SELECT 'energy'::text AS kind,s.at,''::text AS key,ARRAY[a.seq,s.n] AS position
  FROM eligible s WHERE s.eligible
  UNION ALL
  SELECT 'room',s.at,r.value->>'key',ARRAY[a.seq,s.n,r.ord]
  FROM eligible s CROSS JOIN LATERAL jsonb_array_elements(CASE
    WHEN a.forecast->>'comparison_basis'='executed_interval_means_v1'
    AND jsonb_typeof(a.forecast->'rooms')='array' THEN a.forecast->'rooms' ELSE '[]'::jsonb END)
    WITH ORDINALITY r(value,ord)
  WHERE s.eligible
  UNION ALL
  SELECT 'estimate',s.at,'',ARRAY[a.seq,s.n]
  FROM eligible s WHERE s.estimate IS NOT NULL
 ) e
 GROUP BY e.kind,e.at,e.key
), plans AS (
 SELECT latest_position[1] AS seq,jsonb_agg(jsonb_build_object('kind',kind,'at',at,'key',key,
  'first_position',first_position,'n',latest_position[2])) AS winners
 FROM positions GROUP BY latest_position[1]
), selected AS MATERIALIZED (
 SELECT e.kind,e.at,e.key,e.first_position,e.value
 FROM plans p JOIN archive a USING(seq)
 CROSS JOIN LATERAL (
  WITH metadata AS MATERIALIZED (
   SELECT a.plan_id,a.published_ms,a.forecast->'model_version' AS model_version,
    private.energy_accuracy_keys(a.forecast) AS keys
  ), slots AS MATERIALIZED (
   SELECT q.slot,q.n FROM jsonb_array_elements(a.forecast->'slots') WITH ORDINALITY q(slot,n)
  )
  SELECT w.kind,w.at,w.key,w.first_position,
   CASE w.kind WHEN 'energy' THEN jsonb_build_object('at',w.at,'plan_id',m.plan_id,'published_at',m.published_ms,
    'model_version',m.model_version,'keys',m.keys,'slot',s.slot)
   WHEN 'room' THEN jsonb_build_object('at',w.at,'key',w.key,'plan_id',m.plan_id,
    'value',CASE WHEN a.forecast->>'temperature_aggregation'='interval_mean'
      AND EXISTS(SELECT FROM jsonb_array_elements(a.forecast->'rooms') r
        WHERE r->>'key'=w.key AND r->>'comparison'='executed_interval_mean')
      THEN private.energy_accuracy_number(s.slot->'room_mean_temperature_c'->w.key) END)
   ELSE jsonb_build_object('at',w.at,'plan_id',m.plan_id,
    'value',private.energy_accuracy_number(s.slot->'estimated_import_sek_per_kwh')) END AS value
  FROM jsonb_to_recordset(p.winners) w(kind text,at bigint,key text,first_position bigint[],n bigint)
  JOIN slots s USING(n) CROSS JOIN metadata m
 ) e
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
  'energy',coalesce((SELECT jsonb_agg(value ORDER BY first_position) FROM selected WHERE kind='energy'),'[]'::jsonb),
  'rooms',coalesce((SELECT jsonb_agg(value ORDER BY first_position[1:2],
    private.energy_accuracy_property_index(key) NULLS LAST,first_position[3]) FROM selected WHERE kind='room' AND value->'value'<>'null'::jsonb),'[]'::jsonb),
  'estimates',coalesce((SELECT jsonb_agg(value ORDER BY at) FROM selected WHERE kind='estimate'),'[]'::jsonb),
  'catalog',jsonb_build_object(
    'names',(SELECT jsonb_agg(jsonb_build_array(key,name) ORDER BY first_seen) FROM named WHERE rank=1),
    'room_names',coalesce((SELECT jsonb_agg(jsonb_build_array(key,name) ORDER BY first_seen) FROM named_rooms WHERE rank=1),'[]'::jsonb),
    'latest_keys',coalesce((SELECT private.energy_accuracy_keys(forecast) FROM latest),'[]'::jsonb),
    'latest_rooms',coalesce((SELECT jsonb_agg(r||jsonb_build_object('comparison',
      CASE WHEN forecast->>'comparison_basis'='executed_interval_means_v1' THEN r->>'comparison' ELSE 'mode_unrecorded' END))
      FROM latest CROSS JOIN LATERAL jsonb_array_elements(forecast->'rooms') r),'[]'::jsonb)),
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
      AND start_ts>=p_scheduled_at-interval '7 days' AND start_ts<=p_scheduled_at),'[]'::jsonb))
);
END;
$function$;


-- Recompute reports through the existing durable queue. No planning or device work.
SELECT private.queue_energy_accuracy(coalesce(array_agg(home_id),'{}'::uuid[])) FROM public.energy_optimisation_current;
