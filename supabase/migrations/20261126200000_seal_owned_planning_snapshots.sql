-- The execution snapshot and the assembled result each have a separate reader.
-- A job already at ready when this migration runs takes the same seal step.
ALTER TABLE private.energy_planning_runtime ADD COLUMN snapshot_hash text
 CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION private.owned_planning_dispatch(p_job uuid) RETURNS json LANGUAGE sql STABLE AS $$
 SELECT json_build_object('phase', CASE WHEN r.phase='ready' AND r.snapshot_hash IS NULL THEN 'seal' ELSE r.phase END,
  'cursor',r.cursor,'target',r.target,'round',r.round,
  'replicas',CASE WHEN r.phase='integrate' THEN
    (SELECT coalesce(json_agg(p.replica ORDER BY p.replica),'[]'::json) FROM private.energy_forecast_replicas p
      WHERE p.job_id=r.job_id AND p.replica<r.replica_count AND p.completed<r.target/r.replica_count)
   ELSE '[]'::json END)
 FROM private.energy_planning_runtime r WHERE r.job_id=p_job;
$$;

CREATE FUNCTION public.read_energy_owned_snapshot_for_hash(p_home_id uuid,p_job_id uuid,p_fence bigint,p_cursor bigint)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
 j:=private.share_owned_planning_job(p_home_id,p_job_id,p_fence);
 IF j.id IS NULL OR j.fence IS DISTINCT FROM p_fence THEN RETURN NULL; END IF;
 RETURN (SELECT e.input->'snapshot' FROM private.energy_planning_execution e JOIN private.energy_planning_runtime r USING(job_id)
   WHERE e.job_id=j.id AND r.phase='ready' AND r.cursor=p_cursor AND r.snapshot_hash IS NULL
     AND e.state#>>'{progress,stage}'='solve' AND e.state->>'runtime'=r.runtime AND e.state->>'revision'=r.revision);
END; $$;

CREATE FUNCTION public.seal_energy_owned_planning_snapshot(p_home_id uuid,p_job_id uuid,p_fence bigint,p_cursor bigint,
 p_revision text,p_runtime text,p_snapshot_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
 j:=private.share_owned_planning_job(p_home_id,p_job_id,p_fence);
 IF j.id IS NULL OR j.fence IS DISTINCT FROM p_fence THEN RETURN NULL; END IF;
 IF p_snapshot_hash IS NULL OR p_snapshot_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid snapshot hash' USING ERRCODE='22023'; END IF;
 UPDATE private.energy_planning_runtime r SET snapshot_hash=p_snapshot_hash
   FROM private.energy_planning_execution e WHERE r.job_id=j.id AND e.job_id=r.job_id AND r.phase='ready'
   AND r.cursor=p_cursor AND r.snapshot_hash IS NULL AND r.revision=p_revision AND r.runtime=p_runtime
   AND e.state#>>'{progress,stage}'='solve' AND e.state->>'runtime'=r.runtime AND e.state->>'revision'=r.revision;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN private.owned_planning_dispatch(j.id);
END; $$;

REVOKE ALL ON FUNCTION public.read_energy_owned_snapshot_for_hash(uuid,uuid,bigint,bigint),
 public.seal_energy_owned_planning_snapshot(uuid,uuid,bigint,bigint,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_energy_owned_snapshot_for_hash(uuid,uuid,bigint,bigint),
 public.seal_energy_owned_planning_snapshot(uuid,uuid,bigint,bigint,text,text,text) TO service_role;

CREATE FUNCTION private.planning_operational_snapshot(snapshot json) RETURNS jsonb
 LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT jsonb_object_agg(key,value ORDER BY ordinality) FROM json_each(snapshot) WITH ORDINALITY
 WHERE key NOT IN ('room_network','room_network_capture');
$$;
REVOKE ALL ON FUNCTION private.planning_operational_snapshot(json) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.load_energy_owned_planning_result(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
 j:=private.share_owned_planning_job(p_home_id,p_job_id,p_fence);
 IF j.id IS NULL OR j.fence IS DISTINCT FROM p_fence THEN RETURN NULL; END IF;
 RETURN (SELECT json_build_object('snapshot',private.planning_operational_snapshot(e.input->'snapshot'),
    'snapshot_hash',r.snapshot_hash,'context',j.context,'identity',r.identity,'result',replace(encode(r.payload,'base64'),E'\n',''))
   FROM private.energy_planning_execution e JOIN private.energy_planning_runtime r USING(job_id)
   WHERE e.job_id=j.id AND r.phase='ready' AND r.snapshot_hash IS NOT NULL
     AND e.state#>>'{progress,stage}'='solve' AND e.state->>'runtime'=r.runtime AND e.state->>'revision'=r.revision);
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
      AND r.snapshot_hash=$1#>>'{current,input_hash}' AND r.snapshot_hash=$1#>>'{run,input_hash}'
      AND r.runtime=$1->>'runtime_version' AND e.state->>'runtime'=r.runtime AND e.state->>'revision'=r.revision;
   IF NOT FOUND THEN RETURN NULL; END IF;
   operational:=private.planning_operational_snapshot(execution->'snapshot');
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

