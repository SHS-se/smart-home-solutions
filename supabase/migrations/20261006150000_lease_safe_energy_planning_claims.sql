-- Large ordered claims need a scoped query budget, and payload preparation
-- must not spend the worker's lease. No planner protocol or numeric changes.
-- Lease checks use wall time after lock acquisition, not transaction-start time.

CREATE OR REPLACE FUNCTION public.claim_energy_planning_step(p_job_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='15s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_payload json; v_claimed_at timestamptz;
BEGIN
  j:=private.lock_energy_planning_job(p_job_id);
  IF j.id IS NULL OR j.state<>'pending' OR j.lease_until>clock_timestamp() THEN RETURN NULL; END IF;
  IF j.lease_until IS NOT NULL THEN
    j.expiry_count:=j.expiry_count+1;
    IF j.expiry_count>=4 THEN
      UPDATE private.energy_planning_jobs SET state='failed',lease_until=NULL,expiry_count=j.expiry_count,
        finished_at=now(),code='worker_lease_expired',detail='Planning worker repeatedly stopped before saving progress.' WHERE id=j.id;
      UPDATE public.energy_optimisation_current SET replan_error='Planning worker repeatedly stopped before saving progress.'
        WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
        AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
      RETURN NULL;
    END IF;
  END IF;
  v_payload:=json_build_object('id',j.id,'home_id',j.home_id,'customer_id',j.customer_id,'snapshot_id',j.snapshot_id,
    'protocol',j.protocol,'fence',j.fence+1,'step',j.step,'phase',j.phase,'input',j.input,'context',j.context,
    'continuation',j.continuation,
    'completed',COALESCE((SELECT json_agg(value ORDER BY ordinal) FROM private.energy_planning_parts WHERE job_id=j.id AND kind='completed'),'[]'::json),
    'rankings',COALESCE((SELECT json_agg(value ORDER BY ordinal) FROM private.energy_planning_parts WHERE job_id=j.id AND kind='rankings'),'[]'::json));
  v_claimed_at:=clock_timestamp();
  UPDATE private.energy_planning_jobs SET fence=fence+1,lease_until=v_claimed_at+interval '30 seconds',
    wake_after=v_claimed_at+interval '30 seconds',expiry_count=j.expiry_count WHERE id=j.id;
  RETURN v_payload;
END; $$;

CREATE OR REPLACE FUNCTION public.commit_energy_planning_step(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_kind text; v_count bigint;
BEGIN
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint OR j.step IS DISTINCT FROM ($1->>'step')::bigint
    OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
  IF $1->>'phase' NOT IN ('solving','assembling') OR json_typeof($1->'completed') IS DISTINCT FROM 'array'
    OR json_typeof($1->'rankings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid planning checkpoint'; END IF;
  FOREACH v_kind IN ARRAY ARRAY['completed','rankings'] LOOP
    SELECT count(*) INTO v_count FROM private.energy_planning_parts WHERE job_id=j.id AND kind=v_kind;
    INSERT INTO private.energy_planning_parts(job_id,kind,ordinal,value)
      SELECT j.id,v_kind,v_count+ordinal,value FROM json_array_elements($1->v_kind) WITH ORDINALITY AS parts(value,ordinal);
  END LOOP;
  UPDATE private.energy_planning_jobs SET continuation=$1->'continuation',phase=$1->>'phase',step=step+1,
    lease_until=NULL,expiry_count=0,wake_after=now()+interval '10 seconds' WHERE id=j.id RETURNING * INTO j;
  PERFORM private.wake_energy_planning_job(j.id);
  RETURN private.energy_planning_receipt(j);
END; $$;

CREATE OR REPLACE FUNCTION public.publish_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='30s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r public.energy_optimisation_plan_runs%ROWTYPE; v_current jsonb:=$1->'current';
BEGIN
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.id IS NULL OR j.state<>'pending' OR j.phase<>'assembling' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint
    OR j.step IS DISTINCT FROM ($1->>'step')::bigint OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
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
  -- Preparation bound this job to the observed request, and the guard still
  -- holds that identity. Finish exactly that request without using source time
  -- to infer whether a different/newer request was answered.
  UPDATE public.energy_optimisation_current SET replan_completed_request_id=replan_request_id,replan_error=NULL
    WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
  UPDATE private.energy_planning_jobs SET state='published',plan_id=r.id,lease_until=NULL,finished_at=now()
    WHERE id=j.id RETURNING * INTO j;
  RETURN private.energy_planning_receipt(j,false);
END; $$;

CREATE OR REPLACE FUNCTION public.fail_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint OR j.step IS DISTINCT FROM ($1->>'step')::bigint
    OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
  IF NULLIF($1->>'code','') IS NULL OR NULLIF($1->>'detail','') IS NULL THEN RAISE EXCEPTION 'Missing planning failure'; END IF;
  UPDATE private.energy_planning_jobs SET state='failed',code=$1->>'code',detail=$1->>'detail',
    lease_until=NULL,finished_at=now() WHERE id=j.id RETURNING * INTO j;
  UPDATE public.energy_optimisation_current SET replan_error=j.detail
    WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
  RETURN private.energy_planning_receipt(j);
END; $$;
