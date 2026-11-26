-- Replay owns exactly one completed execution input per home, pinned to the
-- current plan ID. Publication replaces it atomically; historical plan runs
-- retain their existing summary-only storage and no arbitrary payload TTL.
CREATE TABLE private.energy_planning_current_input (
 plan_id uuid NOT NULL UNIQUE REFERENCES public.energy_optimisation_plan_runs(id) ON DELETE CASCADE,
 home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
 job_id uuid NOT NULL,
 input json NOT NULL CHECK(json_typeof(input)='object'),
 snapshot_hash text NOT NULL,
 planner_version text NOT NULL,
 runtime_version text NOT NULL
);
ALTER TABLE private.energy_planning_current_input ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_planning_current_input FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.publish_energy_planning_job(json) RENAME TO publish_energy_planning_job_before_input_archive;
ALTER FUNCTION public.publish_energy_planning_job_before_input_archive(json) SET SCHEMA private;
REVOKE ALL ON FUNCTION private.publish_energy_planning_job_before_input_archive(json) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.publish_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='30s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; result json; execution json:=$1->'execution_input';
BEGIN
 IF NOT EXISTS(SELECT FROM private.energy_planning_jobs WHERE id=($1->>'job_id')::uuid AND home_id=($1->>'home_id')::uuid) THEN RETURN NULL; END IF;
 j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
 IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint OR j.lease_until IS NULL THEN
   RETURN private.publish_energy_planning_job_before_input_archive($1);
 END IF;
 IF json_typeof(execution) IS DISTINCT FROM 'object'
   OR execution::jsonb-'snapshot' IS DISTINCT FROM j.input::jsonb-'snapshot'
   OR (execution->'snapshot')::jsonb IS DISTINCT FROM ($1->'current'->'snapshot')::jsonb
   OR (execution->'snapshot')::jsonb ? 'room_network_capture'
   OR execution->>'model_version' IS DISTINCT FROM j.context->>'model_version'
   OR nullif($1->>'runtime_version','') IS NULL
 THEN RAISE EXCEPTION 'Completed planning input does not match publication' USING ERRCODE='22023'; END IF;
 result:=private.publish_energy_planning_job_before_input_archive($1);
 IF result->>'state'='published' THEN
   INSERT INTO private.energy_planning_current_input(plan_id,home_id,job_id,input,snapshot_hash,planner_version,runtime_version)
   VALUES((result->>'plan_id')::uuid,j.home_id,j.id,execution,$1->'current'->>'input_hash',execution->>'model_version',$1->>'runtime_version')
   ON CONFLICT(home_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,job_id=EXCLUDED.job_id,input=EXCLUDED.input,
     snapshot_hash=EXCLUDED.snapshot_hash,planner_version=EXCLUDED.planner_version,runtime_version=EXCLUDED.runtime_version;
 END IF;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.publish_energy_planning_job(json) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_energy_planning_job(json) TO service_role;

CREATE FUNCTION public.get_energy_planning_current_input(p_home_id uuid,p_plan_id uuid)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,private AS $$
 SELECT json_build_object('input',input,'snapshot_hash',snapshot_hash,'planner_version',planner_version,'runtime_version',runtime_version)
 FROM private.energy_planning_current_input WHERE home_id=p_home_id AND plan_id=p_plan_id;
$$;
REVOKE ALL ON FUNCTION public.get_energy_planning_current_input(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_planning_current_input(uuid,uuid) TO service_role;

-- The portal may fetch only a run belonging to a customer it can access. This
-- exposes no table access. A superseded selection returns no current input.
CREATE FUNCTION public.get_energy_planning_replay(p_home_id uuid,p_plan_id uuid)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 SELECT json_build_object('input',i.input,'snapshot_hash',i.snapshot_hash,
   'planner_version',i.planner_version,'runtime_version',i.runtime_version)
 FROM private.energy_planning_current_input i
 JOIN public.energy_optimisation_plan_runs r ON r.id=i.plan_id AND r.home_id=i.home_id
 WHERE i.home_id=p_home_id AND i.plan_id=p_plan_id
   AND coalesce(public.can_access_energy_billing_customer(r.customer_id),false);
$$;
REVOKE ALL ON FUNCTION public.get_energy_planning_replay(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_energy_planning_replay(uuid,uuid) TO authenticated;
