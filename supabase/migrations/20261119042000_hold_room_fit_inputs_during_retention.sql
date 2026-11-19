-- A committed fit capture owns its fixed evidence until completion or reset.
-- The learner still reads and learns from a rolling 400-day window.
CREATE FUNCTION private.room_fit_retention_ranges(p_capture jsonb)
RETURNS TABLE(discovery_at tstzrange,fit_at tstzrange)
LANGUAGE plpgsql STABLE SET search_path=public,private AS $$
DECLARE floor_at timestamptz; from_at timestamptz; to_at timestamptz;
BEGIN
 floor_at:=(p_capture->>'pinnedFloor')::timestamptz;
 from_at:=(p_capture#>>'{window,from_at}')::timestamptz;
 to_at:=(p_capture#>>'{window,to_at}')::timestamptz;
 IF floor_at IS NULL OR from_at IS NULL OR to_at IS NULL
   OR NOT isfinite(floor_at) OR NOT isfinite(from_at) OR NOT isfinite(to_at)
   OR floor_at>from_at OR from_at>=to_at OR to_at-floor_at>interval '9600 hours' THEN RETURN; END IF;
 -- Discovery can admit previously hidden fine intervals if an earlier
 -- competing native hour or its source facts disappear, even outside the fit.
 RETURN QUERY SELECT tstzrange(floor_at,to_at,'[)'),tstzrange(from_at,to_at,'[)');
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN;
END; $$;

CREATE FUNCTION private.room_fit_retention_holds(p_home_id uuid)
RETURNS TABLE(customer_id uuid,room_key text,discovery_at tstzrange,fit_at tstzrange,reference jsonb)
LANGUAGE sql STABLE SET search_path=public,private AS $$
 SELECT j.customer_id,j.owner_key,r.discovery_at,r.fit_at,p.metadata#>'{capture,reference}'
 FROM private.energy_learning_jobs j JOIN private.energy_room_fit_progress p ON p.job_id=j.id AND p.generation=j.generation
 CROSS JOIN LATERAL private.room_fit_retention_ranges(p.metadata->'capture') r
 WHERE j.home_id=p_home_id AND j.owner_kind='room' AND j.pending
   AND p.metadata->'version'='1'::jsonb AND p.metadata#>'{capture,version}'='1'::jsonb
   AND p.metadata#>>'{capture,homeId}'=j.home_id::text AND p.metadata#>>'{capture,customerId}'=j.customer_id::text
   AND p.metadata#>>'{capture,roomKey}'=j.owner_key;
$$;

-- Share only this short transaction lock with first capture insertion. Pruning
-- can try again during the next ordinary cleanup if a capture is committing.
CREATE FUNCTION private.lock_room_fit_retention(p_home_id uuid,p_wait boolean)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE key bigint:=hashtextextended('room fit retention '||p_home_id::text,0);
BEGIN
 IF NOT p_wait THEN RETURN pg_try_advisory_xact_lock(key); END IF;
 PERFORM pg_advisory_xact_lock(key);
 RETURN true;
END; $$;

CREATE FUNCTION private.lock_room_fit_capture_retention() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 PERFORM private.lock_room_fit_retention(j.home_id,true)
 FROM private.energy_learning_jobs j WHERE j.id=NEW.job_id AND j.pending
   AND j.owner_kind='room' AND j.generation=NEW.generation;
 RETURN NEW;
END; $$;
CREATE TRIGGER lock_room_fit_capture_retention BEFORE INSERT ON private.energy_room_fit_progress
 FOR EACH ROW EXECUTE FUNCTION private.lock_room_fit_capture_retention();

CREATE FUNCTION private.prune_native_room_fit_history(p_home_id uuid,p_before timestamptz,p_probes boolean)
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT private.lock_room_fit_retention(p_home_id,false) THEN RETURN; END IF;
 -- Read committed holds after acquiring the lock. A deleted hold can only
 -- defer cleanup until the next prune and cannot remove input from a new one.
 IF p_probes THEN
   WITH holds AS MATERIALIZED (SELECT * FROM private.room_fit_retention_holds(p_home_id))
   DELETE FROM energy_heating_probe_observations WHERE ctid IN (
     SELECT p.ctid FROM energy_heating_probe_observations p WHERE p.home_id=p_home_id AND p.start_ts<p_before
       AND NOT EXISTS(SELECT FROM holds h WHERE h.customer_id=p.customer_id AND h.discovery_at @> p.start_ts)
     ORDER BY p.start_ts LIMIT 2000 FOR UPDATE SKIP LOCKED);
 ELSE
   WITH holds AS MATERIALIZED (SELECT * FROM private.room_fit_retention_holds(p_home_id))
   DELETE FROM energy_heating_observations WHERE ctid IN (
     SELECT n.ctid FROM energy_heating_observations n WHERE n.home_id=p_home_id AND n.start_ts<p_before
       AND NOT EXISTS(SELECT FROM holds h WHERE h.customer_id=n.customer_id AND h.room_key=n.room_key AND h.discovery_at @> n.start_ts)
     ORDER BY n.start_ts LIMIT 2000 FOR UPDATE SKIP LOCKED);
 END IF;
END; $$;

CREATE FUNCTION private.prune_room_fit_device_history(p_home_id uuid,p_before timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT private.lock_room_fit_retention(p_home_id,false) THEN RETURN; END IF;
 WITH holds AS MATERIALIZED (SELECT * FROM private.room_fit_retention_holds(p_home_id)),
 held_meters AS MATERIALIZED (
   SELECT h.customer_id,d.id AS device_id,
     CASE WHEN d.mapping_summary->>'room_key'=h.room_key THEN h.discovery_at ELSE h.fit_at END AS held_at FROM holds h
   JOIN energy_optimisation_devices d ON d.home_id=p_home_id AND d.customer_id=h.customer_id AND d.retired_at IS NULL
   WHERE d.mapping_summary->>'room_key'=h.room_key OR (
     d.device_key=h.reference#>>'{passive_heat,device_key}' AND d.planning_role_override='base_load'
     AND EXISTS(SELECT FROM private.energy_room_passive_heat_sources s WHERE s.home_id=p_home_id
       AND s.customer_id=h.customer_id AND s.room_key=h.room_key AND s.device_id=d.id)
   )
 )
 DELETE FROM energy_optimisation_device_slots WHERE id IN (
   SELECT e.id FROM energy_optimisation_device_slots e WHERE e.home_id=p_home_id AND e.start_ts<p_before
     AND NOT EXISTS(SELECT FROM held_meters h WHERE h.customer_id=e.customer_id AND h.device_id=e.device_id AND h.held_at @> e.start_ts)
   ORDER BY e.start_ts,e.id LIMIT 1000 FOR UPDATE SKIP LOCKED);
END; $$;

CREATE FUNCTION private.prune_room_fit_doorway_history(p_home_id uuid,p_before timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT private.lock_room_fit_retention(p_home_id,false) THEN RETURN; END IF;
 WITH holds AS MATERIALIZED (SELECT * FROM private.room_fit_retention_holds(p_home_id)),
 held_doors AS MATERIALIZED (
   SELECT room_key,reference#>>'{doorway_exchange,source}' AS source_key,fit_at FROM holds
   UNION ALL
   SELECT peer->>'key',peer->>'source',h.fit_at FROM holds h
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(h.reference#>'{doorway_exchange,peers}')='array'
     THEN h.reference#>'{doorway_exchange,peers}' ELSE '[]'::jsonb END) peer
 ),
 -- The canonical legacy cutoff uses the owner's last different thermometer.
 -- That single row can be earlier than the captured training interval.
 anchors AS MATERIALIZED (
   SELECT a.room_key,a.source_key,a.start_ts FROM holds h JOIN energy_room_profiles r ON r.home_id=p_home_id
   CROSS JOIN LATERAL (
     SELECT p.room_key,p.source_key,p.start_ts FROM energy_room_probe_slots p
     WHERE p.home_id=p_home_id AND p.room_key=h.room_key AND p.source_key IS DISTINCT FROM r.rooms->h.room_key->>'source_key'
     ORDER BY p.start_ts DESC,p.source_key LIMIT 1
   ) a
 )
 DELETE FROM energy_room_probe_slots WHERE ctid IN (
   SELECT p.ctid FROM energy_room_probe_slots p WHERE p.home_id=p_home_id AND p.start_ts<p_before
     AND NOT EXISTS(SELECT FROM held_doors h WHERE h.room_key=p.room_key AND h.source_key=p.source_key AND h.fit_at @> p.start_ts)
     AND NOT EXISTS(SELECT FROM anchors a WHERE (a.room_key,a.source_key,a.start_ts)=(p.room_key,p.source_key,p.start_ts))
   FOR UPDATE SKIP LOCKED);
END; $$;

CREATE FUNCTION private.prune_expired_room_probe_history() RETURNS void
LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE before_at timestamptz:=now()-interval '120 days'; home uuid;
BEGIN
 FOR home IN SELECT DISTINCT home_id FROM energy_room_probe_slots WHERE start_ts<before_at ORDER BY home_id LOOP
   PERFORM private.prune_room_fit_doorway_history(home,before_at);
 END LOOP;
END; $$;

REVOKE ALL ON FUNCTION private.room_fit_retention_ranges(jsonb),private.room_fit_retention_holds(uuid),
 private.lock_room_fit_retention(uuid,boolean),private.lock_room_fit_capture_retention(),
 private.prune_native_room_fit_history(uuid,timestamptz,boolean),private.prune_room_fit_device_history(uuid,timestamptz),
 private.prune_room_fit_doorway_history(uuid,timestamptz),private.prune_expired_room_probe_history()
 FROM PUBLIC,anon,authenticated,service_role;

SELECT cron.schedule('prune-energy-room-probe-history','37 3 * * *',
 $$SELECT private.prune_expired_room_probe_history()$$);

-- Keep the existing ingestion contracts and route only age cleanup through the holds.
CREATE OR REPLACE FUNCTION public.record_energy_heating_observations(p_home_id uuid,p_customer_id uuid,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE accepted jsonb;
BEGIN
 IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
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
   coalesce(r.heater_energy_limits_w,'{}'::jsonb),r.cooling
 FROM jsonb_to_recordset(p_rows) AS r(room_key text,source_key text,device_statistics jsonb,
   start timestamptz,duration_s integer,source text,room_temperature_c double precision,
   outdoor_temperature_c double precision,house_temperature_c double precision,solar_w_per_m2 double precision,
   device_energy_kwh jsonb,heater_energy_limits_w jsonb,cooling boolean,invalidated_device_keys text[])
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

CREATE OR REPLACE FUNCTION public.record_energy_heating_probe_observations(p_home_id uuid,p_customer_id uuid,p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE accepted integer;
BEGIN
 IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Probe observations must be an array'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p_rows) r WHERE jsonb_typeof(r->'probes') IS DISTINCT FROM 'array')
 THEN RAISE EXCEPTION 'Probe evidence must be an array'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p_rows) r CROSS JOIN LATERAL jsonb_array_elements(r->'probes') p
   WHERE jsonb_typeof(p) IS DISTINCT FROM 'object' OR coalesce(p->>'source_key','')!~'^[0-9a-f]{64}$'
    OR jsonb_typeof(p->'area_key') IS DISTINCT FROM 'string' OR length(p->>'area_key')=0
    OR (p ? 'mean' AND jsonb_typeof(p->'mean') NOT IN ('number','null'))
    OR (p ? 'cohort_key' AND jsonb_typeof(p->'cohort_key') NOT IN ('string','null'))
    OR EXISTS(SELECT FROM unnest(ARRAY['unchanged','joint_unchanged','reported','unavailable']) k
      WHERE p ? k AND jsonb_typeof(p->k) NOT IN ('boolean','null')))
 THEN RAISE EXCEPTION 'Invalid probe evidence'; END IF;
 WITH incoming AS (
  SELECT DISTINCT ON ((r->>'start')::timestamptz,(r->>'duration_s')::integer)
    (r->>'start')::timestamptz AS start_ts,(r->>'duration_s')::integer AS duration_s,r->'probes' AS probes
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY rows(r,position)
  ORDER BY (r->>'start')::timestamptz,(r->>'duration_s')::integer,position DESC
 ), written AS (
  INSERT INTO energy_heating_probe_observations AS prior(home_id,customer_id,start_ts,duration_s,probes)
  SELECT p_home_id,p_customer_id,start_ts,duration_s,private.merge_heating_probe_facts('[]'::jsonb,probes) FROM incoming
  ON CONFLICT(home_id,start_ts,duration_s) DO UPDATE SET
    probes=private.merge_heating_probe_facts(prior.probes,EXCLUDED.probes)
  RETURNING 1
 ) SELECT count(*) INTO accepted FROM written;
 PERFORM private.prune_native_room_fit_history(p_home_id,now()-interval '400 days',true);
 RETURN accepted;
END; $$;

CREATE OR REPLACE FUNCTION public.prune_energy_optimisation_data(p_home_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.energy_optimisation_actual_slots WHERE id IN (
    SELECT id FROM public.energy_optimisation_actual_slots
    WHERE home_id = p_home_id AND start_ts < now() - interval '1095 days'
    ORDER BY start_ts, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM public.energy_optimisation_pool_slots WHERE id IN (
    SELECT id FROM public.energy_optimisation_pool_slots
    WHERE home_id = p_home_id AND start_ts < now() - interval '1095 days'
    ORDER BY start_ts, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
  PERFORM private.prune_room_fit_device_history(p_home_id,now()-interval '400 days');
  DELETE FROM public.energy_optimisation_plan_runs WHERE id IN (
    SELECT id FROM public.energy_optimisation_plan_runs
    WHERE home_id = p_home_id AND issued_at < now() - interval '400 days'
    ORDER BY issued_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM public.energy_optimisation_forecast_runs WHERE id IN (
    SELECT id FROM public.energy_optimisation_forecast_runs
    WHERE home_id = p_home_id AND issued_at < now() - interval '400 days'
    ORDER BY issued_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
END;
$$;
