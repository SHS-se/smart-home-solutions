ALTER TABLE private.energy_planning_runtime ADD COLUMN capture_input_packet bytea;

-- One capture slice has one commit boundary. Validate both cursors before
-- writing source/numerical scratch and release its runtime slice atomically.
CREATE FUNCTION public.checkpoint_energy_owned_room_capture_slice(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_expected_cursor integer,p_runtime_cursor bigint,p_slice_fence bigint,
 p_state jsonb,p_raw jsonb,p_numeric jsonb,p_source_proof jsonb,p_input_packet text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; result json;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence
   OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR UPDATE;
 IF r.job_id IS NULL OR r.phase<>'capture' OR r.cursor IS DISTINCT FROM p_runtime_cursor
   OR r.worker_fence IS DISTINCT FROM p_slice_fence OR r.worker_parent IS DISTINCT FROM p_fence
   OR r.worker_until IS NULL OR r.worker_until<=clock_timestamp() THEN RETURN NULL; END IF;
 result:=public.checkpoint_energy_owned_room_capture(p_home_id,p_job_id,p_fence,p_expected_cursor,p_state,p_raw,p_numeric,p_source_proof);
 IF result IS NULL THEN RETURN NULL; END IF;
 IF r.capture_input_packet IS NULL AND p_input_packet IS NOT NULL THEN
   UPDATE private.energy_planning_runtime SET capture_input_packet=decode(p_input_packet,'base64') WHERE job_id=j.id;
 END IF;
 result:=public.checkpoint_energy_owned_planning_stage(p_home_id,p_job_id,p_fence,p_runtime_cursor,p_slice_fence,'{"phase":"capture"}'::json);
 IF result IS NULL THEN RAISE EXCEPTION 'Owned capture slice lost its runtime fence' USING ERRCODE='40001'; END IF;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.checkpoint_energy_owned_room_capture_slice(uuid,uuid,bigint,integer,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_owned_room_capture_slice(uuid,uuid,bigint,integer,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text)
 TO service_role;

-- Keep the original admission JSON authoritative. Only the executable worker
-- receives its once-compressed immutable copy during repeated capture slices.
CREATE OR REPLACE FUNCTION public.load_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,p_revision text,p_runtime text,p_project_rooms boolean)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; node_payload bytea; use_admitted boolean; archive json; snap json; network json; source json;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR UPDATE;
 IF r.job_id IS NOT NULL AND (r.revision<>p_revision OR r.runtime<>p_runtime) THEN
   DELETE FROM private.energy_planning_runtime WHERE job_id=j.id;
   DELETE FROM private.energy_planning_execution WHERE job_id=j.id;
   r:=NULL;
 END IF;
 IF r.job_id IS NULL THEN
   INSERT INTO private.energy_planning_runtime(job_id,revision,runtime,phase) VALUES(j.id,p_revision,p_runtime,'capture') RETURNING * INTO r;
 END IF;
 IF r.phase IN ('integrate','ready') THEN RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id)); END IF;
 IF r.worker_parent=p_fence AND r.worker_until>clock_timestamp() THEN RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id),'busy',true); END IF;
 UPDATE private.energy_planning_runtime SET worker_fence=worker_fence+1,worker_parent=p_fence,
  worker_until=clock_timestamp()+interval '60 seconds' WHERE job_id=j.id RETURNING * INTO r;
 IF r.phase IN ('prepare','qualify') AND p_project_rooms AND r.proposal_input IS NULL THEN
   SELECT input INTO STRICT archive FROM private.energy_planning_execution WHERE job_id=j.id;
   snap:=archive->'snapshot'; network:=snap->'room_network';
   SELECT json_object_agg(key,value ORDER BY ordinality) INTO snap FROM json_each(snap) WITH ORDINALITY WHERE key<>'room_network';
   UPDATE private.energy_planning_runtime SET proposal_input=private.planning_replace_member(archive,'snapshot',snap),
     proposal_network=CASE WHEN network IS NOT NULL THEN json_build_object('forecast',network->'forecast','nodes',
       (SELECT coalesce(json_agg(private.planning_node_projection(node) ORDER BY ordinality),'[]'::json)
        FROM json_array_elements(network->'nodes') WITH ORDINALITY n(node,ordinality))) END
   WHERE job_id=j.id RETURNING * INTO r;
 END IF;
 IF r.phase='catalog' THEN
   SELECT c.payload,CASE WHEN c.room_key IS NOT NULL THEN json_build_object('key',c.room_key,'node',
     CASE WHEN c.source_room IS NOT NULL THEN e.input#>'{snapshot,room_network,nodes}'->c.source_room END) END
   INTO node_payload,source FROM private.energy_forecast_catalog_nodes c JOIN private.energy_planning_execution e USING(job_id)
   WHERE c.job_id=j.id AND c.node=r.catalog_next;
 END IF;
 use_admitted:=r.phase='capture' AND j.input#>'{snapshot,room_network_capture}' IS NULL;
 RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id),'slice_fence',r.worker_fence,
  'customer_id',j.customer_id,'identity',r.identity,'catalog_next',r.catalog_next,'node_count',r.node_count,
  'use_admitted_input',use_admitted,'model_version',CASE WHEN use_admitted THEN j.input->>'model_version' END,
  'capture_input_packet',CASE WHEN p_project_rooms AND r.phase='capture' THEN replace(encode(r.capture_input_packet,'base64'),E'\n','') END,
  'input',CASE WHEN r.phase='capture' AND NOT use_admitted AND (NOT p_project_rooms OR r.capture_input_packet IS NULL) THEN j.input WHEN p_project_rooms AND (r.phase='prepare' OR (r.phase='qualify' AND r.qualified IS NOT NULL)) THEN r.proposal_input WHEN NOT p_project_rooms AND r.phase IN ('prepare','qualify') THEN
    (SELECT input FROM private.energy_planning_execution WHERE job_id=j.id) END,
  'proposal_network',CASE WHEN p_project_rooms AND r.phase='prepare' THEN r.proposal_network END,
  'forecast',CASE WHEN p_project_rooms AND r.phase='qualify' AND r.qualified IS NOT NULL THEN r.proposal_network->'forecast' END,
  'catalog_source',source,
  'qualified',CASE WHEN r.phase='qualify' THEN replace(encode(r.qualified,'base64'),E'\n','') END,
  'payload',CASE WHEN NOT p_project_rooms OR r.phase IN ('prepare','solve','assemble') THEN replace(encode(r.payload,'base64'),E'\n','') END,
  'context',CASE WHEN r.phase='qualify' AND (NOT p_project_rooms OR r.qualified IS NOT NULL) THEN replace(encode(r.context,'base64'),E'\n','') END,
  'header',CASE WHEN r.phase='catalog' OR (r.phase='qualify' AND r.qualified IS NULL) THEN replace(encode(r.header,'base64'),E'\n','') END,
  'node',replace(encode(node_payload,'base64'),E'\n',''),
  'replicas',CASE WHEN r.phase='qualify' AND r.qualified IS NULL THEN
    (SELECT json_agg(json_build_object('replica',p.replica,'work',replace(encode(p.work,'base64'),E'\n','')) ORDER BY p.replica)
     FROM private.energy_forecast_replicas p WHERE p.job_id=j.id AND p.replica<r.replica_count) END);
END; $$;
