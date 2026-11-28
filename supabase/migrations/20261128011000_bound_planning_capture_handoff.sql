-- Keep completed receiver populations out of generic metadata validation.
-- Their exact ordered JSON is attached before this transaction commits. Existing
-- room-capture, parent and slice fences stay unchanged, so an in-flight capture
-- resumes at its completed handoff without repeating any numerical inference.
CREATE OR REPLACE FUNCTION public.checkpoint_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_cursor bigint,p_slice_fence bigint,p_update json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; phase text:=p_update->>'phase';
 page json; item json; offsets integer[]; bytes bytea; next_record integer:=0; n integer:=0; execution_input json; receipt json; source_room integer; key text; selected_keys jsonb; requested_keys jsonb; selected_nodes json; network json; snap json;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR UPDATE;
 IF r.job_id IS NULL OR r.cursor IS DISTINCT FROM p_cursor OR r.worker_fence IS DISTINCT FROM p_slice_fence OR r.worker_parent IS DISTINCT FROM p_fence
  OR r.worker_until IS NULL OR r.worker_until<=clock_timestamp() THEN RETURN NULL; END IF;
 IF NOT(r.phase='capture' AND phase IN ('capture','prepare') OR r.phase='prepare' AND phase IN ('prepare','catalog','solve')
  OR r.phase='catalog' AND phase IN ('catalog','integrate') OR r.phase='qualify' AND phase IN ('integrate','solve','qualify')
  OR r.phase='solve' AND phase='assemble' OR r.phase='assemble' AND phase='ready')
 THEN RAISE EXCEPTION 'Invalid owned planning transition' USING ERRCODE='22023'; END IF;
 IF r.phase='qualify' AND r.proposal_input IS NOT NULL THEN
   IF (phase='solve') IS DISTINCT FROM (r.qualified IS NOT NULL) OR
     (phase='qualify') IS DISTINCT FROM (nullif(p_update->>'qualified','') IS NOT NULL)
   THEN RAISE EXCEPTION 'Invalid qualified forecast transition' USING ERRCODE='22023'; END IF;
 ELSIF phase='qualify' OR p_update->'qualified' IS NOT NULL THEN
   RAISE EXCEPTION 'Unexpected qualified forecast output' USING ERRCODE='22023';
 END IF;
 IF r.phase='catalog' THEN
   IF (p_update->>'node')::integer IS DISTINCT FROM r.catalog_next THEN RAISE EXCEPTION 'Invalid catalog node'; END IF;
   FOR page IN SELECT value FROM json_array_elements(p_update->'pages') LOOP
     bytes:=decode(page->>'bytes','base64');
     SELECT array_agg(value::integer ORDER BY ordinality) INTO offsets FROM json_array_elements_text(page->'offsets') WITH ORDINALITY;
     IF (page->>'first_record')::integer<>next_record OR cardinality(offsets)<>(page->>'count')::integer+1
      OR offsets[1]<>0 OR offsets[cardinality(offsets)]<>octet_length(bytes)
      OR EXISTS(SELECT FROM generate_subscripts(offsets,1) s WHERE s>1 AND offsets[s]<=offsets[s-1])
     THEN RAISE EXCEPTION 'Invalid catalog directory' USING ERRCODE='22023'; END IF;
     INSERT INTO private.energy_forecast_catalog_pages VALUES(j.id,r.catalog_next,next_record,(page->>'count')::integer,offsets,bytes);
     next_record:=next_record+(page->>'count')::integer;
   END LOOP;
   IF next_record IS DISTINCT FROM (p_update->>'count')::integer THEN RAISE EXCEPTION 'Incomplete catalog'; END IF;
   IF r.catalog_identity_prefix IS NOT NULL THEN
     IF json_typeof(p_update->'identity_before_records') IS DISTINCT FROM 'string' OR json_typeof(p_update->'identity_after_records') IS DISTINCT FROM 'string'
       OR right(p_update->>'identity_before_records',1)<>'[' OR left(p_update->>'identity_after_records',1)<>']'
     THEN RAISE EXCEPTION 'Missing catalog record framing' USING ERRCODE='22023'; END IF;
     UPDATE private.energy_forecast_catalog_nodes SET before_records=p_update->>'identity_before_records',after_records=p_update->>'identity_after_records'
       WHERE job_id=j.id AND node=r.catalog_next;
   ELSE DELETE FROM private.energy_forecast_catalog_nodes WHERE job_id=j.id AND node=r.catalog_next;
   END IF;
   r.catalog_next:=r.catalog_next+1;
   IF (phase='integrate') IS DISTINCT FROM (r.catalog_next=r.node_count) THEN RAISE EXCEPTION 'Incomplete catalog stage'; END IF;
 END IF;
 IF r.phase='prepare' AND phase='catalog' THEN
   IF p_update->'node_keys' IS NOT NULL THEN
     IF r.proposal_network IS NULL OR json_typeof(p_update->'node_keys') IS DISTINCT FROM 'array'
       OR json_typeof(p_update->'identity_prefix') IS DISTINCT FROM 'string' OR right(p_update->>'identity_prefix',1)<>'['
       OR p_update->'identity' IS NOT NULL OR p_update->'nodes' IS NOT NULL
     THEN RAISE EXCEPTION 'Invalid forecast catalog sources' USING ERRCODE='22023'; END IF;
     r.catalog_identity_prefix:=p_update->>'identity_prefix';
     FOR item IN SELECT value FROM json_array_elements(p_update->'node_keys') LOOP
       key:=item#>>'{}';
       IF json_typeof(item)<>'string' OR key='' THEN RAISE EXCEPTION 'Invalid catalog source key' USING ERRCODE='22023'; END IF;
       SELECT (ordinality-1)::integer INTO source_room FROM json_array_elements(r.proposal_network->'nodes') WITH ORDINALITY a(node,ordinality) WHERE node->>'key'=key;
       IF source_room IS NULL AND NOT EXISTS(SELECT FROM json_array_elements(r.proposal_input#>'{snapshot,thermal_zones}') z WHERE z->>'key'=key)
       THEN RAISE EXCEPTION 'Unknown catalog source key' USING ERRCODE='22023'; END IF;
       INSERT INTO private.energy_forecast_catalog_nodes(job_id,node,room_key,source_room) VALUES(j.id,n,key,source_room); n:=n+1;
     END LOOP;
     IF n<1 THEN RAISE EXCEPTION 'Missing forecast catalog'; END IF;
     r.node_count:=n;
   ELSE
   FOR item IN SELECT value FROM json_array_elements(p_update->'nodes') LOOP
     INSERT INTO private.energy_forecast_catalog_nodes VALUES(j.id,n,decode(item#>>'{}','base64')); n:=n+1;
   END LOOP;
   IF n<1 OR nullif(p_update->>'identity','') IS NULL THEN RAISE EXCEPTION 'Missing forecast catalog'; END IF;
   r.node_count:=n; r.identity:=p_update->>'identity';
   END IF;
 END IF;
 IF phase='integrate' AND r.phase='catalog' AND r.catalog_identity_prefix IS NOT NULL THEN
   r.identity:=private.planning_catalog_identity(j.id,r.catalog_identity_prefix);
   IF r.identity IS NULL THEN RAISE EXCEPTION 'Missing forecast catalog identity'; END IF;
   DELETE FROM private.energy_forecast_catalog_nodes WHERE job_id=j.id;
   r.catalog_identity_prefix:=NULL;
 END IF;
 IF phase='integrate' THEN
   r.replica_count:=(p_update->>'replica_count')::integer; r.target:=(p_update->>'target')::integer;
   IF r.replica_count NOT IN (1,4) OR r.target<1 OR r.target%r.replica_count<>0
    OR (r.phase='qualify' AND (r.replica_count<> (SELECT replica_count FROM private.energy_planning_runtime WHERE job_id=j.id) OR r.target<= (SELECT target FROM private.energy_planning_runtime WHERE job_id=j.id)))
   THEN RAISE EXCEPTION 'Invalid balanced forecast target'; END IF;
   r.round:=r.round+1;
   INSERT INTO private.energy_forecast_replicas(job_id,replica) SELECT j.id,s FROM generate_series(0,r.replica_count-1)s ON CONFLICT DO NOTHING;
 END IF;
 IF p_update->'forecast_counts' IS NOT NULL AND phase<>'solve' THEN
   RAISE EXCEPTION 'Unexpected forecast counts' USING ERRCODE='22023';
 END IF;
 IF p_update->'use_admitted_input' IS NOT NULL THEN
   IF (p_update->'use_admitted_input')::text IS DISTINCT FROM 'true' OR r.phase<>'capture' OR phase<>'prepare'
     OR p_update->'input' IS NOT NULL OR j.input#>'{snapshot,room_network_capture}' IS NOT NULL
     OR j.input->>'model_version' IS DISTINCT FROM j.context->>'model_version'
   THEN RAISE EXCEPTION 'Invalid use of admitted planning input' USING ERRCODE='22023'; END IF;
   INSERT INTO private.energy_planning_execution(job_id,cursor,input,state)
     SELECT id,1,input,json_build_object('revision',r.revision,'runtime',r.runtime,'progress',json_build_object('stage','prepare'))
     FROM private.energy_planning_jobs WHERE id=j.id ON CONFLICT DO NOTHING;
   IF NOT FOUND THEN RETURN NULL; END IF;
 ELSIF r.phase='capture' AND phase='prepare' THEN
   IF j.input#>'{snapshot,room_network_capture}' IS NULL THEN
     RAISE EXCEPTION 'Completed admission must use the stored planning input' USING ERRCODE='22023';
   END IF;
   execution_input:=p_update->'input';
   IF execution_input IS NULL THEN RAISE EXCEPTION 'Missing completed planning input' USING ERRCODE='22023'; END IF;
   IF p_update->'completed_node_keys' IS NOT NULL THEN
     requested_keys:=(p_update->'completed_node_keys')::jsonb;
     IF jsonb_typeof(requested_keys) IS DISTINCT FROM 'array' OR
       (execution_input#>'{snapshot,room_network,nodes}')::jsonb IS DISTINCT FROM '[]'::jsonb
     THEN RAISE EXCEPTION 'Invalid completed planning node selection' USING ERRCODE='22023'; END IF;
     SELECT coalesce(jsonb_agg(a.node->'key' ORDER BY a.ordinality),'[]'::jsonb),coalesce(json_agg(a.node ORDER BY a.ordinality),'[]'::json)
       INTO selected_keys,selected_nodes FROM private.energy_planning_room_capture c
       CROSS JOIN LATERAL jsonb_array_elements(c.completed_nodes) WITH ORDINALITY a(node,ordinality)
       WHERE c.job_id=j.id AND c.state->>'phase'='complete' AND c.state->>'runtime'=r.runtime
         AND requested_keys ? (a.node->>'key');
     IF selected_keys IS DISTINCT FROM requested_keys OR NOT EXISTS(
       SELECT FROM private.energy_planning_room_capture WHERE job_id=j.id AND state->>'phase'='complete' AND state->>'runtime'=r.runtime)
     THEN RAISE EXCEPTION 'Completed planning nodes do not match the captured receivers' USING ERRCODE='22023'; END IF;
   END IF;
   receipt:=public.checkpoint_energy_planning_execution(p_home_id,p_job_id,p_fence,0,execution_input,
     json_build_object('revision',r.revision,'runtime',r.runtime,'progress',json_build_object('stage','prepare')));
   IF receipt IS NULL THEN RETURN NULL; END IF;
   IF selected_nodes IS NOT NULL THEN
     -- Generic immutability checks need only this compact input. Attach the
     -- already authenticated populations after those checks, in the same TX;
     -- no observer can see the intermediate empty node array. The checked
     -- snapshot ID, model version and all fields outside snapshot are unchanged.
     snap:=execution_input->'snapshot'; network:=private.planning_replace_member(snap->'room_network','nodes',selected_nodes);
     execution_input:=private.planning_replace_member(execution_input,'snapshot',private.planning_replace_member(snap,'room_network',network));
     UPDATE private.energy_planning_execution SET input=execution_input WHERE job_id=j.id AND cursor=1;
     IF NOT FOUND THEN RAISE EXCEPTION 'Missing initial planning execution' USING ERRCODE='22023'; END IF;
   END IF;
   UPDATE private.energy_planning_jobs SET lease_until=j.lease_until WHERE id=j.id AND fence=p_fence AND state='pending';
 ELSIF p_update->'input' IS NOT NULL THEN
   RAISE EXCEPTION 'Unexpected execution input' USING ERRCODE='22023';
 ELSIF phase='solve' THEN
   IF p_update->'forecast_counts' IS NULL THEN RAISE EXCEPTION 'Missing forecast count decision' USING ERRCODE='22023'; END IF;
   UPDATE private.energy_planning_execution SET cursor=cursor+1,
     input=private.planning_resolve_forecast_counts(input,p_update->'forecast_counts'),
     state=json_build_object('revision',r.revision,'runtime',r.runtime,'progress',json_build_object('stage','solve'))
   WHERE job_id=j.id AND cursor=1 AND state#>>'{progress,stage}'='prepare' AND state->>'revision'=r.revision AND state->>'runtime'=r.runtime;
   IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 UPDATE private.energy_planning_runtime SET cursor=r.cursor+1,
  worker_until=NULL,identity=r.identity,catalog_identity_prefix=r.catalog_identity_prefix,
  qualified=CASE WHEN p_update->>'phase'='qualify' THEN decode(p_update->>'qualified','base64') END,node_count=r.node_count,catalog_next=r.catalog_next,round=r.round,target=r.target,replica_count=r.replica_count,
  payload=CASE WHEN p_update->'payload' IS NOT NULL THEN decode(p_update->>'payload','base64') ELSE payload END,
  context=CASE WHEN p_update->'context' IS NOT NULL THEN decode(p_update->>'context','base64') ELSE context END,
  header=CASE WHEN p_update->'header' IS NOT NULL THEN decode(p_update->>'header','base64') ELSE header END
 WHERE job_id=j.id;
 -- Avoid PL/pgSQL identifier ambiguity with the phase column.
 UPDATE private.energy_planning_runtime SET phase=p_update->>'phase' WHERE job_id=j.id;
 RETURN private.owned_planning_dispatch(j.id);
END; $$;
