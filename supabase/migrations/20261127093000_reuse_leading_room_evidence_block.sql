CREATE OR REPLACE FUNCTION public.freeze_energy_connected_planning_sources(p_home_id uuid,p_job_id uuid,p_fence bigint,p_room integer,
 p_from timestamptz,p_to timestamptz,p_implementation text,p_policy text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; room text; basis jsonb; graph jsonb; v_binding text; v_policy text; revision bigint; next_work json;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence OR j.lease_until IS NULL
   OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
 room:=j.input#>>ARRAY['snapshot','room_network_capture','rooms',p_room::text,'key'];
 basis:=(j.input#>ARRAY['snapshot','room_network_capture','rooms',p_room::text,'connected_exchange','basis'])::jsonb;
 revision:=private.lock_room_evidence(j.home_id);
 graph:=private.room_connection_graph(j.home_id);
 SELECT c.binding INTO v_binding FROM private.energy_room_heating_contexts(j.home_id,false) c WHERE c.room_key=room;
 v_policy:=private.room_evidence_policy_fingerprint(j.home_id,room,v_binding,p_from,p_to);
 IF v_binding IS NULL OR (p_policy IS NOT NULL AND p_policy IS DISTINCT FROM v_policy)
   OR p_from IS DISTINCT FROM (basis->>'history_from')::timestamptz
   OR p_to<p_from OR NOT isfinite(p_to)
   OR graph->'owner' IS DISTINCT FROM basis->'graph_owner'
   OR graph->'revision' IS DISTINCT FROM basis->'graph_revision'
   OR graph->'topology_hash' IS DISTINCT FROM basis->'topology_hash'
 THEN RAISE EXCEPTION 'Room capture source policy changed' USING ERRCODE='40001'; END IF;
 -- These derived bytes cannot serve the current accepted source scope. Keep
 -- canonical observations and fitted archives untouched; this is dependency
 -- ownership cleanup, not an age-based retention window.
 DELETE FROM private.energy_connected_source_cache c WHERE c.home_id=j.home_id AND c.room_key=room
   AND (c.binding IS DISTINCT FROM v_binding OR c.implementation IS DISTINCT FROM p_implementation OR c.to_at<=p_from);
 -- A sliding fit can start inside its first immutable archive block. Freeze
 -- that original envelope and hash, just as the fit loaded it. Qualification
 -- admits only intervals wholly within the requested population. The full
 -- source dirt halo and the end of the fit certificate still fence reuse.
 IF private.room_evidence_policy_fingerprint(j.home_id,room,v_binding,
      (basis->>'history_from')::timestamptz,(basis->>'history_to')::timestamptz)=basis->>'source_policy' THEN
   INSERT INTO private.energy_planning_room_source_blocks(job_id,room,from_at,to_at,capture,sha256)
   SELECT j.id,p_room,b.from_at,b.to_at,b.capture,b.sha256 FROM private.energy_room_evidence_blocks b
   WHERE b.home_id=j.home_id AND b.customer_id=j.customer_id AND b.room_key=room AND b.binding=v_binding
     AND b.implementation=p_implementation AND b.to_at>p_from AND b.to_at<=least(p_to,(basis->>'history_to')::timestamptz)
     AND b.source_revision<=(basis->>'source_revision')::bigint
     AND NOT private.room_evidence_changed(j.home_id,room,b.source_revision,b.from_at-interval '1 hour',b.to_at+interval '1 hour')
     AND NOT EXISTS(SELECT FROM private.energy_planning_room_source_blocks f WHERE f.job_id=j.id AND f.room=p_room
       AND tstzrange(f.from_at,f.to_at,'[)') && tstzrange(b.from_at,b.to_at,'[)'))
   ON CONFLICT DO NOTHING;
 END IF;
 -- Prefer canonical fitted blocks before shorter prior-plan tail blocks,
 -- so a daily fit does not fragment the reusable historical extent.
 INSERT INTO private.energy_planning_room_source_blocks(job_id,room,from_at,to_at,capture,sha256)
 SELECT j.id,p_room,b.from_at,b.to_at,b.capture,b.sha256 FROM private.energy_connected_source_cache b
 WHERE b.home_id=j.home_id AND b.room_key=room AND b.binding=v_binding AND b.implementation=p_implementation AND b.policy=v_policy
   AND b.from_at>=p_from AND b.to_at<=p_to
   AND NOT private.room_evidence_changed(j.home_id,room,b.source_revision,b.from_at-interval '1 hour',b.to_at+interval '1 hour')
   AND NOT EXISTS(SELECT FROM private.energy_planning_room_source_blocks f WHERE f.job_id=j.id AND f.room=p_room
     AND tstzrange(f.from_at,f.to_at,'[)') && tstzrange(b.from_at,b.to_at,'[)'))
 ON CONFLICT DO NOTHING;
 SELECT json_build_object('from_at',lower(gap),'to_at',least(upper(gap),lower(gap)+interval '240 hours')) INTO next_work
 FROM (SELECT unnest(tstzmultirange(tstzrange(p_from,p_to,'[)'))-
   coalesce(range_agg(tstzrange(from_at,to_at,'[)')),'{}'::tstzmultirange)) AS gap
   FROM private.energy_planning_room_source_blocks WHERE job_id=j.id AND energy_planning_room_source_blocks.room=p_room) gaps
 ORDER BY lower(gap) LIMIT 1;
 RETURN json_build_object('next',next_work,'source_revision',revision,'binding',v_binding,'policy',v_policy,'graph',graph);
END; $$;

CREATE OR REPLACE FUNCTION public.get_energy_room_thermal_intervals(
 p_customer_id uuid,p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(room_key text,room_name text,active_power_w double precision,start_ts timestamptz,
 room_temperature_c double precision,cooling boolean,outdoor_temperature_c double precision,
 solar_w_per_m2 double precision,house_temperature_c double precision,heat_w double precision,
 duration_s integer,source text,heat_attributed boolean,temperature_source_key text,probe_evidence jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
BEGIN
 -- A heated source has one or more meter keys. Observed-only receivers are
 -- defined by an empty device-statistics map. Pick the owning reader before
 -- it scans weather and qualifies every probe in the household.
 IF EXISTS(SELECT FROM private.energy_heating_observation_sources(p_home_id) s WHERE s.room_key=p_room_key) THEN
   RETURN QUERY SELECT q.room_key,q.room_name,q.active_power_w,q.start_ts,q.room_temperature_c,q.cooling,q.outdoor_temperature_c,
     q.solar_w_per_m2,q.house_temperature_c,q.heat_w,q.duration_s,q.source,q.heat_attributed,q.temperature_source_key,q.probe_evidence
   FROM private.energy_room_thermal_intervals(p_customer_id,p_home_id,p_room_key,p_from,p_to,true) q;
 ELSE
   RETURN QUERY SELECT * FROM private.energy_observed_room_thermal_intervals(p_customer_id,p_home_id,p_room_key,p_from,p_to);
 END IF;
END; $$;
