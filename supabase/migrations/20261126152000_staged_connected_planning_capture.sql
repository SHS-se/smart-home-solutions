-- Derived connected-state capture belongs to the existing planning attempt.
-- Accepted commands remain active during bounded source, qualification and
-- numerical requests. All scratch disappears with its normal parent job.
CREATE TABLE private.energy_planning_room_capture (
 job_id uuid PRIMARY KEY REFERENCES private.energy_planning_jobs(id) ON DELETE CASCADE,
 cursor integer NOT NULL CHECK(cursor>=0),
 state jsonb NOT NULL CHECK(jsonb_typeof(state)='object'),
 numeric_capture bytea,
 numeric_sha256 text,
 numeric_from_at timestamptz,
 numeric_header_bytes integer,
 numeric_row_bytes integer,
 numeric_row_count integer
);
CREATE TABLE private.energy_planning_room_source_blocks (
 job_id uuid NOT NULL REFERENCES private.energy_planning_jobs(id) ON DELETE CASCADE,
 room integer NOT NULL CHECK(room>=0),
 from_at timestamptz NOT NULL,
 to_at timestamptz NOT NULL CHECK(to_at>from_at AND to_at<=from_at+interval '240 hours'),
 capture bytea NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(job_id,room,from_at)
);
ALTER TABLE private.energy_planning_room_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_planning_room_source_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_planning_room_capture,private.energy_planning_room_source_blocks FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.get_energy_connected_planning_source_context(
 p_home_id uuid,p_customer_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 SELECT jsonb_build_object('graph',private.room_connection_graph(p_home_id),'binding',c.binding,
   'policy',private.room_evidence_policy_fingerprint(p_home_id,p_room_key,c.binding,p_from,p_to))
 FROM private.energy_room_heating_contexts(p_home_id,false) c
 WHERE c.room_key=p_room_key AND public.energy_home_matches_customer(p_home_id,p_customer_id);
$$;
REVOKE ALL ON FUNCTION public.get_energy_connected_planning_source_context(uuid,uuid,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_connected_planning_source_context(uuid,uuid,text,timestamptz,timestamptz) TO service_role;

CREATE FUNCTION public.load_energy_planning_room_capture(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; p private.energy_planning_room_capture%ROWTYPE; bytes bytea; first_row integer; row_count integer;
BEGIN
 SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id
   AND state='pending' AND fence=p_fence AND lease_until IS NOT NULL;
 IF NOT FOUND OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
 SELECT * INTO p FROM private.energy_planning_room_capture WHERE job_id=j.id;
 IF NOT FOUND THEN RETURN json_build_object('cursor',0,'state',NULL); END IF;
 first_row:=CASE WHEN p.state->>'phase'='process' THEN coalesce((p.state->>'row')::integer,0) ELSE 0 END;
 row_count:=CASE WHEN p.state->>'phase'='assemble' AND p.state#>>'{diagnostics,thermal_state_identified}'='true' THEN 0
   WHEN p.state->>'phase'='process' THEN least(2048,p.numeric_row_count-first_row) ELSE p.numeric_row_count END;
 bytes:=CASE WHEN p.state->>'phase'='process' OR row_count=0 THEN substring(p.numeric_capture FROM 1 FOR p.numeric_header_bytes)
   ||substring(p.numeric_capture FROM p.numeric_header_bytes+first_row*p.numeric_row_bytes+1 FOR row_count*p.numeric_row_bytes)
   ELSE p.numeric_capture END;
 RETURN json_build_object('cursor',p.cursor,'state',CASE WHEN p.state->>'phase' IN ('process','reuse','filter') THEN p.state-'nodes' ELSE p.state END,
   'blocks',CASE WHEN p.state->>'phase'='qualify' THEN
     (SELECT coalesce(json_agg(json_build_object('from_at',b.from_at,'to_at',b.to_at,'sha256',b.sha256,
       'capture',replace(encode(b.capture,'base64'),E'\n','')) ORDER BY b.from_at),'[]'::json)
      FROM private.energy_planning_room_source_blocks b WHERE b.job_id=j.id AND b.room=(p.state->>'room')::integer) END,
   'numeric',CASE WHEN p.state->>'phase' IN ('reuse','process','filter','assemble') THEN json_build_object(
     'capture',CASE WHEN p.state->>'phase'<>'reuse' THEN replace(encode(bytes,'base64'),E'\n','') END,
     'sha256',encode(sha256(bytes),'hex'),'full_sha256',p.numeric_sha256,'from_at',p.numeric_from_at,
     'row_from',first_row,'total_rows',p.numeric_row_count) END);
END; $$;
REVOKE ALL ON FUNCTION public.load_energy_planning_room_capture(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_energy_planning_room_capture(uuid,uuid,bigint) TO service_role;

CREATE FUNCTION public.checkpoint_energy_planning_room_capture(
 p_home_id uuid,p_job_id uuid,p_fence bigint,p_expected_cursor integer,p_state jsonb,
 p_raw jsonb,p_numeric jsonb,p_source_proof jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; prior private.energy_planning_room_capture%ROWTYPE;
 bytes bytea; current_policy text; same_room boolean; same_implementation boolean; source_room text; expected_model jsonb;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence OR j.lease_until IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO prior FROM private.energy_planning_room_capture WHERE job_id=j.id FOR UPDATE;
 IF coalesce(prior.cursor,0) IS DISTINCT FROM p_expected_cursor THEN RETURN NULL; END IF;
 IF jsonb_typeof(p_state) IS DISTINCT FROM 'object' OR p_state->>'version' IS DISTINCT FROM '1'
   OR coalesce(p_state->>'phase','') NOT IN ('source','qualify','reuse','process','filter','assemble','complete')
   OR (p_state->>'room')::integer<0 OR (p_state->>'room')::integer>
     json_array_length(j.input->'snapshot'->'room_network_capture'->'rooms')
 THEN RAISE EXCEPTION 'Invalid connected planning continuation' USING ERRCODE='22023'; END IF;
 p_raw:=nullif(p_raw,'null'::jsonb); p_numeric:=nullif(p_numeric,'null'::jsonb);
 p_source_proof:=nullif(p_source_proof,'null'::jsonb);
 same_implementation:=prior.state->>'version' IS NOT DISTINCT FROM p_state->>'version'
   AND prior.state->>'implementation' IS NOT DISTINCT FROM p_state->>'implementation'
   AND prior.state->>'runtime' IS NOT DISTINCT FROM p_state->>'runtime';
 same_room:=same_implementation AND prior.state->>'room' IS NOT DISTINCT FROM p_state->>'room';
 -- Runtime/implementation changes invalidate all executable scratch, including
 -- an earlier room's posterior. The immutable attempt and accepted controls stay.
 IF prior.job_id IS NOT NULL AND NOT same_implementation THEN
   DELETE FROM private.energy_planning_room_source_blocks WHERE job_id=j.id;
 END IF;
 IF p_raw IS NOT NULL THEN
   IF jsonb_typeof(p_source_proof) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Missing source capture policy'; END IF;
   expected_model:=(j.input->'snapshot'->'room_network_capture'->'rooms'->((p_raw->>'room')::integer)->'connected_exchange')::jsonb;
   source_room:=j.input->'snapshot'->'room_network_capture'->'rooms'->((p_raw->>'room')::integer)->>'key';
   IF source_room IS DISTINCT FROM p_source_proof->>'room_key'
     OR (private.room_connection_graph(j.home_id)->'owner') IS DISTINCT FROM expected_model#>'{basis,graph_owner}'
     OR (private.room_connection_graph(j.home_id)->'revision') IS DISTINCT FROM expected_model#>'{basis,graph_revision}'
     OR (private.room_connection_graph(j.home_id)->'topology_hash') IS DISTINCT FROM expected_model#>'{basis,topology_hash}'
   THEN RAISE EXCEPTION 'Room connections changed during capture' USING ERRCODE='40001'; END IF;
   PERFORM private.lock_room_evidence(j.home_id);
   SELECT private.room_evidence_policy_fingerprint(j.home_id,c.room_key,c.binding,
     (p_source_proof->>'from_at')::timestamptz,(p_source_proof->>'to_at')::timestamptz)
   INTO current_policy FROM private.energy_room_heating_contexts(j.home_id,false) c
   WHERE c.room_key=source_room AND c.binding=p_source_proof->>'binding';
   IF current_policy IS NULL OR current_policy IS DISTINCT FROM p_source_proof->>'policy'
     OR current_policy IS DISTINCT FROM p_state->>'policy'
   THEN RAISE EXCEPTION 'Room source policy changed during capture' USING ERRCODE='40001'; END IF;
   bytes:=decode(p_raw->>'base64','base64');
   IF p_raw->>'sha256' IS DISTINCT FROM encode(sha256(bytes),'hex') THEN RAISE EXCEPTION 'Invalid source capture digest'; END IF;
   INSERT INTO private.energy_planning_room_source_blocks(job_id,room,from_at,to_at,capture,sha256)
   VALUES(j.id,(p_raw->>'room')::integer,(p_raw->>'from_at')::timestamptz,(p_raw->>'to_at')::timestamptz,bytes,p_raw->>'sha256');
 END IF;
 IF p_numeric IS NOT NULL THEN
   bytes:=decode(p_numeric->>'base64','base64');
   IF p_numeric->>'sha256' IS DISTINCT FROM encode(sha256(bytes),'hex') THEN RAISE EXCEPTION 'Invalid numeric capture digest'; END IF;
   IF (p_numeric->>'header_bytes')::integer<0 OR (p_numeric->>'row_bytes')::integer<=0 OR (p_numeric->>'row_count')::integer<0
     OR octet_length(bytes) IS DISTINCT FROM (p_numeric->>'header_bytes')::integer+(p_numeric->>'row_bytes')::integer*(p_numeric->>'row_count')::integer
   THEN RAISE EXCEPTION 'Invalid numeric capture layout'; END IF;
 END IF;
 IF same_implementation AND NOT (p_state ? 'nodes') THEN p_state:=p_state||jsonb_build_object('nodes',prior.state->'nodes'); END IF;
 INSERT INTO private.energy_planning_room_capture(job_id,cursor,state,numeric_capture,numeric_sha256,numeric_from_at,numeric_header_bytes,numeric_row_bytes,numeric_row_count)
 VALUES(j.id,p_expected_cursor+1,p_state,
   CASE WHEN p_numeric IS NOT NULL THEN bytes WHEN same_room THEN prior.numeric_capture END,
   CASE WHEN p_numeric IS NOT NULL THEN p_numeric->>'sha256' WHEN same_room THEN prior.numeric_sha256 END,
   CASE WHEN p_numeric IS NOT NULL THEN (p_numeric->>'from_at')::timestamptz WHEN same_room THEN prior.numeric_from_at END,
   CASE WHEN p_numeric IS NOT NULL THEN (p_numeric->>'header_bytes')::integer WHEN same_room THEN prior.numeric_header_bytes END,
   CASE WHEN p_numeric IS NOT NULL THEN (p_numeric->>'row_bytes')::integer WHEN same_room THEN prior.numeric_row_bytes END,
   CASE WHEN p_numeric IS NOT NULL THEN (p_numeric->>'row_count')::integer WHEN same_room THEN prior.numeric_row_count END)
 ON CONFLICT(job_id) DO UPDATE SET cursor=EXCLUDED.cursor,state=EXCLUDED.state,numeric_capture=EXCLUDED.numeric_capture,
   numeric_sha256=EXCLUDED.numeric_sha256,numeric_from_at=EXCLUDED.numeric_from_at,
   numeric_header_bytes=EXCLUDED.numeric_header_bytes,numeric_row_bytes=EXCLUDED.numeric_row_bytes,numeric_row_count=EXCLUDED.numeric_row_count;
 IF p_numeric IS NOT NULL OR (prior.job_id IS NOT NULL AND NOT same_room) THEN
   DELETE FROM private.energy_planning_room_source_blocks WHERE job_id=j.id AND room=coalesce((prior.state->>'room')::integer,0);
 END IF;
 UPDATE private.energy_planning_jobs SET lease_until=NULL,wake_after=clock_timestamp(),code=NULL,detail=NULL
 WHERE id=j.id RETURNING * INTO j;
 RETURN private.energy_planning_receipt(j);
END; $$;
REVOKE ALL ON FUNCTION public.checkpoint_energy_planning_room_capture(uuid,uuid,bigint,integer,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_planning_room_capture(uuid,uuid,bigint,integer,jsonb,jsonb,jsonb,jsonb) TO service_role;
