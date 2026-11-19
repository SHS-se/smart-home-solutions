-- Cleaner semantics are ordered per physical counter, independently of app
-- versions, sensor names, sampling resolution and the arrival time of uploads.
CREATE TABLE private.energy_heating_meter_processing (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 device_key text NOT NULL,
 statistic_id text NOT NULL,
 processing_revision integer NOT NULL CHECK(processing_revision>=0),
 PRIMARY KEY(home_id,device_key,statistic_id)
);
ALTER TABLE private.energy_heating_meter_processing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_heating_meter_processing FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.gate_heating_counter_processing(p_home_id uuid,p_customer_id uuid,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE qualified jsonb; gated jsonb;
BEGIN
 IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 -- An omitted revision is the previous producer contract. A malformed explicit
 -- claim must never acquire authority by a cast or silent coercion.
 IF EXISTS(SELECT FROM jsonb_array_elements(p_rows) r WHERE r ? 'counter_processing_revision'
   AND CASE WHEN jsonb_typeof(r->'counter_processing_revision') IS DISTINCT FROM 'number' THEN true ELSE ((r->>'counter_processing_revision')::numeric<0
     OR (r->>'counter_processing_revision')::numeric<>trunc((r->>'counter_processing_revision')::numeric)
     OR (r->>'counter_processing_revision')::numeric>2147483647) END)
 THEN RAISE EXCEPTION 'Invalid counter processing revision'; END IF;
 SELECT coalesce(jsonb_agg(r ORDER BY ord),'[]'::jsonb) INTO qualified
 FROM jsonb_array_elements(p_rows) WITH ORDINALITY incoming(r,ord)
 WHERE EXISTS(SELECT FROM private.energy_heating_observation_sources(p_home_id) s
   WHERE s.room_key=r->>'room_key' AND (
     (r->>'source_key'=s.source_key AND r->'device_statistics'=s.device_statistics)
     OR private.energy_heating_source_matches(p_home_id,r->>'room_key',r->>'source_key',r->'device_statistics',
       s.source_key,s.device_statistics,(r->>'start')::timestamptz,(r->>'duration_s')::integer)));
 -- Every writer locks the same counter row, including revision zero. Sorted
 -- acquisition avoids deadlocks across multi-meter captures. Whole-batch maxima
 -- prevent JSON order from granting an older sibling row authority.
 INSERT INTO private.energy_heating_meter_processing AS prior(home_id,device_key,statistic_id,processing_revision)
 SELECT p_home_id,m.key,m.value,max(coalesce((r->>'counter_processing_revision')::numeric::integer,0))
 FROM jsonb_array_elements(qualified) r CROSS JOIN LATERAL jsonb_each_text(r->'device_statistics') m
 GROUP BY m.key,m.value ORDER BY m.key,m.value
 ON CONFLICT(home_id,device_key,statistic_id) DO UPDATE
 SET processing_revision=EXCLUDED.processing_revision
 WHERE EXCLUDED.processing_revision>prior.processing_revision;
 SELECT coalesce(jsonb_agg(r || jsonb_build_object(
   'device_energy_kwh',coalesce(r->'device_energy_kwh','{}'::jsonb)-blocked.keys,
   'heater_energy_limits_w',coalesce(r->'heater_energy_limits_w','{}'::jsonb)-blocked.keys,
   'invalidated_device_keys',(SELECT coalesce(jsonb_agg(k),'[]'::jsonb)
     FROM jsonb_array_elements_text(coalesce(r->'invalidated_device_keys','[]'::jsonb)) k
     WHERE NOT k=ANY(blocked.keys)),
   'protected_device_keys',to_jsonb(blocked.keys)) ORDER BY ord),'[]'::jsonb) INTO gated
 FROM jsonb_array_elements(qualified) WITH ORDINALITY incoming(r,ord)
 CROSS JOIN LATERAL (
   SELECT coalesce(array_agg(m.key ORDER BY m.key),ARRAY[]::text[]) AS keys
   FROM jsonb_each_text(r->'device_statistics') m
   JOIN private.energy_heating_meter_processing w ON w.home_id=p_home_id
     AND w.device_key=m.key AND w.statistic_id=m.value
   WHERE w.processing_revision>coalesce((r->>'counter_processing_revision')::numeric::integer,0)
 ) blocked;
 RETURN gated;
END; $$;
REVOKE ALL ON FUNCTION private.gate_heating_counter_processing(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.record_energy_heating_observations(p_home_id uuid,p_customer_id uuid,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE accepted jsonb;
BEGIN
 -- Qualify and gate before either the thermal or electrical retraction path.
 p_rows:=private.gate_heating_counter_processing(p_home_id,p_customer_id,p_rows);
 PERFORM private.retract_weather_heating_meter(p_home_id,p_customer_id,p_rows)
 WHERE EXISTS (SELECT FROM jsonb_array_elements(p_rows) r
   WHERE jsonb_array_length(r->'invalidated_device_keys')>0);
 -- An explicit counter retraction invalidates overlapping finer/coarser records
 -- from that same physical source. Missing raw history alone never retracts data.
 WITH incoming AS MATERIALIZED (
   SELECT * FROM jsonb_to_recordset(p_rows) AS r(room_key text,source_key text,device_statistics jsonb,
     start timestamptz,duration_s integer,invalidated_device_keys text[],device_energy_kwh jsonb)
 ), retractions AS (
   SELECT n.home_id,n.room_key,n.source_revision,n.start_ts,n.duration_s,
     array_agg(DISTINCT k.device_key) AS invalidated_device_keys
   FROM energy_heating_observations n
   JOIN incoming r
     ON n.room_key=r.room_key AND n.source_key=r.source_key AND n.device_statistics=r.device_statistics
       AND n.start_ts<r.start+make_interval(secs=>r.duration_s)
       AND n.start_ts+make_interval(secs=>n.duration_s)>r.start
   CROSS JOIN LATERAL unnest(r.invalidated_device_keys) k(device_key)
   WHERE n.home_id=p_home_id AND n.customer_id=p_customer_id
     -- A valid replacement at this exact native interval survives. Let its
     -- UPSERT compare the final value once; clearing then restoring it would
     -- falsely advance the evidence clock on every identical replay.
     AND NOT EXISTS (
       SELECT FROM incoming measured WHERE measured.room_key=n.room_key
         AND measured.source_key=n.source_key AND measured.device_statistics=n.device_statistics
         AND measured.start=n.start_ts AND measured.duration_s=n.duration_s
         AND jsonb_typeof(measured.device_energy_kwh->k.device_key)='number'
     )
   GROUP BY n.home_id,n.room_key,n.source_revision,n.start_ts,n.duration_s
 )
 UPDATE energy_heating_observations n SET device_energy_kwh=n.device_energy_kwh-r.invalidated_device_keys
 FROM retractions r WHERE (n.home_id,n.room_key,n.source_revision,n.start_ts,n.duration_s)
   =(r.home_id,r.room_key,r.source_revision,r.start_ts,r.duration_s);
 WITH written AS (INSERT INTO energy_heating_observations AS prior (home_id,customer_id,room_key,source_revision,source_key,
   device_statistics,start_ts,duration_s,source,room_temperature_c,outdoor_temperature_c,house_temperature_c,
   solar_w_per_m2,device_energy_kwh,heater_energy_limits_w,cooling)
 SELECT p_home_id,p_customer_id,r.room_key,md5(jsonb_build_array(r.source_key,r.device_statistics)::text),
   r.source_key,r.device_statistics,r.start,r.duration_s,r.source,r.room_temperature_c,
   r.outdoor_temperature_c,r.house_temperature_c,r.solar_w_per_m2,
   -- The producer has already cleaned this resolution. A retraction may
   -- refer to a different resolution, whose older overlaps were removed
   -- above. Null still supplies no replacement for a withdrawn measurement.
   jsonb_strip_nulls(r.device_energy_kwh),
   -- Preserve old attribution only for the blocked counter keys; an admitted
   -- counter's complete attribution map can legitimately remove its limit.
   coalesce((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(coalesce(existing.heater_energy_limits_w,'{}'::jsonb)) e
     WHERE e.key=ANY(coalesce(r.protected_device_keys,ARRAY[]::text[]))),'{}'::jsonb)
     ||coalesce(r.heater_energy_limits_w,'{}'::jsonb),r.cooling
 FROM jsonb_to_recordset(p_rows) AS r(room_key text,source_key text,device_statistics jsonb,
   start timestamptz,duration_s integer,source text,room_temperature_c double precision,
   outdoor_temperature_c double precision,house_temperature_c double precision,solar_w_per_m2 double precision,
   device_energy_kwh jsonb,heater_energy_limits_w jsonb,cooling boolean,invalidated_device_keys text[],protected_device_keys text[])
 LEFT JOIN energy_heating_observations existing ON existing.home_id=p_home_id AND existing.room_key=r.room_key
   AND existing.source_revision=md5(jsonb_build_array(r.source_key,r.device_statistics)::text)
   AND existing.start_ts=r.start AND existing.duration_s=r.duration_s
 JOIN private.energy_heating_observation_sources(p_home_id) s ON s.room_key=r.room_key
   -- Accept current-source raw captures even where a reviewed historic source
   -- owns learning. Their source identity stays intact and the learning read
   -- excludes them; ordinary historical backfill must not retry them forever.
   AND ((r.source_key=s.source_key AND r.device_statistics=s.device_statistics) OR
     private.energy_heating_source_matches(p_home_id,r.room_key,r.source_key,r.device_statistics,
       s.source_key,s.device_statistics,r.start,r.duration_s))
 ON CONFLICT (home_id,room_key,source_revision,start_ts,duration_s) DO UPDATE SET
   room_temperature_c=coalesce(EXCLUDED.room_temperature_c,prior.room_temperature_c),
   outdoor_temperature_c=coalesce(EXCLUDED.outdoor_temperature_c,prior.outdoor_temperature_c),
   house_temperature_c=coalesce(EXCLUDED.house_temperature_c,prior.house_temperature_c),
   solar_w_per_m2=coalesce(EXCLUDED.solar_w_per_m2,prior.solar_w_per_m2),
   -- Unavailable rereads preserve known measurements. Explicit cleaner
   -- retractions above remove untrusted keys, including overlapping resolutions.
   device_energy_kwh=prior.device_energy_kwh||EXCLUDED.device_energy_kwh,
   -- This is the complete selected-source attribution map, not additive facts.
   heater_energy_limits_w=EXCLUDED.heater_energy_limits_w,
   cooling=coalesce(EXCLUDED.cooling,prior.cooling)
 RETURNING room_key,source_key)
 SELECT jsonb_build_object('accepted',coalesce(sum(n),0),'accepted_by_source',
   coalesce(jsonb_agg(jsonb_build_object('room_key',room_key,'source_key',source_key,'accepted',n)),'[]'::jsonb))
 INTO accepted FROM (SELECT room_key,source_key,count(*) AS n FROM written GROUP BY room_key,source_key) counts;
 PERFORM private.prune_native_room_fit_history(p_home_id,now()-interval '400 days',false);
 DELETE FROM private.energy_weather_heating_withdrawals WHERE ctid IN (
   SELECT ctid FROM private.energy_weather_heating_withdrawals WHERE home_id=p_home_id
     AND start_ts<now()-interval '400 days' ORDER BY start_ts LIMIT 1000 FOR UPDATE SKIP LOCKED);
 RETURN accepted;
END;
$$;

