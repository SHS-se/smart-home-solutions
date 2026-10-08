-- TEST mirrors do not have HA control authority. Their server-selected
-- publication basis completes a matching manual request without inventing an
-- acknowledgement. Other jobs retain the existing HA delivery completion.
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
