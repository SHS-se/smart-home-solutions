-- Recoverable attempts preserve their immutable capture and original purpose.
-- Retry delays pace work; they never impose a lifetime validity/attempt limit.
ALTER TABLE private.energy_planning_jobs ADD COLUMN retry_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN wake_after timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION private.energy_planning_receipt(p_job private.energy_planning_jobs,p_include_plan boolean DEFAULT true)
RETURNS json LANGUAGE plpgsql STABLE SET search_path=public,private AS $$
DECLARE v_plan jsonb;
BEGIN
  IF p_job.state='published' THEN
    SELECT CASE WHEN p_include_plan THEN plan ELSE NULL END INTO v_plan FROM public.energy_optimisation_current
      WHERE home_id=p_job.home_id AND plan_id=p_job.plan_id AND snapshot_id=p_job.snapshot_id;
    IF FOUND THEN
      IF NOT p_include_plan THEN
        RETURN json_build_object('job_id',p_job.id,'state','published','pending',false,
          'snapshot_id',p_job.snapshot_id,'plan_id',p_job.plan_id,'source_hash',p_job.source_hash);
      END IF;
      RETURN json_build_object('job_id',p_job.id,'state','published','pending',false,
        'snapshot_id',p_job.snapshot_id,'plan_id',p_job.plan_id,'plan',v_plan,'source_hash',p_job.source_hash);
    END IF;
    RETURN json_build_object('job_id',p_job.id,'state','superseded','pending',false,
      'snapshot_id',p_job.snapshot_id,'source_hash',p_job.source_hash);
  ELSIF p_job.state='failed' THEN
    RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',false,
      'snapshot_id',p_job.snapshot_id,'code',p_job.code,'detail',p_job.detail,'source_hash',p_job.source_hash,
      'recapture',CASE WHEN p_job.code IN ('planner_upgraded','capture_horizon_ended') AND private.energy_planning_is_current(p_job)
        THEN json_build_object('replaces_job_id',p_job.id) ELSE NULL END);
  ELSIF p_job.state='pending' THEN
    RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',true,
      'snapshot_id',p_job.snapshot_id,'retry_after_ms',GREATEST(1000,CEIL(EXTRACT(EPOCH FROM
        (GREATEST(p_job.wake_after,COALESCE(p_job.lease_until,p_job.wake_after))-clock_timestamp()))*1000))::bigint,
      'last_error',CASE WHEN p_job.code IS NOT NULL THEN json_build_object('code',p_job.code,'detail',p_job.detail) ELSE NULL END,
      'source_hash',p_job.source_hash);
  END IF;
  RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',false,
    'snapshot_id',p_job.snapshot_id,'source_hash',p_job.source_hash);
END; $$;

