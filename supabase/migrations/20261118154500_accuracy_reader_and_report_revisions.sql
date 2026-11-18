-- Reporting only: group narrow first/latest identities, reconstruct winning
-- payloads once per plan, and return the scalar without a final tuplestore.
-- Preserve publication ties, missing rooms, first-seen order and future estimates.
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
  SELECT 'room',s.at+900000,r.key,ARRAY[a.seq,s.n,r.ord]
  FROM eligible s CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(s.slot->'room_temperature_c')='object'
   THEN s.slot->'room_temperature_c' ELSE '{}'::jsonb END) WITH ORDINALITY r(key,value,ord)
  WHERE s.eligible AND private.energy_accuracy_number(r.value) IS NOT NULL
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
    'value',private.energy_accuracy_number(s.slot->'room_temperature_c'->w.key))
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
    private.energy_accuracy_property_index(key) NULLS LAST,first_position[3]) FROM selected WHERE kind='room'),'[]'::jsonb),
  'estimates',coalesce((SELECT jsonb_agg(value ORDER BY at) FROM selected WHERE kind='estimate'),'[]'::jsonb),
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
      AND start_ts>=p_scheduled_at-interval '7 days' AND start_ts<=p_scheduled_at),'[]'::jsonb))
);
END;
$function$;

-- The conditional read must identify an unchanged report without touching TOAST.
ALTER TABLE public.energy_forecast_accuracy_reports
  ADD COLUMN revision uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN report_version text GENERATED ALWAYS AS (report->>'version') STORED;

CREATE FUNCTION private.revise_energy_accuracy_report()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.report IS DISTINCT FROM OLD.report OR NEW.diagnostics IS DISTINCT FROM OLD.diagnostics THEN
    NEW.revision := gen_random_uuid();
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION private.revise_energy_accuracy_report() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER energy_accuracy_report_revised BEFORE UPDATE ON public.energy_forecast_accuracy_reports
  FOR EACH ROW EXECUTE FUNCTION private.revise_energy_accuracy_report();
CREATE INDEX energy_accuracy_latest_v3 ON public.energy_forecast_accuracy_reports(home_id,scheduled_at DESC)
  WHERE report_version='3';

CREATE FUNCTION public.read_energy_forecast_accuracy(p_home_id uuid,p_known_revision uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE latest_revision uuid; latest_at timestamptz; payload jsonb;
BEGIN
  SELECT revision,scheduled_at INTO latest_revision,latest_at
    FROM public.energy_forecast_accuracy_reports
    WHERE home_id=p_home_id AND report_version='3' ORDER BY scheduled_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','missing','revision',NULL); END IF;
  IF latest_revision=p_known_revision THEN
    RETURN jsonb_build_object('state','unchanged','revision',latest_revision);
  END IF;
  SELECT report || jsonb_build_object('calculations',diagnostics) INTO payload
    FROM public.energy_forecast_accuracy_reports WHERE home_id=p_home_id AND scheduled_at=latest_at;
  RETURN jsonb_build_object('state','changed','revision',latest_revision,'report',payload);
END; $$;
REVOKE ALL ON FUNCTION public.read_energy_forecast_accuracy(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_energy_forecast_accuracy(uuid,uuid) TO authenticated,service_role;

-- Existing readers receive the identical full report during the reader-first
-- app/website rollout. Conditional clients opt in with their retained revision.
CREATE OR REPLACE FUNCTION public.get_energy_forecast_accuracy(p_home_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT public.read_energy_forecast_accuracy(p_home_id,NULL)->'report';
$$;
