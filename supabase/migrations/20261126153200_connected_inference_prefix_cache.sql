-- Derived caches never replace canonical observations. Every plan independently
-- qualifies its full population before reusing a numerical prefix posterior.
CREATE TABLE private.energy_connected_inference_cache (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 room_key text NOT NULL,
 identity text NOT NULL,
 through_at timestamptz NOT NULL,
 row_count integer NOT NULL CHECK(row_count>=0),
 numeric_sha256 text NOT NULL CHECK(numeric_sha256 ~ '^[a-f0-9]{64}$'),
 block_boundary boolean NOT NULL,
 belief json NOT NULL CHECK(json_typeof(belief)='object'),
 PRIMARY KEY(home_id,room_key,through_at)
);
CREATE TABLE private.energy_connected_source_cache (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 room_key text NOT NULL,binding text NOT NULL,implementation text NOT NULL,policy text NOT NULL,
 from_at timestamptz NOT NULL,to_at timestamptz NOT NULL,
 source_revision bigint NOT NULL,capture bytea NOT NULL,sha256 text NOT NULL,
 PRIMARY KEY(home_id,room_key,from_at),
 CHECK(to_at>from_at AND to_at<=from_at+interval '240 hours')
);
ALTER TABLE private.energy_connected_inference_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_connected_source_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_connected_inference_cache,private.energy_connected_source_cache FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.load_energy_connected_inference(p_home_id uuid,p_job_id uuid,p_fence bigint,p_room integer,p_identity text,p_through_at timestamptz DEFAULT NULL)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 SELECT CASE WHEN p_through_at IS NULL THEN coalesce(json_agg(json_build_object('through_at',c.through_at,
   'row_count',c.row_count,'numeric_sha256',c.numeric_sha256) ORDER BY c.through_at DESC),'[]'::json)
 ELSE (json_agg(json_build_object('through_at',c.through_at,'row_count',c.row_count,'numeric_sha256',c.numeric_sha256,'belief',c.belief,
   'current_prefix_sha256',CASE WHEN c.row_count<=n.numeric_row_count THEN encode(sha256(substring(n.numeric_capture FROM 1
     FOR n.numeric_header_bytes+c.row_count*n.numeric_row_bytes)),'hex') END)))->0 END
 FROM private.energy_planning_jobs j JOIN private.energy_connected_inference_cache c
 ON c.home_id=j.home_id AND c.room_key=j.input#>>ARRAY['snapshot','room_network_capture','rooms',p_room::text,'key']
 LEFT JOIN private.energy_planning_room_capture n ON n.job_id=j.id
 WHERE j.id=p_job_id AND j.home_id=p_home_id AND j.state='pending' AND j.fence=p_fence AND j.lease_until IS NOT NULL
   AND private.energy_planning_is_current(j) AND c.identity=p_identity AND (p_through_at IS NULL OR c.through_at=p_through_at);
