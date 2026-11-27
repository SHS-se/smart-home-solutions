-- Admission selects thermal responses and graph identities. Their posterior
-- populations belong to the receiving room and are frozen when its job is accepted.
CREATE FUNCTION public.capture_energy_device_models(p_home_id uuid,p_connected_headers boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 WITH contexts AS MATERIALIZED (
   SELECT c.room_key,private.room_context_metadata(p_home_id,c.room_key,c.binding,c.observed_since) AS value
   FROM private.energy_room_heating_contexts(p_home_id,false) c
 )
 SELECT jsonb_build_object(
   'rooms',coalesce((SELECT jsonb_agg(CASE WHEN p_connected_headers
       AND jsonb_typeof(m.heating_bands#>'{reference,connected_exchange}')='object'
       AND (m.heating_bands#>'{reference,connected_exchange}') ? 'process_belief' THEN
       (to_jsonb(m)#-'{heating_bands,reference,connected_exchange,process_belief}')
       ||jsonb_build_object('connected_reference',jsonb_build_object(
         'revision',m.heating_bands->'reference_revision','binding',m.heating_bands->'binding'))
       ELSE to_jsonb(m) END ORDER BY m.room_key)
     FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id),'[]'::jsonb),
   'pool',(SELECT to_jsonb(m) FROM public.energy_optimisation_pool_model m WHERE m.home_id=p_home_id),
   'devices',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY device_key) FROM public.energy_optimisation_device_operating_points m WHERE home_id=p_home_id),'[]'::jsonb),
   'room_heating',coalesce((SELECT jsonb_object_agg(room_key,value) FROM contexts WHERE value->'observed_only'='false'::jsonb),'{}'::jsonb),
   'room_observed',coalesce((SELECT jsonb_object_agg(room_key,value) FROM contexts WHERE value->'observed_only'='true'::jsonb),'{}'::jsonb),
   'room_graph',private.room_connection_graph(p_home_id));
$$;
REVOKE ALL ON FUNCTION public.capture_energy_device_models(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.capture_energy_device_models(uuid,boolean) TO service_role;
-- A worker already running when the database deploys still owns its complete input.
CREATE OR REPLACE FUNCTION public.capture_energy_device_models(p_home_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.capture_energy_device_models(p_home_id,false);
$$;

CREATE TABLE private.energy_planning_room_beliefs (
 job_id uuid NOT NULL REFERENCES private.energy_planning_jobs(id) ON DELETE CASCADE,
 room integer NOT NULL CHECK(room>=0),
 belief jsonb NOT NULL,
 PRIMARY KEY(job_id,room)
);
ALTER TABLE private.energy_planning_room_beliefs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_planning_room_beliefs FROM PUBLIC,anon,authenticated,service_role;

-- Receipt deduplication returns before the INSERT. A failed pin rolls the whole
-- admission back, including its attempt to supersede a previous plan.
CREATE FUNCTION private.freeze_planning_room_beliefs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,private AS $$
DECLARE receiver record; revision bigint; library jsonb; model jsonb;
BEGIN
 FOR receiver IN
   WITH contexts AS MATERIALIZED (SELECT room_key,binding FROM private.energy_room_heating_contexts(NEW.home_id,false))
   SELECT r.room,r.ordinality-1 AS ordinal,c.binding FROM json_array_elements(NEW.input#>'{snapshot,room_network_capture,rooms}')
     WITH ORDINALITY AS r(room,ordinality) LEFT JOIN contexts c ON c.room_key=r.room->>'key'
   WHERE r.room->'connected_reference' IS NOT NULL
 LOOP
   SELECT m.model_revision,m.heating_bands INTO revision,library FROM public.energy_optimisation_zone_models m
     WHERE m.home_id=NEW.home_id AND m.room_key=receiver.room->>'key' FOR SHARE;
   model:=library#>'{reference,connected_exchange}';
   IF revision IS NULL OR to_jsonb(revision) IS DISTINCT FROM (NEW.context->'model_revisions'->'rooms'->(receiver.room->>'key'))::jsonb
     OR receiver.binding IS NULL OR receiver.binding IS DISTINCT FROM library->>'binding'
     OR (receiver.room->'connected_reference')::jsonb IS DISTINCT FROM
       jsonb_build_object('revision',library->'reference_revision','binding',library->'binding')
     OR jsonb_typeof(model) IS DISTINCT FROM 'object' OR NOT (model ? 'process_belief')
     OR model-'process_belief' IS DISTINCT FROM (receiver.room->'connected_exchange')::jsonb
   THEN RAISE EXCEPTION 'Accepted room response changed during preparation' USING ERRCODE='P4091'; END IF;
   INSERT INTO private.energy_planning_room_beliefs(job_id,room,belief) VALUES(NEW.id,receiver.ordinal,model->'process_belief');
 END LOOP;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION private.freeze_planning_room_beliefs() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER freeze_planning_room_beliefs AFTER INSERT ON private.energy_planning_jobs
 FOR EACH ROW WHEN(json_typeof(NEW.input#>'{snapshot,room_network_capture,rooms}')='array')
 EXECUTE FUNCTION private.freeze_planning_room_beliefs();

-- Completed receiver populations remain TOASTed across numerical and source
-- checkpoints. Existing pending attempts keep their exact accumulated vector.
ALTER TABLE private.energy_planning_room_capture ADD COLUMN completed_nodes jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE private.energy_planning_room_capture SET completed_nodes=coalesce(nullif(state->'nodes','null'::jsonb),'[]'::jsonb),state=state-'nodes'
 WHERE state ? 'nodes';

CREATE FUNCTION public.load_energy_planning_room_capture(p_home_id uuid,p_job_id uuid,p_fence bigint,p_node_delta boolean)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; p private.energy_planning_room_capture%ROWTYPE; bytes bytea; first_row integer; row_count integer;
 frozen_model jsonb; phase text; room_index integer;
BEGIN
 SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id
   AND state='pending' AND fence=p_fence AND lease_until>clock_timestamp();
 IF NOT FOUND OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
 SELECT * INTO p FROM private.energy_planning_room_capture WHERE job_id=j.id;
 IF NOT FOUND THEN RETURN json_build_object('cursor',0,'state',NULL); END IF;
 phase:=p.state->>'phase'; room_index:=(p.state->>'room')::integer;
 IF phase='qualify' OR (phase='assemble' AND p.state->>'process_response' IS NULL) THEN
   SELECT (j.input#>'{snapshot,room_network_capture,rooms}'->room_index->'connected_exchange')::jsonb
      ||jsonb_build_object('process_belief',b.belief) INTO frozen_model
     FROM private.energy_planning_room_beliefs b WHERE b.job_id=j.id AND b.room=room_index;
 END IF;
 first_row:=CASE WHEN phase='process' THEN coalesce((p.state->>'row')::integer,0) ELSE 0 END;
 row_count:=CASE WHEN phase='assemble' AND p.state#>>'{diagnostics,thermal_state_identified}'='true' THEN 0
   WHEN phase='process' THEN least(2048,p.numeric_row_count-first_row) ELSE p.numeric_row_count END;
 IF phase IN ('reuse','process','filter','assemble') THEN
   bytes:=CASE WHEN phase='process' OR row_count=0 THEN substring(p.numeric_capture FROM 1 FOR p.numeric_header_bytes)
     ||substring(p.numeric_capture FROM p.numeric_header_bytes+first_row*p.numeric_row_bytes+1 FOR row_count*p.numeric_row_bytes)
     ELSE p.numeric_capture END;
 END IF;
 RETURN json_build_object('cursor',p.cursor,'state',CASE WHEN phase='complete' OR (NOT p_node_delta AND phase IN ('assemble','source','qualify')) THEN p.state||jsonb_build_object('nodes',p.completed_nodes) ELSE p.state END,
   'frozen_model',frozen_model,
   'blocks',CASE WHEN phase='qualify' THEN
     (SELECT coalesce(json_agg(json_build_object('from_at',b.from_at,'to_at',b.to_at,'sha256',b.sha256,
       'capture',replace(encode(b.capture,'base64'),E'\n','')) ORDER BY b.from_at),'[]'::json)
      FROM private.energy_planning_room_source_blocks b WHERE b.job_id=j.id AND b.room=room_index) END,
   'numeric',CASE WHEN phase IN ('reuse','process','filter','assemble') THEN json_build_object(
     'capture',CASE WHEN phase<>'reuse' THEN replace(encode(bytes,'base64'),E'\n','') END,
     'sha256',encode(sha256(bytes),'hex'),'full_sha256',p.numeric_sha256,'from_at',p.numeric_from_at,
     'row_from',first_row,'total_rows',p.numeric_row_count) END);
END; $$;

REVOKE ALL ON FUNCTION public.load_energy_planning_room_capture(uuid,uuid,bigint,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_energy_planning_room_capture(uuid,uuid,bigint,boolean) TO service_role;
CREATE OR REPLACE FUNCTION public.load_energy_planning_room_capture(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='8s' AS $$
 SELECT public.load_energy_planning_room_capture(p_home_id,p_job_id,p_fence,false);
$$;

CREATE OR REPLACE FUNCTION private.checkpoint_energy_planning_room_capture_before_cache(
 p_home_id uuid,p_job_id uuid,p_fence bigint,p_expected_cursor integer,p_state jsonb,
 p_raw jsonb,p_numeric jsonb,p_source_proof jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; prior private.energy_planning_room_capture%ROWTYPE;
 bytes bytea; current_policy text; same_room boolean; same_implementation boolean; source_room text; expected_model jsonb; replacement_nodes jsonb;
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
 -- Assembly appends just this receiver. The same job lock and cursor guard
 -- that own the numerical checkpoint also own the previously assembled nodes.
 IF p_state ? 'completed_nodes' THEN
   IF NOT coalesce(same_implementation,false) OR prior.state->>'phase' IS DISTINCT FROM 'assemble'
     OR (p_state->>'room')::integer IS DISTINCT FROM (prior.state->>'room')::integer+1
     OR p_state->>'phase' IS DISTINCT FROM (CASE WHEN (p_state->>'room')::integer=
       json_array_length(j.input#>'{snapshot,room_network_capture,rooms}') THEN 'complete' ELSE 'source' END)
     OR p_state ? 'nodes' OR jsonb_typeof(p_state->'completed_nodes') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'Invalid completed room node transition' USING ERRCODE='22023'; END IF;
   IF jsonb_array_length(p_state->'completed_nodes')>1 OR
      (jsonb_array_length(p_state->'completed_nodes')=1 AND p_state#>>'{completed_nodes,0,key}' IS DISTINCT FROM
        j.input#>'{snapshot,room_network_capture,rooms}'->((prior.state->>'room')::integer)->>'key')
   THEN RAISE EXCEPTION 'Invalid completed room node' USING ERRCODE='22023'; END IF;
   IF jsonb_array_length(p_state->'completed_nodes')>0 THEN replacement_nodes:=prior.completed_nodes||(p_state->'completed_nodes'); END IF;
 ELSIF p_state ? 'nodes' THEN replacement_nodes:=coalesce(nullif(p_state->'nodes','null'::jsonb),'[]'::jsonb);
 ELSIF NOT same_implementation THEN replacement_nodes:='[]'::jsonb;
 END IF;
 p_state:=p_state-ARRAY['nodes','completed_nodes'];
 INSERT INTO private.energy_planning_room_capture(job_id,cursor,state,completed_nodes,numeric_capture,numeric_sha256,numeric_from_at,numeric_header_bytes,numeric_row_bytes,numeric_row_count)
 VALUES(j.id,p_expected_cursor+1,p_state,coalesce(replacement_nodes,'[]'::jsonb),
   CASE WHEN p_numeric IS NOT NULL THEN bytes WHEN same_room THEN prior.numeric_capture END,
   CASE WHEN p_numeric IS NOT NULL THEN p_numeric->>'sha256' WHEN same_room THEN prior.numeric_sha256 END,
   CASE WHEN p_numeric IS NOT NULL THEN (p_numeric->>'from_at')::timestamptz WHEN same_room THEN prior.numeric_from_at END,
   CASE WHEN p_numeric IS NOT NULL THEN (p_numeric->>'header_bytes')::integer WHEN same_room THEN prior.numeric_header_bytes END,
   CASE WHEN p_numeric IS NOT NULL THEN (p_numeric->>'row_bytes')::integer WHEN same_room THEN prior.numeric_row_bytes END,
   CASE WHEN p_numeric IS NOT NULL THEN (p_numeric->>'row_count')::integer WHEN same_room THEN prior.numeric_row_count END)
 ON CONFLICT(job_id) DO UPDATE SET cursor=EXCLUDED.cursor,state=EXCLUDED.state,
   completed_nodes=CASE WHEN replacement_nodes IS NULL THEN energy_planning_room_capture.completed_nodes ELSE EXCLUDED.completed_nodes END,
   numeric_capture=EXCLUDED.numeric_capture,
   numeric_sha256=EXCLUDED.numeric_sha256,numeric_from_at=EXCLUDED.numeric_from_at,
   numeric_header_bytes=EXCLUDED.numeric_header_bytes,numeric_row_bytes=EXCLUDED.numeric_row_bytes,numeric_row_count=EXCLUDED.numeric_row_count;
 IF p_numeric IS NOT NULL OR (prior.job_id IS NOT NULL AND NOT same_room) THEN
   DELETE FROM private.energy_planning_room_source_blocks WHERE job_id=j.id AND room=coalesce((prior.state->>'room')::integer,0);
 END IF;
 UPDATE private.energy_planning_jobs SET lease_until=NULL,wake_after=clock_timestamp(),code=NULL,detail=NULL
 WHERE id=j.id RETURNING * INTO j;
 RETURN private.energy_planning_receipt(j);
END; $$;

CREATE OR REPLACE FUNCTION private.clean_owned_planning_scratch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'pending' THEN
  DELETE FROM private.energy_planning_room_beliefs WHERE job_id=NEW.id;
  DELETE FROM private.energy_planning_runtime WHERE job_id=NEW.id;
  DELETE FROM private.energy_planning_room_source_blocks WHERE job_id=NEW.id;
  DELETE FROM private.energy_planning_room_capture WHERE job_id=NEW.id;
  IF NEW.state<>'published' THEN DELETE FROM private.energy_planning_execution WHERE job_id=NEW.id; END IF;
 END IF;
 RETURN NEW;
END; $$;
