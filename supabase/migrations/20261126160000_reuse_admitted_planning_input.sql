-- Frozen execution inputs retain their JSON bytes. When encodings differ, compare
-- values without expanding the entire posterior population into one JSONB tree.
-- Each object key has JSONB's last-value semantics; array position is significant.
CREATE FUNCTION private.planning_json_matches(a json,b json,omit text[] DEFAULT '{}')
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,private AS $$
DECLARE member record; kind text;
BEGIN
 IF a IS NULL OR b IS NULL THEN RETURN a IS NULL AND b IS NULL; END IF;
 IF a::text COLLATE "C" = b::text COLLATE "C" THEN RETURN true; END IF;
 -- Compare small complete subtrees in one native operation. Larger values
 -- remain valid and are compared member-by-member when their encodings differ.
 IF cardinality(omit)=0 AND octet_length(a::text)<=8192 AND octet_length(b::text)<=8192 THEN
   RETURN a::jsonb=b::jsonb;
 END IF;
 kind:=json_typeof(a);
 IF kind IS DISTINCT FROM json_typeof(b) THEN RETURN false; END IF;
 IF kind='object' THEN
   FOR member IN
     SELECT coalesce(l.key,r.key) AS key,l.value AS lhs,r.value AS rhs FROM
       (SELECT DISTINCT ON (key COLLATE "C") key,value FROM json_each(a) WITH ORDINALITY
        WHERE cardinality(omit)<>1 OR key IS DISTINCT FROM omit[1] ORDER BY key COLLATE "C",ordinality DESC) l
       FULL JOIN
       (SELECT DISTINCT ON (key COLLATE "C") key,value FROM json_each(b) WITH ORDINALITY
        WHERE cardinality(omit)<>1 OR key IS DISTINCT FROM omit[1] ORDER BY key COLLATE "C",ordinality DESC) r
       ON l.key COLLATE "C" = r.key COLLATE "C"
   LOOP
     IF NOT private.planning_json_matches(member.lhs,member.rhs,
       CASE WHEN member.key=omit[1] THEN omit[2:] ELSE '{}'::text[] END)
     THEN RETURN false; END IF;
   END LOOP;
 ELSIF kind='array' THEN
   FOR member IN SELECT * FROM ROWS FROM(json_array_elements(a),json_array_elements(b)) AS elements(lhs,rhs) LOOP
     IF NOT private.planning_json_matches(member.lhs,member.rhs) THEN RETURN false; END IF;
   END LOOP;
 ELSE
   RETURN a::jsonb=b::jsonb;
 END IF;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION private.planning_json_matches(json,json,text[]) FROM PUBLIC,anon,authenticated,service_role;

-- Rebuilding an object preserves member order and untouched JSON values, including
-- noncanonical numeric spellings. Only the three forecast count fields are new.
CREATE FUNCTION private.planning_replace_member(document json,member text,replacement json)
RETURNS json LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT json_object_agg(key,CASE WHEN key=member THEN replacement ELSE value END ORDER BY ordinality)
 FROM json_each(document) WITH ORDINALITY
$$;
CREATE FUNCTION private.planning_resolve_forecast_counts(original json,counts json)
RETURNS json LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,private AS $$
DECLARE snap json; network json; forecast json; draws numeric; paths numeric; totals numeric; replicas json;
BEGIN
 IF json_typeof(counts)='null' THEN RETURN original; END IF;
 IF json_typeof(counts) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid forecast counts' USING ERRCODE='22023'; END IF;
 snap:=original->'snapshot'; network:=snap->'room_network'; forecast:=network->'forecast';
 IF json_typeof(forecast) IS DISTINCT FROM 'object' OR forecast->'trajectories' IS NOT NULL
    OR (SELECT count(*) FROM json_each(counts))<>3
    OR json_typeof(counts->'trajectories') IS DISTINCT FROM 'number'
    OR json_typeof(counts->'replayed_paths') IS DISTINCT FROM 'number'
    OR json_typeof(counts->'replicate_trajectories') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'Invalid forecast counts' USING ERRCODE='22023'; END IF;
 draws:=(counts->>'trajectories')::numeric; paths:=(counts->>'replayed_paths')::numeric; replicas:=counts->'replicate_trajectories';
 IF draws<>trunc(draws) OR draws<1 OR paths<>trunc(paths) OR paths<draws OR paths>9007199254740991
    OR json_array_length(replicas) IS DISTINCT FROM (forecast->>'replicates')::integer
    OR EXISTS(SELECT FROM json_array_elements(replicas) x WHERE json_typeof(x)<>'number')
 THEN RAISE EXCEPTION 'Invalid forecast counts' USING ERRCODE='22023'; END IF;
 SELECT sum(value::numeric) INTO totals FROM json_array_elements_text(replicas);
 IF draws IS DISTINCT FROM totals OR EXISTS(SELECT FROM json_array_elements_text(replicas) WHERE value::numeric<0 OR value::numeric<>trunc(value::numeric))
 THEN RAISE EXCEPTION 'Invalid forecast counts' USING ERRCODE='22023'; END IF;
 SELECT json_object_agg(key,value ORDER BY section,position) INTO forecast FROM (
   SELECT 0 AS section,ordinality AS position,key,value FROM json_each(forecast) WITH ORDINALITY
   UNION ALL SELECT 1,ordinality,key,value FROM json_each(counts) WITH ORDINALITY
 ) f;
 RETURN private.planning_replace_member(original,'snapshot',private.planning_replace_member(snap,'room_network',
   private.planning_replace_member(network,'forecast',forecast)));
