-- One complete rules solve per owned job. Old continuation jobs roll forward.
WITH cancelled AS (
  UPDATE private.energy_planning_jobs SET state='failed',fence=fence+1,lease_until=NULL,
    finished_at=clock_timestamp(),code='planner_upgraded',detail='Planner changed. Request a new replan.'
    WHERE state='pending' RETURNING id,home_id,context,detail
)
UPDATE public.energy_optimisation_current c SET replan_error=j.detail
  FROM cancelled j JOIN private.energy_planning_heads h ON h.active_job_id=j.id AND h.home_id=j.home_id
  WHERE c.home_id=j.home_id AND c.replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND c.replan_request_id IS DISTINCT FROM c.replan_completed_request_id;
DROP FUNCTION public.claim_energy_planning_batch(uuid,uuid);
DROP FUNCTION public.load_energy_planning_batch(uuid,uuid,bigint);
DROP FUNCTION public.commit_energy_planning_batch(json);
DROP TABLE private.energy_planning_parts;
ALTER TABLE private.energy_planning_jobs DROP COLUMN phase, DROP COLUMN steps, DROP COLUMN continuation;

CREATE OR REPLACE FUNCTION private.energy_planning_is_current(p_job private.energy_planning_jobs)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,private AS $$
  SELECT COALESCE((SELECT h.active_job_id=p_job.id AND h.revision=p_job.revision
    AND COALESCE(c.fixed_plan_revision,0)=(p_job.context->>'fixed_revision')::integer
    AND c.plan_id IS NOT DISTINCT FROM (p_job.context->>'reference_plan_id')::uuid
    AND c.replan_request_id IS NOT DISTINCT FROM (p_job.context->>'observed_replan_request_id')::uuid
    FROM private.energy_planning_heads h LEFT JOIN public.energy_optimisation_current c USING(home_id)
    WHERE h.home_id=p_job.home_id),false);
$$;

CREATE FUNCTION public.claim_energy_planning_attempt(p_home_id uuid,p_job_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
  j:=private.lock_energy_planning_job(p_job_id);
  IF j.id IS NULL OR j.state<>'pending' OR j.lease_until>clock_timestamp() THEN RETURN NULL; END IF;
  UPDATE private.energy_planning_jobs SET fence=fence+1,lease_until=clock_timestamp()+interval '60 seconds'
    WHERE id=j.id RETURNING * INTO j;
  RETURN json_build_object('id',j.id,'home_id',j.home_id,'customer_id',j.customer_id,'snapshot_id',j.snapshot_id,
    'protocol',j.protocol,'fence',j.fence);
END; $$;

CREATE FUNCTION public.load_energy_planning_attempt(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id
    AND state='pending' AND fence=p_fence AND lease_until IS NOT NULL;
  IF NOT FOUND OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
  RETURN json_build_object('input',j.input,'context',j.context);
END; $$;


CREATE OR REPLACE FUNCTION public.accept_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; c public.energy_optimisation_current%ROWTYPE;
  v_home uuid:=($1->>'home_id')::uuid; v_revision bigint;
BEGIN
  IF ($1->>'protocol')::integer IS DISTINCT FROM 9 OR json_typeof($1->'input') IS DISTINCT FROM 'object' OR json_typeof($1->'context') IS DISTINCT FROM 'object'
    OR $1->>'source_hash' IS NULL OR $1->'context'->>'fixed_revision' IS NULL THEN
    RAISE EXCEPTION 'Incomplete planning job' USING ERRCODE='22023';
  END IF;
  INSERT INTO private.energy_planning_heads(home_id) VALUES(v_home) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM private.energy_planning_heads WHERE home_id=v_home FOR UPDATE;
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=v_home FOR UPDATE;
  SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=v_home AND snapshot_id=($1->>'snapshot_id')::uuid FOR UPDATE;
  IF FOUND THEN
    IF j.source_hash IS DISTINCT FROM $1->>'source_hash' THEN
      RAISE EXCEPTION 'Planning snapshot identity reused with different input' USING ERRCODE='22023';
    END IF;
    RETURN private.energy_planning_receipt(j);
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
  RETURN private.energy_planning_receipt(j);
END; $$;

CREATE OR REPLACE FUNCTION public.publish_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='30s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r public.energy_optimisation_plan_runs%ROWTYPE; v_current jsonb:=$1->'current';
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
  RETURN private.energy_planning_receipt(j,false);
END; $$;

CREATE OR REPLACE FUNCTION public.fail_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.energy_planning_jobs WHERE id=($1->>'job_id')::uuid AND home_id=($1->>'home_id')::uuid) THEN RETURN NULL; END IF;
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.state='failed' THEN RETURN private.energy_planning_receipt(j); END IF;
  IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint
    OR j.lease_until IS NULL THEN RETURN NULL; END IF;
  IF NULLIF($1->>'code','') IS NULL OR NULLIF($1->>'detail','') IS NULL THEN RAISE EXCEPTION 'Missing planning failure'; END IF;
  UPDATE private.energy_planning_jobs SET state='failed',code=$1->>'code',detail=$1->>'detail',
    lease_until=NULL,finished_at=now() WHERE id=j.id RETURNING * INTO j;
  UPDATE public.energy_optimisation_current SET replan_error=j.detail
    WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
  RETURN private.energy_planning_receipt(j);
END; $$;

REVOKE ALL ON FUNCTION public.claim_energy_planning_attempt(uuid,uuid),public.load_energy_planning_attempt(uuid,uuid,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_energy_planning_attempt(uuid,uuid),public.load_energy_planning_attempt(uuid,uuid,bigint) TO service_role;

-- Full native command references, compacted independently of diagnostics.
CREATE OR REPLACE FUNCTION public.get_energy_replan_state(p_home_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE c public.energy_optimisation_current%ROWTYPE; reference jsonb;
BEGIN
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=p_home_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF c.plan->>'status'='ready' THEN
    SELECT jsonb_build_object('plan_id',c.plan_id,'slots',COALESCE(jsonb_agg(jsonb_build_object(
      'start',value->'start','pool_w',value->'pool_w','pool_command_w',value->'pool_command_w',
      'ev_target_current_a',value->'ev_target_current_a','ev_min_current_a',value->'ev_min_current_a','ev_max_current_a',value->'ev_max_current_a','boiler_permitted',value->'boiler_permitted',
      'battery_command',value->'battery_command','device_commands',value->'device_commands') ORDER BY ordinal),'[]'::jsonb))
      INTO reference FROM jsonb_array_elements(c.plan->'plans'->'priority'->'slots') WITH ORDINALITY AS slots(value,ordinal);
  END IF;
  RETURN jsonb_build_object('fixed_plan',c.fixed_plan,'fixed_plan_revision',c.fixed_plan_revision,
    'reference_plan_id',c.plan_id,'published_commands',reference);
END; $$;

-- The retired schedule editor no longer owns future bookings.
UPDATE public.energy_optimisation_current SET fixed_plan=NULL, fixed_plan_revision=fixed_plan_revision+1 WHERE fixed_plan IS NOT NULL;