CREATE OR REPLACE FUNCTION public.claim_energy_planning_attempt(p_home_id uuid,p_job_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
  j:=private.lock_energy_planning_job(p_job_id);
  IF j.id IS NULL OR j.state<>'pending' OR j.lease_until>clock_timestamp() OR j.wake_after>clock_timestamp() THEN RETURN NULL; END IF;
  UPDATE private.energy_planning_jobs SET fence=fence+1,lease_until=clock_timestamp()+interval '60 seconds'
    WHERE id=j.id RETURNING * INTO j;
  RETURN json_build_object('id',j.id,'home_id',j.home_id,'customer_id',j.customer_id,'snapshot_id',j.snapshot_id,
    'protocol',j.protocol,'fence',j.fence);
END; $$;

CREATE FUNCTION public.retry_energy_planning_attempt(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.energy_planning_jobs WHERE id=($1->>'job_id')::uuid AND home_id=($1->>'home_id')::uuid) THEN RETURN NULL; END IF;
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.state<>'pending' THEN RETURN private.energy_planning_receipt(j); END IF;
  IF j.id IS NULL OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint OR j.lease_until IS NULL THEN RETURN NULL; END IF;
  IF NULLIF($1->>'code','') IS NULL OR NULLIF($1->>'detail','') IS NULL THEN RAISE EXCEPTION 'Missing planning failure'; END IF;
  UPDATE private.energy_planning_jobs SET retry_count=retry_count+1,code=$1->>'code',detail=$1->>'detail',
    lease_until=NULL,wake_after=clock_timestamp()+make_interval(secs=>LEAST(60,5*power(2,LEAST(retry_count,4)))::double precision)
    WHERE id=j.id RETURNING * INTO j;
  RETURN private.energy_planning_receipt(j);
END; $$;

-- Read before doing preparation, then check again under the existing head/current
-- lock at admission. A copied ticket cannot force another home or newer purpose.
CREATE FUNCTION private.require_energy_planning_recapture(p_home_id uuid,p_job_id uuid,
  p_replan_request_id uuid,p_execution_replan jsonb)
RETURNS json LANGUAGE plpgsql STABLE SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id;
  IF NOT FOUND OR j.state<>'failed' OR j.code NOT IN ('planner_upgraded','capture_horizon_ended') OR NOT private.energy_planning_is_current(j)
    OR (j.context->>'replan_request_id')::uuid IS DISTINCT FROM p_replan_request_id
    OR j.context->'execution_replan'->>'accepted_plan_id' IS DISTINCT FROM p_execution_replan->>'accepted_plan_id' THEN
    RAISE EXCEPTION 'Planning recapture authority is no longer current or has a different purpose' USING ERRCODE='22023';
  END IF;
  RETURN j.context;
END; $$;
CREATE FUNCTION public.read_energy_planning_recapture(p_home_id uuid,p_job_id uuid,
  p_replan_request_id uuid,p_execution_replan jsonb)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT private.require_energy_planning_recapture($1,$2,$3,$4);
$$;

CREATE OR REPLACE FUNCTION public.accept_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; c public.energy_optimisation_current%ROWTYPE;
  v_home uuid:=($1->>'home_id')::uuid; v_revision bigint;
BEGIN
  IF ($1->>'protocol')::integer IS DISTINCT FROM 10 OR json_typeof($1->'input') IS DISTINCT FROM 'object' OR json_typeof($1->'context') IS DISTINCT FROM 'object'
    OR $1->>'source_hash' IS NULL OR $1->'context'->>'fixed_revision' IS NULL THEN
    RAISE EXCEPTION 'Incomplete planning job' USING ERRCODE='22023';
  END IF;
  INSERT INTO private.energy_planning_heads(home_id) VALUES(v_home) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM private.energy_planning_heads WHERE home_id=v_home FOR UPDATE;
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=v_home FOR UPDATE;
  IF $1->'context'->'execution_replan'->>'request_id' IS NOT NULL THEN
    SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=v_home
      AND context->'execution_replan'->>'request_id'=$1->'context'->'execution_replan'->>'request_id' FOR UPDATE;
    IF FOUND THEN
      IF j.source_hash IS DISTINCT FROM $1->>'source_hash' THEN
        RAISE EXCEPTION 'Execution request identity reused with different input' USING ERRCODE='22023';
      END IF;
      RETURN private.energy_planning_receipt(j);
    END IF;
    IF c.ha_ack_status IS DISTINCT FROM 'accepted'
      OR c.plan_id IS DISTINCT FROM ($1->'context'->'execution_replan'->>'accepted_plan_id')::uuid
      OR ($1->'input'->'execution_replan')::jsonb IS DISTINCT FROM ($1->'context'->'execution_replan')::jsonb THEN
      RAISE EXCEPTION 'Execution evidence requires the exact HA-accepted reference' USING ERRCODE='22023';
    END IF;
  END IF;
  SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=v_home AND snapshot_id=($1->>'snapshot_id')::uuid FOR UPDATE;
  IF FOUND THEN
    IF j.source_hash IS DISTINCT FROM $1->>'source_hash' THEN
      RAISE EXCEPTION 'Planning snapshot identity reused with different input' USING ERRCODE='22023';
    END IF;
    RETURN private.energy_planning_receipt(j);
  END IF;
  IF $1->'context'->>'replaces_job_id' IS NOT NULL THEN
    PERFORM private.require_energy_planning_recapture(v_home,($1->'context'->>'replaces_job_id')::uuid,
      ($1->'context'->>'replan_request_id')::uuid,($1->'context'->'execution_replan')::jsonb);
  END IF;
  IF c.plan_id IS DISTINCT FROM ($1->'context'->>'reference_plan_id')::uuid
    OR COALESCE(c.fixed_plan_revision,0)<>($1->'context'->>'fixed_revision')::integer
    OR c.replan_request_id IS DISTINCT FROM ($1->'context'->>'observed_replan_request_id')::uuid
    OR ($1->'context'->>'replan_request_id' IS NOT NULL
      AND c.replan_request_id IS DISTINCT FROM ($1->'context'->>'replan_request_id')::uuid) THEN
    RAISE EXCEPTION 'Planning request changed during preparation' USING ERRCODE='22023';
  END IF;
  UPDATE private.energy_planning_jobs SET state='superseded',lease_until=NULL,finished_at=now()
    WHERE id=(SELECT active_job_id FROM private.energy_planning_heads WHERE home_id=v_home) AND state='pending';
  UPDATE private.energy_planning_heads SET revision=revision+1 WHERE home_id=v_home RETURNING revision INTO v_revision;
  INSERT INTO private.energy_planning_jobs(home_id,customer_id,snapshot_id,source_hash,revision,protocol,input,context)
    VALUES(v_home,($1->>'customer_id')::uuid,($1->>'snapshot_id')::uuid,$1->>'source_hash',v_revision,
      ($1->>'protocol')::integer,$1->'input',$1->'context') RETURNING * INTO j;
  UPDATE private.energy_planning_heads SET active_job_id=j.id WHERE home_id=v_home;
  IF $1->'context'->>'replaces_job_id' IS NOT NULL THEN
    UPDATE public.energy_optimisation_current SET replan_error=NULL WHERE home_id=v_home
      AND replan_request_id=($1->'context'->>'replan_request_id')::uuid;
  END IF;
  RETURN private.energy_planning_receipt(j);
END; $$;

REVOKE ALL ON FUNCTION public.retry_energy_planning_attempt(json),
  private.require_energy_planning_recapture(uuid,uuid,uuid,jsonb),
  public.read_energy_planning_recapture(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retry_energy_planning_attempt(json),
  public.read_energy_planning_recapture(uuid,uuid,uuid,jsonb) TO service_role;
