-- Only the catalog action for one receiver consumes its hypothesis population.
-- The execution archive retains the exact original JSON for replay and sealing.
ALTER TABLE private.energy_planning_runtime ADD COLUMN proposal_input json, ADD COLUMN proposal_network json,
 ADD COLUMN catalog_identity_prefix text, ADD COLUMN qualified bytea;
ALTER TABLE private.energy_forecast_catalog_nodes ALTER COLUMN payload DROP NOT NULL,
 ADD COLUMN room_key text, ADD COLUMN source_room integer,
 ADD COLUMN before_records text, ADD COLUMN after_records text;
CREATE UNIQUE INDEX energy_forecast_catalog_room_key ON private.energy_forecast_catalog_nodes(job_id,room_key);

CREATE FUNCTION private.planning_node_projection(node json) RETURNS json
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 WITH edges AS MATERIALIZED (
   SELECT edge->>'from' AS peer, edge->>'kind'<>'constant' OR (edge->>'per_h')::numeric>0 AS active,
     h.ordinality AS hpos,e.ordinality AS epos FROM json_array_elements(node#>'{process_belief,hypotheses}')
     WITH ORDINALITY h(hypothesis,ordinality) CROSS JOIN LATERAL json_array_elements(hypothesis->'incoming') WITH ORDINALITY e(edge,ordinality)
 ), required AS (
   SELECT peer,0 AS section,hpos,epos FROM edges WHERE active
   UNION ALL SELECT prior->>'from',1,ordinality,0 FROM json_array_elements(node#>'{process_belief,reset_priors}') WITH ORDINALITY r(prior,ordinality)
 ), unique_required AS (
   SELECT DISTINCT ON(peer COLLATE "C") * FROM required ORDER BY peer COLLATE "C",section,hpos,epos
 ), unique_edges AS (
   SELECT DISTINCT ON(peer COLLATE "C") * FROM edges ORDER BY peer COLLATE "C",hpos,epos
 )
 SELECT json_object_agg(key,value ORDER BY section,pos) FROM (
   SELECT key,value,0 AS section,ordinality AS pos FROM json_each(node) WITH ORDINALITY WHERE key<>'process_belief'
   UNION ALL SELECT 'required_peers',coalesce(json_agg(peer ORDER BY section,hpos,epos),'[]'::json),1,0 FROM unique_required
   UNION ALL SELECT 'hypothesis_peers',coalesce(json_agg(peer ORDER BY hpos,epos),'[]'::json),1,1 FROM unique_edges
 ) members;
$$;
REVOKE ALL ON FUNCTION private.planning_node_projection(json) FROM PUBLIC,anon,authenticated,service_role;

-- The owned completion worker closes graph dependencies and adjusts zone starts;
-- the already stored receiver populations stay in the database.
CREATE FUNCTION public.load_energy_planning_room_capture(p_home_id uuid,p_job_id uuid,p_fence bigint,p_node_delta boolean,p_project_completed boolean)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; p private.energy_planning_room_capture%ROWTYPE;
BEGIN
 IF p_project_completed THEN
   SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id
     AND state='pending' AND fence=p_fence AND lease_until>clock_timestamp();
   IF NOT FOUND OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
   SELECT * INTO p FROM private.energy_planning_room_capture WHERE job_id=j.id AND state->>'phase'='complete';
   IF FOUND THEN RETURN json_build_object('cursor',p.cursor,'state',p.state,'completed_headers',
     (SELECT coalesce(json_agg(json_build_object('key',n->'key','start_temperature_c',n->'start_temperature_c',
       'start_stored_heat_c',n->'start_stored_heat_c','required_peers',private.planning_node_projection(n::json)->'required_peers')
       ORDER BY ordinality),'[]'::json) FROM jsonb_array_elements(p.completed_nodes) WITH ORDINALITY a(n,ordinality))); END IF;
 END IF;
 RETURN public.load_energy_planning_room_capture(p_home_id,p_job_id,p_fence,p_node_delta);
END; $$;
REVOKE ALL ON FUNCTION public.load_energy_planning_room_capture(uuid,uuid,bigint,boolean,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_energy_planning_room_capture(uuid,uuid,bigint,boolean,boolean) TO service_role;

-- Page offsets describe joined UTF-8 records without delimiters. Reuse these
-- bytes verbatim; JSONB numeric repr and key ordering are not the JS digest.
CREATE FUNCTION private.planning_catalog_identity(p_job uuid,p_prefix text) RETURNS text
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,private AS $$
 SELECT encode(sha256(convert_to(p_prefix,'UTF8') ||
     string_agg(convert_to(n.before_records,'UTF8') || coalesce(records.body,''::bytea) || convert_to(n.after_records,'UTF8'),
       ','::bytea ORDER BY n.node)||']}'::bytea),'hex')
 FROM private.energy_forecast_catalog_nodes n LEFT JOIN LATERAL (
   SELECT string_agg(substring(p.payload FROM p.offsets[i]+1 FOR p.offsets[i+1]-p.offsets[i]),
     ','::bytea ORDER BY p.first_record,i) AS body
   FROM private.energy_forecast_catalog_pages p CROSS JOIN LATERAL generate_series(1,p.count) i
   WHERE p.job_id=n.job_id AND p.node=n.node
 ) records ON true WHERE n.job_id=p_job;
$$;
REVOKE ALL ON FUNCTION private.planning_catalog_identity(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.load_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,p_revision text,p_runtime text,p_project_rooms boolean)
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
  'input',CASE WHEN r.phase='capture' AND NOT use_admitted THEN j.input WHEN p_project_rooms AND (r.phase='prepare' OR (r.phase='qualify' AND r.qualified IS NOT NULL)) THEN r.proposal_input WHEN NOT p_project_rooms AND r.phase IN ('prepare','qualify') THEN
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

REVOKE ALL ON FUNCTION public.load_energy_owned_planning_stage(uuid,uuid,bigint,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_energy_owned_planning_stage(uuid,uuid,bigint,text,text,boolean) TO service_role;
CREATE OR REPLACE FUNCTION public.load_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,p_revision text,p_runtime text)
RETURNS json LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='8s' AS $$
 SELECT public.load_energy_owned_planning_stage(p_home_id,p_job_id,p_fence,p_revision,p_runtime,false);
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_cursor bigint,p_slice_fence bigint,p_update json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; phase text:=p_update->>'phase';
 page json; item json; offsets integer[]; bytes bytea; next_record integer:=0; n integer:=0; execution_input json; receipt json; source_room integer; key text; selected_keys jsonb; selected_nodes json; network json; snap json;
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
     IF json_typeof(p_update->'completed_node_keys') IS DISTINCT FROM 'array' OR
       (execution_input#>'{snapshot,room_network,nodes}')::jsonb IS DISTINCT FROM '[]'::jsonb
     THEN RAISE EXCEPTION 'Invalid completed planning node selection' USING ERRCODE='22023'; END IF;
     SELECT coalesce(jsonb_agg(a.node->'key' ORDER BY a.ordinality),'[]'::jsonb),coalesce(json_agg(a.node ORDER BY a.ordinality),'[]'::json)
       INTO selected_keys,selected_nodes FROM private.energy_planning_room_capture c
       CROSS JOIN LATERAL jsonb_array_elements(c.completed_nodes) WITH ORDINALITY a(node,ordinality)
       WHERE c.job_id=j.id AND c.state->>'phase'='complete' AND c.state->>'runtime'=r.runtime
         AND (p_update->'completed_node_keys')::jsonb ? (a.node->>'key');
     IF selected_keys IS DISTINCT FROM (p_update->'completed_node_keys')::jsonb OR NOT EXISTS(
       SELECT FROM private.energy_planning_room_capture WHERE job_id=j.id AND state->>'phase'='complete' AND state->>'runtime'=r.runtime)
     THEN RAISE EXCEPTION 'Completed planning nodes do not match the captured receivers' USING ERRCODE='22023'; END IF;
     snap:=execution_input->'snapshot'; network:=private.planning_replace_member(snap->'room_network','nodes',selected_nodes);
     execution_input:=private.planning_replace_member(execution_input,'snapshot',private.planning_replace_member(snap,'room_network',network));
   END IF;
   receipt:=public.checkpoint_energy_planning_execution(p_home_id,p_job_id,p_fence,0,execution_input,
     json_build_object('revision',r.revision,'runtime',r.runtime,'progress',json_build_object('stage','prepare')));
   IF receipt IS NULL THEN RETURN NULL; END IF;
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
