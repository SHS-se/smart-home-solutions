-- Quarter-hour uploads must not scan every retained heating interval. The
-- home/time index also serves age pruning across rooms; the existing room/time
-- index serves source-qualified overlap seeks. No retention or source rule changes.
CREATE INDEX energy_heating_observations_retention
 ON public.energy_heating_observations(home_id,start_ts);

-- These small bounded writes do not benefit from per-request JIT compilation.
ALTER FUNCTION public.record_energy_heating_probe_observations(uuid,uuid,jsonb) SET jit='off';
ALTER FUNCTION private.prune_native_room_fit_history(uuid,timestamptz,boolean) SET jit='off';

CREATE OR REPLACE FUNCTION public.record_energy_heating_observations(p_home_id uuid,p_customer_id uuid,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET jit='off' AS $$
DECLARE accepted jsonb;
BEGIN
 -- Qualify and gate before either the thermal or electrical retraction path.
 p_rows:=private.gate_heating_counter_processing(p_home_id,p_customer_id,p_rows);
 IF EXISTS (SELECT FROM jsonb_array_elements(p_rows) r
   WHERE jsonb_array_length(r->'invalidated_device_keys')>0) THEN
 PERFORM private.retract_weather_heating_meter(p_home_id,p_customer_id,p_rows);
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
       -- Stored native intervals are at most one hour. Seek only possible
       -- overlaps instead of scanning this room's entire retained history.
       AND n.start_ts>r.start-interval '1 hour'
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
 END IF;
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