END; $$;
REVOKE ALL ON FUNCTION private.planning_replace_member(json,text,json),private.planning_resolve_forecast_counts(json,json)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_energy_planning_execution(
 p_home_id uuid,p_job_id uuid,p_fence bigint,p_expected_cursor integer,p_input json,p_state json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; prior private.energy_planning_execution%ROWTYPE;
 before_stage text; next_stage text; before_room integer; next_room integer; before_work bigint; next_work bigint;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence OR j.lease_until IS NULL
   OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
 SELECT * INTO prior FROM private.energy_planning_execution WHERE job_id=j.id FOR UPDATE;
 IF coalesce(prior.cursor,0) IS DISTINCT FROM p_expected_cursor THEN RETURN NULL; END IF;
 next_stage:=p_state#>>'{progress,stage}';
 IF json_typeof(p_input) IS DISTINCT FROM 'object' OR json_typeof(p_state) IS DISTINCT FROM 'object'
   OR nullif(p_state->>'revision','') IS NULL OR nullif(p_state->>'runtime','') IS NULL
   OR coalesce(next_stage,'') NOT IN ('prepare','solve','assemble')
   OR NOT private.planning_json_matches(p_input,j.input,ARRAY['snapshot'])
   OR p_input#>>'{snapshot,snapshot_id}' IS DISTINCT FROM j.input#>>'{snapshot,snapshot_id}'
   OR p_input#>'{snapshot,room_network_capture}' IS NOT NULL
   OR p_input->>'model_version' IS DISTINCT FROM j.context->>'model_version'
 THEN RAISE EXCEPTION 'Invalid frozen planning execution' USING ERRCODE='22023'; END IF;
 -- Native preparation may resolve only the trajectory counts. All captured
 -- physical/source inputs and numerical seed/policy/runtime stay immutable.
 IF prior.job_id IS NOT NULL AND p_input::text COLLATE "C" <> prior.input::text COLLATE "C" THEN
   IF NOT private.planning_json_matches(prior.input,p_input,ARRAY['snapshot','room_network','forecast']) THEN
     RAISE EXCEPTION 'Invalid frozen planning execution' USING ERRCODE='22023';
   END IF;
   IF NOT private.planning_json_matches(prior.input#>'{snapshot,room_network,forecast}',p_input#>'{snapshot,room_network,forecast}') THEN
     IF prior.state#>>'{progress,stage}' IS DISTINCT FROM 'prepare' OR next_stage<>'solve'
       OR (prior.input#>'{snapshot,room_network,forecast}')::jsonb ? 'trajectories'
       OR ((prior.input#>'{snapshot,room_network,forecast}')::jsonb-ARRAY['trajectories','replicate_trajectories','replayed_paths'])
          IS DISTINCT FROM ((p_input#>'{snapshot,room_network,forecast}')::jsonb-ARRAY['trajectories','replicate_trajectories','replayed_paths'])
       OR json_typeof(p_input#>'{snapshot,room_network,forecast,trajectories}') IS DISTINCT FROM 'number'
       OR json_typeof(p_input#>'{snapshot,room_network,forecast,replicate_trajectories}') IS DISTINCT FROM 'array'
       OR json_typeof(p_input#>'{snapshot,room_network,forecast,replayed_paths}') IS DISTINCT FROM 'number'
       OR (p_input#>>'{snapshot,room_network,forecast,replayed_paths}')::numeric < (p_input#>>'{snapshot,room_network,forecast,trajectories}')::numeric
       OR (p_input#>>'{snapshot,room_network,forecast,replayed_paths}')::numeric <> trunc((p_input#>>'{snapshot,room_network,forecast,replayed_paths}')::numeric)
       OR (p_input#>>'{snapshot,room_network,forecast,replayed_paths}')::numeric > 9007199254740991
     THEN RAISE EXCEPTION 'Invalid frozen planning execution' USING ERRCODE='22023'; END IF;
   END IF;
 END IF;
 IF prior.job_id IS NOT NULL AND prior.state->>'revision'=p_state->>'revision' AND prior.state->>'runtime'=p_state->>'runtime' THEN
   before_stage:=prior.state#>>'{progress,stage}';
   IF before_stage='prepare' AND next_stage='prepare' THEN
     -- A completed source capture freezes execution input before native room zero.
     before_room:=(prior.state#>>'{progress,room_progress,next_room}')::integer;
     IF prior.cursor=1 AND (prior.state->'progress')::jsonb='{"stage":"prepare"}'::jsonb THEN before_room:=0; END IF;
     next_room:=(p_state#>>'{progress,room_progress,next_room}')::integer;
     before_work:=coalesce((prior.state#>>'{progress,room_progress,network_work,cursor}')::bigint,0);
     next_work:=coalesce((p_state#>>'{progress,room_progress,network_work,cursor}')::bigint,0);
     IF next_room IS NULL OR before_room IS NULL OR NOT(next_room=before_room+1 OR (next_room=before_room AND next_work>before_work)) THEN
       RAISE EXCEPTION 'Planning execution did not advance' USING ERRCODE='22023'; END IF;
   ELSIF NOT (before_stage='prepare' AND next_stage='solve' OR before_stage='solve' AND next_stage='assemble') THEN
     RAISE EXCEPTION 'Planning execution stage did not advance' USING ERRCODE='22023';
   END IF;
 END IF;
 INSERT INTO private.energy_planning_execution(job_id,cursor,input,state) VALUES(j.id,p_expected_cursor+1,p_input,p_state)
 ON CONFLICT(job_id) DO UPDATE SET cursor=EXCLUDED.cursor,input=EXCLUDED.input,state=EXCLUDED.state;
 UPDATE private.energy_planning_jobs SET lease_until=NULL,wake_after=clock_timestamp(),code=NULL,detail=NULL
 WHERE id=j.id RETURNING * INTO j;
 RETURN private.energy_planning_receipt(j);
END; $$;
CREATE OR REPLACE FUNCTION public.load_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,p_revision text,p_runtime text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; node_payload bytea; use_admitted boolean;
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
 IF r.phase='catalog' THEN SELECT payload INTO node_payload FROM private.energy_forecast_catalog_nodes WHERE job_id=j.id AND node=r.catalog_next; END IF;
 use_admitted:=r.phase='capture' AND j.input#>'{snapshot,room_network_capture}' IS NULL;
 RETURN json_build_object('dispatch',private.owned_planning_dispatch(j.id),'slice_fence',r.worker_fence,
  'customer_id',j.customer_id,'identity',r.identity,'catalog_next',r.catalog_next,'node_count',r.node_count,
  'use_admitted_input',use_admitted,'model_version',CASE WHEN use_admitted THEN j.input->>'model_version' END,
  'input',CASE WHEN r.phase='capture' AND NOT use_admitted THEN j.input WHEN r.phase IN ('prepare','qualify') THEN
    (SELECT input FROM private.energy_planning_execution WHERE job_id=j.id) END,
  'payload',replace(encode(r.payload,'base64'),E'\n',''),
  'context',CASE WHEN r.phase='qualify' THEN replace(encode(r.context,'base64'),E'\n','') END,
  'header',CASE WHEN r.phase IN ('catalog','qualify') THEN replace(encode(r.header,'base64'),E'\n','') END,
  'node',replace(encode(node_payload,'base64'),E'\n',''),
  'replicas',CASE WHEN r.phase='qualify' THEN
    (SELECT json_agg(json_build_object('replica',p.replica,'work',replace(encode(p.work,'base64'),E'\n','')) ORDER BY p.replica)
     FROM private.energy_forecast_replicas p WHERE p.job_id=j.id AND p.replica<r.replica_count) END);
END; $$;

CREATE OR REPLACE FUNCTION public.checkpoint_energy_owned_planning_stage(p_home_id uuid,p_job_id uuid,p_fence bigint,
 p_cursor bigint,p_slice_fence bigint,p_update json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r private.energy_planning_runtime%ROWTYPE; phase text:=p_update->>'phase';
 page json; item json; offsets integer[]; bytes bytea; next_record integer:=0; n integer:=0; execution_input json; receipt json;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(p_job_id);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM p_fence OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO r FROM private.energy_planning_runtime WHERE job_id=j.id FOR UPDATE;
 IF r.job_id IS NULL OR r.cursor IS DISTINCT FROM p_cursor OR r.worker_fence IS DISTINCT FROM p_slice_fence OR r.worker_parent IS DISTINCT FROM p_fence
  OR r.worker_until IS NULL OR r.worker_until<=clock_timestamp() THEN RETURN NULL; END IF;
 IF NOT(r.phase='capture' AND phase IN ('capture','prepare') OR r.phase='prepare' AND phase IN ('prepare','catalog','solve')
  OR r.phase='catalog' AND phase IN ('catalog','integrate') OR r.phase='qualify' AND phase IN ('integrate','solve')
  OR r.phase='solve' AND phase='assemble' OR r.phase='assemble' AND phase='ready')
 THEN RAISE EXCEPTION 'Invalid owned planning transition' USING ERRCODE='22023'; END IF;
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
   DELETE FROM private.energy_forecast_catalog_nodes WHERE job_id=j.id AND node=r.catalog_next;
   r.catalog_next:=r.catalog_next+1;
   IF (phase='integrate') IS DISTINCT FROM (r.catalog_next=r.node_count) THEN RAISE EXCEPTION 'Incomplete catalog stage'; END IF;
 END IF;
 IF r.phase='prepare' AND phase='catalog' THEN
   FOR item IN SELECT value FROM json_array_elements(p_update->'nodes') LOOP
     INSERT INTO private.energy_forecast_catalog_nodes VALUES(j.id,n,decode(item#>>'{}','base64')); n:=n+1;
   END LOOP;
   IF n<1 OR nullif(p_update->>'identity','') IS NULL THEN RAISE EXCEPTION 'Missing forecast catalog'; END IF;
   r.node_count:=n; r.identity:=p_update->>'identity';
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
  worker_until=NULL,identity=r.identity,node_count=r.node_count,catalog_next=r.catalog_next,round=r.round,target=r.target,replica_count=r.replica_count,
  payload=CASE WHEN p_update->'payload' IS NOT NULL THEN decode(p_update->>'payload','base64') ELSE payload END,
  context=CASE WHEN p_update->'context' IS NOT NULL THEN decode(p_update->>'context','base64') ELSE context END,
  header=CASE WHEN p_update->'header' IS NOT NULL THEN decode(p_update->>'header','base64') ELSE header END
 WHERE job_id=j.id;
 -- Avoid PL/pgSQL identifier ambiguity with the phase column.
 UPDATE private.energy_planning_runtime SET phase=p_update->>'phase' WHERE job_id=j.id;
 RETURN private.owned_planning_dispatch(j.id);
END; $$;

CREATE OR REPLACE FUNCTION public.publish_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='30s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; result json; execution json; request json; operational jsonb;
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=($1->>'job_id')::uuid AND home_id=($1->>'home_id')::uuid) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint OR j.lease_until IS NULL THEN
   RETURN private.publish_energy_planning_job_before_input_archive($1);
 END IF;
 IF $1->'use_frozen_execution' IS NOT NULL THEN
   IF ($1->'use_frozen_execution')::text IS DISTINCT FROM 'true' OR $1->'execution_input' IS NOT NULL
      OR $1#>'{current,snapshot}' IS NOT NULL OR nullif($1->>'runtime_version','') IS NULL
   THEN RAISE EXCEPTION 'Invalid frozen publication reference' USING ERRCODE='22023'; END IF;
   SELECT e.input INTO execution FROM private.energy_planning_execution e JOIN private.energy_planning_runtime r ON r.job_id=e.job_id
    WHERE e.job_id=j.id AND j.connected_runtime AND j.lease_until>clock_timestamp() AND r.phase='ready' AND e.state#>>'{progress,stage}'='solve'
      AND r.runtime=$1->>'runtime_version' AND e.state->>'runtime'=r.runtime AND e.state->>'revision'=r.revision;
   IF NOT FOUND THEN RETURN NULL; END IF;
   SELECT jsonb_object_agg(key,value ORDER BY ordinality) INTO operational
     FROM json_each(execution->'snapshot') WITH ORDINALITY WHERE key NOT IN ('room_network','room_network_capture');
   request:=json_build_object('job_id',j.id,'home_id',j.home_id,'fence',j.fence,'run',$1->'run',
     'current',($1->'current')::jsonb || jsonb_build_object('snapshot',operational));
 ELSE
   IF j.connected_runtime THEN RAISE EXCEPTION 'Connected publication requires its frozen execution' USING ERRCODE='22023'; END IF;
   execution:=$1->'execution_input'; request:=$1;
   IF json_typeof(execution) IS DISTINCT FROM 'object'
     OR NOT private.planning_json_matches(execution,j.input,ARRAY['snapshot'])
     OR NOT private.planning_json_matches(execution->'snapshot',$1#>'{current,snapshot}')
     OR execution#>'{snapshot,room_network_capture}' IS NOT NULL
     OR execution->>'model_version' IS DISTINCT FROM j.context->>'model_version'
     OR nullif($1->>'runtime_version','') IS NULL
   THEN RAISE EXCEPTION 'Completed planning input does not match publication' USING ERRCODE='22023'; END IF;
 END IF;
 result:=private.publish_energy_planning_job_before_input_archive(request);
 IF result->>'state'='published' THEN
   INSERT INTO private.energy_planning_current_input(plan_id,home_id,job_id,input,snapshot_hash,planner_version,runtime_version)
   VALUES((result->>'plan_id')::uuid,j.home_id,j.id,execution,$1->'current'->>'input_hash',execution->>'model_version',$1->>'runtime_version')
   ON CONFLICT(home_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,job_id=EXCLUDED.job_id,input=EXCLUDED.input,
     snapshot_hash=EXCLUDED.snapshot_hash,planner_version=EXCLUDED.planner_version,runtime_version=EXCLUDED.runtime_version;
 END IF;
 RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION private.validate_completed_planning_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,private AS $$
BEGIN
 IF EXISTS(SELECT FROM private.energy_planning_execution e WHERE e.job_id=NEW.job_id AND NOT private.planning_json_matches(e.input,NEW.input))
 THEN RAISE EXCEPTION 'Published input differs from frozen native execution' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END; $$;

-- Decode the admitted HTTP envelope once. Re-reading each field from the large
-- JSON body repeatedly rescanned all immutable network particles.
CREATE OR REPLACE FUNCTION public.accept_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; c public.energy_optimisation_current%ROWTYPE;
  admission record; v_home uuid; v_revision bigint;
BEGIN
  SELECT * INTO admission FROM json_to_record($1) AS a(home_id uuid,customer_id uuid,snapshot_id uuid,
    source_hash text,protocol integer,input json,context json);
  v_home:=admission.home_id;
  IF admission.protocol IS DISTINCT FROM 10 OR json_typeof(admission.input) IS DISTINCT FROM 'object' OR json_typeof(admission.context) IS DISTINCT FROM 'object'
    OR admission.source_hash IS NULL OR admission.context->>'fixed_revision' IS NULL THEN
    RAISE EXCEPTION 'Incomplete planning job' USING ERRCODE='22023';
  END IF;
  INSERT INTO private.energy_planning_heads(home_id) VALUES(v_home) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM private.energy_planning_heads WHERE home_id=v_home FOR UPDATE;
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=v_home FOR UPDATE;
  IF admission.context->'execution_replan'->>'request_id' IS NOT NULL THEN
    SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=v_home
      AND context->'execution_replan'->>'request_id'=admission.context->'execution_replan'->>'request_id' FOR UPDATE;
    IF FOUND THEN
      IF j.source_hash IS DISTINCT FROM admission.source_hash THEN
        RAISE EXCEPTION 'Execution request identity reused with different input' USING ERRCODE='22023';
      END IF;
      RETURN private.energy_planning_receipt(j);
    END IF;
    IF (c.accepted_household_reference->>'plan_id')::uuid IS DISTINCT FROM (admission.context->'execution_replan'->>'accepted_plan_id')::uuid
      OR (admission.input->'execution_replan')::jsonb IS DISTINCT FROM (admission.context->'execution_replan')::jsonb THEN
      RAISE EXCEPTION 'Execution evidence requires the exact HA-accepted reference' USING ERRCODE='22023';
    END IF;
  END IF;
  SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=v_home AND snapshot_id=admission.snapshot_id FOR UPDATE;
  IF FOUND THEN
    IF j.source_hash IS DISTINCT FROM admission.source_hash THEN
      RAISE EXCEPTION 'Planning snapshot identity reused with different input' USING ERRCODE='22023';
    END IF;
    RETURN private.energy_planning_receipt(j);
  END IF;
  IF admission.context->>'replaces_job_id' IS NOT NULL THEN
    PERFORM private.require_energy_planning_recapture(v_home,(admission.context->>'replaces_job_id')::uuid,
      (admission.context->>'replan_request_id')::uuid,(admission.context->'execution_replan')::jsonb);
  END IF;
  IF c.accepted_reference_unresolved THEN RAISE EXCEPTION 'Accepted command provenance is unresolved' USING ERRCODE='22023'; END IF;
  IF COALESCE(c.accepted_reference_revision,0) IS DISTINCT FROM (admission.context->>'accepted_reference_revision')::bigint THEN
    RAISE EXCEPTION 'Accepted command ownership changed during preparation' USING ERRCODE='P4091';
  END IF;
  IF c.plan_id IS DISTINCT FROM (admission.context->>'reference_plan_id')::uuid
    OR COALESCE(c.fixed_plan_revision,0)<>(admission.context->>'fixed_revision')::integer
    OR c.replan_request_id IS DISTINCT FROM (admission.context->>'observed_replan_request_id')::uuid
    OR (admission.context->>'replan_request_id' IS NOT NULL
      AND c.replan_request_id IS DISTINCT FROM (admission.context->>'replan_request_id')::uuid) THEN
    RAISE EXCEPTION 'Planning request changed during preparation' USING ERRCODE='22023';
  END IF;
  UPDATE private.energy_planning_jobs SET state='superseded',lease_until=NULL,finished_at=now()
    WHERE id=(SELECT active_job_id FROM private.energy_planning_heads WHERE home_id=v_home) AND state='pending';
  UPDATE private.energy_planning_heads SET revision=revision+1 WHERE home_id=v_home RETURNING revision INTO v_revision;
  INSERT INTO private.energy_planning_jobs(home_id,customer_id,snapshot_id,source_hash,revision,protocol,input,context)
    VALUES(v_home,admission.customer_id,admission.snapshot_id,admission.source_hash,v_revision,
      admission.protocol,admission.input,admission.context) RETURNING * INTO j;
  UPDATE private.energy_planning_heads SET active_job_id=j.id WHERE home_id=v_home;
  IF admission.context->>'replaces_job_id' IS NOT NULL THEN
    UPDATE public.energy_optimisation_current SET replan_error=NULL WHERE home_id=v_home
      AND replan_request_id=(admission.context->>'replan_request_id')::uuid;
  END IF;
  RETURN private.energy_planning_receipt(j);
END; $$;
CREATE OR REPLACE FUNCTION private.planning_dispatch_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE horizon record;
BEGIN
 NEW.connected_runtime:=NEW.input#>'{snapshot,room_network_capture}' IS NOT NULL
   OR coalesce(json_array_length(NEW.input#>'{snapshot,room_network,nodes}'),0)>0;
 SELECT * INTO horizon FROM json_to_record(NEW.input->'snapshot') AS s(slots json,slot_minutes integer);
 NEW.horizon_end:=((horizon.slots->-1)->>'start')::timestamptz + make_interval(mins=>horizon.slot_minutes);
 RETURN NEW;
END; $$;

-- The operational snapshot supplies one command reference per publication.
CREATE OR REPLACE FUNCTION private.publish_energy_planning_job_before_input_archive(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='30s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r public.energy_optimisation_plan_runs%ROWTYPE; v_current jsonb:=$1->'current'; commands jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.energy_planning_jobs WHERE id=($1->>'job_id')::uuid AND home_id=($1->>'home_id')::uuid) THEN RETURN NULL; END IF;
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.state IN ('published','failed','superseded') THEN RETURN private.energy_planning_receipt(j); END IF;
  IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint
 OR j.lease_until IS NULL THEN RETURN NULL; END IF;
  r:=jsonb_populate_record(NULL::public.energy_optimisation_plan_runs,($1->'run')::jsonb);
  IF (v_current->>'home_id')::uuid IS DISTINCT FROM j.home_id
    OR (v_current->>'customer_id')::uuid IS DISTINCT FROM j.customer_id
    OR (v_current->>'snapshot_id')::uuid IS DISTINCT FROM j.snapshot_id
    OR (v_current->>'fixed_plan_generation_revision')::integer IS DISTINCT FROM (j.context->>'fixed_revision')::integer
    OR v_current->>'generation_request_id' IS DISTINCT FROM j.context->>'request_id'
    OR r.id IS DISTINCT FROM (v_current->>'plan_id')::uuid OR r.home_id IS DISTINCT FROM j.home_id
    OR r.customer_id IS DISTINCT FROM j.customer_id OR r.snapshot_id IS DISTINCT FROM j.snapshot_id
    OR r.generation_request_id IS DISTINCT FROM j.context->>'request_id'
    OR r.plan_schema_version IS DISTINCT FROM (v_current->>'plan_schema_version')::smallint
    OR r.input_hash IS DISTINCT FROM v_current->>'input_hash' THEN
    RAISE EXCEPTION 'Planning publication identity mismatch';
  END IF;
  commands:=private.energy_command_reference(v_current->'plan',v_current->'snapshot');
  INSERT INTO private.energy_command_publications(home_id,plan_id,snapshot_id,schema_version,publication_revision,commands,horizon_end,battery_contract,completion_basis)
  VALUES(j.home_id,r.id,j.snapshot_id,r.plan_schema_version,j.revision,
    commands,
    (SELECT max((s->>'start')::timestamptz)+make_interval(mins=>(v_current->'snapshot'->>'slot_minutes')::int)
      FROM jsonb_array_elements(COALESCE(v_current->'plan'->'plans'->'priority'->'slots','[]'::jsonb)) s),
    commands->'battery_contract',COALESCE(j.context->>'completion_basis','home_assistant_ack'));
  PERFORM public.store_energy_optimisation_current(v_current);
  INSERT INTO public.energy_optimisation_plan_runs(id,customer_id,home_id,snapshot_id,generation_request_id,
    plan_schema_version,ha_ack_status,ha_acknowledged_at,ha_integration_version,ha_ack_request_id,ha_ack_error,
    input_hash,issued_at,status,model_version,summary,validation_errors)
  VALUES(r.id,r.customer_id,r.home_id,r.snapshot_id,r.generation_request_id,r.plan_schema_version,
    r.ha_ack_status,r.ha_acknowledged_at,r.ha_integration_version,r.ha_ack_request_id,r.ha_ack_error,
    r.input_hash,r.issued_at,r.status,r.model_version,r.summary,COALESCE(r.validation_errors,'{}'))
  ON CONFLICT(home_id,snapshot_id) DO UPDATE SET id=EXCLUDED.id,generation_request_id=EXCLUDED.generation_request_id,
    plan_schema_version=EXCLUDED.plan_schema_version,ha_ack_status=EXCLUDED.ha_ack_status,
    ha_acknowledged_at=EXCLUDED.ha_acknowledged_at,ha_integration_version=EXCLUDED.ha_integration_version,
    ha_ack_request_id=EXCLUDED.ha_ack_request_id,ha_ack_error=EXCLUDED.ha_ack_error,input_hash=EXCLUDED.input_hash,
    issued_at=EXCLUDED.issued_at,status=EXCLUDED.status,model_version=EXCLUDED.model_version,
    summary=EXCLUDED.summary,validation_errors=EXCLUDED.validation_errors;
  UPDATE private.energy_planning_jobs SET state='published',plan_id=r.id,lease_until=NULL,finished_at=now()
    WHERE id=j.id RETURNING * INTO j;
  -- A mirror environment can finish the manual request on publication. The
  -- server freezes this basis at admission; it never substitutes an HA ack.
  IF j.context->>'completion_basis'='publication' AND r.status='ready' THEN
    UPDATE public.energy_optimisation_current
      SET replan_completed_request_id=(j.context->>'replan_request_id')::uuid,replan_error=NULL
      WHERE home_id=j.home_id AND plan_id=j.plan_id AND snapshot_id=j.snapshot_id AND status='ready'
        AND replan_request_id=(j.context->>'replan_request_id')::uuid
        AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
        AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
  END IF;
  RETURN private.energy_planning_receipt(j,false);
END; $$;
