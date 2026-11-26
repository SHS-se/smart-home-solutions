-- Native trajectory integration advances in the existing fenced planning job.
-- Its completed capture is frozen separately from the original admission.
CREATE TABLE private.energy_planning_execution (
 job_id uuid PRIMARY KEY REFERENCES private.energy_planning_jobs(id) ON DELETE CASCADE,
 cursor integer NOT NULL CHECK(cursor>0),
 input json NOT NULL CHECK(json_typeof(input)='object'),
 state json NOT NULL CHECK(json_typeof(state)='object')
);
ALTER TABLE private.energy_planning_execution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_planning_execution FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.load_energy_planning_execution(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; saved private.energy_planning_execution%ROWTYPE;
BEGIN
 SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id
   AND state='pending' AND fence=p_fence AND lease_until IS NOT NULL;
 IF NOT FOUND OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
 SELECT * INTO saved FROM private.energy_planning_execution WHERE job_id=j.id;
 RETURN json_build_object('cursor',coalesce(saved.cursor,0),'input',saved.input,'state',saved.state);
END; $$;
REVOKE ALL ON FUNCTION public.load_energy_planning_execution(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_energy_planning_execution(uuid,uuid,bigint) TO service_role;

CREATE FUNCTION public.checkpoint_energy_planning_execution(
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
   OR p_input::jsonb-'snapshot' IS DISTINCT FROM j.input::jsonb-'snapshot'
   OR p_input#>>'{snapshot,snapshot_id}' IS DISTINCT FROM j.input#>>'{snapshot,snapshot_id}'
   OR (p_input->'snapshot')::jsonb ? 'room_network_capture'
   OR p_input->>'model_version' IS DISTINCT FROM j.context->>'model_version'
 THEN RAISE EXCEPTION 'Invalid frozen planning execution' USING ERRCODE='22023'; END IF;
 -- Native preparation may resolve only the trajectory counts. All captured
 -- physical/source inputs and numerical seed/policy/runtime stay immutable.
 IF prior.job_id IS NOT NULL AND p_input::jsonb IS DISTINCT FROM prior.input::jsonb THEN
   IF prior.state#>>'{progress,stage}' IS DISTINCT FROM 'prepare' OR next_stage<>'solve'
     OR (prior.input::jsonb#-'{snapshot,room_network,forecast}') IS DISTINCT FROM (p_input::jsonb#-'{snapshot,room_network,forecast}')
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
REVOKE ALL ON FUNCTION public.checkpoint_energy_planning_execution(uuid,uuid,bigint,integer,json,json) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_planning_execution(uuid,uuid,bigint,integer,json,json) TO service_role;

CREATE FUNCTION private.validate_completed_planning_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,private AS $$
BEGIN
 IF EXISTS(SELECT FROM private.energy_planning_execution e WHERE e.job_id=NEW.job_id AND e.input::jsonb IS DISTINCT FROM NEW.input::jsonb)
 THEN RAISE EXCEPTION 'Published input differs from frozen native execution' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER completed_planning_execution BEFORE INSERT ON private.energy_planning_current_input
FOR EACH ROW EXECUTE FUNCTION private.validate_completed_planning_execution();