$$;
REVOKE ALL ON FUNCTION public.load_energy_connected_inference(uuid,uuid,bigint,integer,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_energy_connected_inference(uuid,uuid,bigint,integer,text,timestamptz) TO service_role;

CREATE FUNCTION public.save_energy_connected_inference(p_home_id uuid,p_job_id uuid,p_fence bigint,p_room integer,
 p_identity text,p_through_at timestamptz,p_row_count integer,p_numeric_sha256 text,p_belief json,p_block_boundary boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; room text; expected_sha text;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN false; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence OR j.lease_until IS NULL
   OR NOT private.energy_planning_is_current(j) THEN RETURN false; END IF;
 room:=j.input#>>ARRAY['snapshot','room_network_capture','rooms',p_room::text,'key'];
 SELECT encode(sha256(substring(n.numeric_capture FROM 1 FOR n.numeric_header_bytes+p_row_count*n.numeric_row_bytes)),'hex')
 INTO expected_sha FROM private.energy_planning_room_capture n WHERE n.job_id=j.id AND p_row_count<=n.numeric_row_count;
 IF room IS NULL OR nullif(p_identity,'') IS NULL OR NOT isfinite(p_through_at) OR p_row_count<0
   OR expected_sha IS NULL OR (p_numeric_sha256 IS NOT NULL AND p_numeric_sha256 IS DISTINCT FROM expected_sha)
   OR json_typeof(p_belief) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'Invalid connected inference prefix' USING ERRCODE='22023'; END IF;
 DELETE FROM private.energy_connected_inference_cache c WHERE c.home_id=j.home_id AND c.room_key=room
   AND (c.identity<>p_identity OR (NOT c.block_boundary AND c.through_at<>p_through_at));
 INSERT INTO private.energy_connected_inference_cache(home_id,room_key,identity,through_at,row_count,numeric_sha256,block_boundary,belief)
 VALUES(j.home_id,room,p_identity,p_through_at,p_row_count,expected_sha,p_block_boundary,p_belief)
 ON CONFLICT(home_id,room_key,through_at) DO UPDATE SET identity=EXCLUDED.identity,
 row_count=EXCLUDED.row_count,numeric_sha256=EXCLUDED.numeric_sha256,block_boundary=EXCLUDED.block_boundary,belief=EXCLUDED.belief;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.save_energy_connected_inference(uuid,uuid,bigint,integer,text,timestamptz,integer,text,json,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_energy_connected_inference(uuid,uuid,bigint,integer,text,timestamptz,integer,text,json,boolean) TO service_role;

-- Copy reusable raw bytes inside PostgreSQL, not forty history payloads through
-- forty Edge receipt polls. Dirt and policy are checked before freezing each
-- block; already frozen blocks are immutable for this admitted attempt.
CREATE FUNCTION public.freeze_energy_connected_planning_sources(p_home_id uuid,p_job_id uuid,p_fence bigint,p_room integer,
 p_from timestamptz,p_to timestamptz,p_implementation text,p_policy text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; room text; model jsonb; v_binding text; v_policy text; revision bigint; next_work json;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence OR j.lease_until IS NULL
   OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
 room:=j.input#>>ARRAY['snapshot','room_network_capture','rooms',p_room::text,'key'];
 model:=(j.input#>ARRAY['snapshot','room_network_capture','rooms',p_room::text,'connected_exchange'])::jsonb;
 SELECT c.binding INTO v_binding FROM private.energy_room_heating_contexts(j.home_id,false) c WHERE c.room_key=room;
 v_policy:=private.room_evidence_policy_fingerprint(j.home_id,room,v_binding,p_from,p_to);
 IF v_binding IS NULL OR (p_policy IS NOT NULL AND p_policy IS DISTINCT FROM v_policy)
   OR p_from IS DISTINCT FROM (model#>>'{basis,history_from}')::timestamptz
   OR p_to<p_from OR NOT isfinite(p_to)
   OR private.room_connection_graph(j.home_id)->'owner' IS DISTINCT FROM model#>'{basis,graph_owner}'
   OR private.room_connection_graph(j.home_id)->'revision' IS DISTINCT FROM model#>'{basis,graph_revision}'
   OR private.room_connection_graph(j.home_id)->'topology_hash' IS DISTINCT FROM model#>'{basis,topology_hash}'
 THEN RAISE EXCEPTION 'Room capture source policy changed' USING ERRCODE='40001'; END IF;
 revision:=private.lock_room_evidence(j.home_id);
 -- These derived bytes cannot serve the current accepted source scope. Keep
 -- canonical observations and fitted archives untouched; this is dependency
 -- ownership cleanup, not an age-based retention window.
 DELETE FROM private.energy_connected_source_cache c WHERE c.home_id=j.home_id AND c.room_key=room
   AND (c.binding IS DISTINCT FROM v_binding OR c.implementation IS DISTINCT FROM p_implementation OR c.to_at<=p_from);
 -- A fitted response certifies its source policy and source revision. Reuse
 -- only archive blocks within that certificate, with no subsequent dirt.
 IF private.room_evidence_policy_fingerprint(j.home_id,room,v_binding,
      (model#>>'{basis,history_from}')::timestamptz,(model#>>'{basis,history_to}')::timestamptz)=model#>>'{basis,source_policy}' THEN
   INSERT INTO private.energy_planning_room_source_blocks(job_id,room,from_at,to_at,capture,sha256)
   SELECT j.id,p_room,b.from_at,b.to_at,b.capture,b.sha256 FROM private.energy_room_evidence_blocks b
   WHERE b.home_id=j.home_id AND b.customer_id=j.customer_id AND b.room_key=room AND b.binding=v_binding
     AND b.implementation=p_implementation AND b.from_at>=p_from AND b.to_at<=least(p_to,(model#>>'{basis,history_to}')::timestamptz)
     AND b.source_revision<=(model#>>'{basis,source_revision}')::bigint
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
 RETURN json_build_object('next',next_work,'source_revision',revision,'binding',v_binding,'policy',v_policy,'graph',private.room_connection_graph(j.home_id));
END; $$;
REVOKE ALL ON FUNCTION public.freeze_energy_connected_planning_sources(uuid,uuid,bigint,integer,timestamptz,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_energy_connected_planning_sources(uuid,uuid,bigint,integer,timestamptz,timestamptz,text,text) TO service_role;

-- Cache a newly read block only while its pre-read source clock is still valid.
-- A correction racing the read may enter this frozen attempt, but never becomes
-- a reusable cache entry certified against a later clock.
ALTER FUNCTION public.checkpoint_energy_planning_room_capture(uuid,uuid,bigint,integer,jsonb,jsonb,jsonb,jsonb)
 RENAME TO checkpoint_energy_planning_room_capture_before_cache;
ALTER FUNCTION public.checkpoint_energy_planning_room_capture_before_cache(uuid,uuid,bigint,integer,jsonb,jsonb,jsonb,jsonb) SET SCHEMA private;
REVOKE ALL ON FUNCTION private.checkpoint_energy_planning_room_capture_before_cache(uuid,uuid,bigint,integer,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.checkpoint_energy_planning_room_capture(p_home_id uuid,p_job_id uuid,p_fence bigint,p_expected_cursor integer,p_state jsonb,
 p_raw jsonb,p_numeric jsonb,p_source_proof jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE result json; revision bigint;
BEGIN
 result:=private.checkpoint_energy_planning_room_capture_before_cache(p_home_id,p_job_id,p_fence,p_expected_cursor,p_state,p_raw,p_numeric,p_source_proof);
 IF result IS NOT NULL AND p_raw->>'base64' IS NOT NULL AND p_source_proof->>'source_revision' IS NOT NULL THEN
   revision:=(p_source_proof->>'source_revision')::bigint;
   IF revision>=0 AND revision<=private.lock_room_evidence(p_home_id)
     AND NOT private.room_evidence_changed(p_home_id,p_source_proof->>'room_key',revision,
       (p_raw->>'from_at')::timestamptz-interval '1 hour',(p_raw->>'to_at')::timestamptz+interval '1 hour') THEN
     INSERT INTO private.energy_connected_source_cache(home_id,room_key,binding,implementation,policy,from_at,to_at,source_revision,capture,sha256)
     VALUES(p_home_id,p_source_proof->>'room_key',p_source_proof->>'binding',p_source_proof->>'implementation',p_source_proof->>'policy',
       (p_raw->>'from_at')::timestamptz,(p_raw->>'to_at')::timestamptz,revision,decode(p_raw->>'base64','base64'),p_raw->>'sha256')
     ON CONFLICT(home_id,room_key,from_at) DO UPDATE SET binding=EXCLUDED.binding,implementation=EXCLUDED.implementation,policy=EXCLUDED.policy,
       to_at=EXCLUDED.to_at,source_revision=EXCLUDED.source_revision,capture=EXCLUDED.capture,sha256=EXCLUDED.sha256;
   END IF;
 END IF;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.checkpoint_energy_planning_room_capture(uuid,uuid,bigint,integer,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_planning_room_capture(uuid,uuid,bigint,integer,jsonb,jsonb,jsonb,jsonb) TO service_role;
