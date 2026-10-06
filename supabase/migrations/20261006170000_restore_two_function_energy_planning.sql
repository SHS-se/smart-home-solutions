-- Restore ingest -> plan-step execution. Jobs are durable receipts, not a
-- database checkpoint chain. Execution deadlines are operational budgets;
-- they never constrain measurements, forecast validity or plan expiry.
WITH cancelled AS (
  UPDATE private.energy_planning_jobs SET state='failed',fence=fence+1,lease_until=NULL,
    finished_at=clock_timestamp(),code='planner_upgraded',detail='Planning execution changed. Request a new replan.'
    WHERE state='pending' RETURNING id,home_id,context,detail
)
UPDATE public.energy_optimisation_current c SET replan_error=j.detail
  FROM cancelled j JOIN private.energy_planning_heads h ON h.active_job_id=j.id AND h.home_id=j.home_id
  WHERE c.home_id=j.home_id AND c.replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND c.replan_request_id IS DISTINCT FROM c.replan_completed_request_id;
ALTER TABLE private.energy_planning_jobs ADD COLUMN deadline_at timestamptz;
UPDATE private.energy_planning_jobs SET deadline_at=created_at+interval '10 seconds';
ALTER TABLE private.energy_planning_jobs ALTER COLUMN deadline_at SET NOT NULL;
DROP INDEX private.energy_planning_jobs_due;
CREATE INDEX energy_planning_jobs_due ON private.energy_planning_jobs(deadline_at) WHERE state='pending';

CREATE FUNCTION private.expire_energy_planning_job(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  j:=private.lock_energy_planning_job(p_job_id);
  IF j.id IS NULL OR j.state<>'pending' OR j.deadline_at>clock_timestamp() THEN RETURN; END IF;
  UPDATE private.energy_planning_jobs SET state='failed',fence=fence+1,lease_until=NULL,
    finished_at=clock_timestamp(),code='planning_deadline_exceeded',
    detail='Replanning exceeded the 10-second request deadline.' WHERE id=j.id RETURNING * INTO j;
  UPDATE public.energy_optimisation_current SET replan_error=j.detail
    WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
END; $$;

CREATE FUNCTION public.claim_energy_planning_job(p_job_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_payload json;
BEGIN
  PERFORM private.expire_energy_planning_job(p_job_id);
  j:=private.lock_energy_planning_job(p_job_id);
  IF j.id IS NULL OR j.state<>'pending' OR j.lease_until IS NOT NULL THEN RETURN NULL; END IF;
  v_payload:=json_build_object('id',j.id,'home_id',j.home_id,'customer_id',j.customer_id,'snapshot_id',j.snapshot_id,
    'protocol',j.protocol,'fence',j.fence+1,'input',j.input,'context',j.context,'deadline_at',j.deadline_at);
  -- Input encoding belongs to the same request budget, never a fresh lease.
  IF clock_timestamp()>=j.deadline_at THEN
    PERFORM private.expire_energy_planning_job(j.id);
    RETURN NULL;
  END IF;
  UPDATE private.energy_planning_jobs SET fence=fence+1,lease_until=deadline_at WHERE id=j.id;
  RETURN v_payload;
END; $$;

CREATE OR REPLACE FUNCTION public.accept_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; c public.energy_optimisation_current%ROWTYPE;
  v_home uuid:=($1->>'home_id')::uuid; v_revision bigint;
BEGIN
  IF json_typeof($1->'input') IS DISTINCT FROM 'object' OR json_typeof($1->'context') IS DISTINCT FROM 'object'
    OR $1->>'deadline_at' IS NULL OR $1->>'source_hash' IS NULL OR $1->'context'->>'fixed_revision' IS NULL THEN
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
  IF COALESCE(c.fixed_plan_revision,0)<>($1->'context'->>'fixed_revision')::integer
    OR c.replan_request_id IS DISTINCT FROM ($1->'context'->>'observed_replan_request_id')::uuid
    OR ($1->'context'->>'replan_request_id' IS NOT NULL
      AND c.replan_request_id IS DISTINCT FROM ($1->'context'->>'replan_request_id')::uuid) THEN
    RAISE EXCEPTION 'Planning request changed during preparation' USING ERRCODE='22023';
  END IF;
  UPDATE private.energy_planning_jobs SET state='superseded',lease_until=NULL,finished_at=now()
    WHERE id=(SELECT active_job_id FROM private.energy_planning_heads WHERE home_id=v_home) AND state='pending';
  UPDATE private.energy_planning_heads SET revision=revision+1 WHERE home_id=v_home RETURNING revision INTO v_revision;
  INSERT INTO private.energy_planning_jobs(home_id,customer_id,snapshot_id,source_hash,revision,protocol,input,context,deadline_at)
    VALUES(v_home,($1->>'customer_id')::uuid,($1->>'snapshot_id')::uuid,$1->>'source_hash',v_revision,
      ($1->>'protocol')::integer,$1->'input',$1->'context',($1->>'deadline_at')::timestamptz) RETURNING * INTO j;
  UPDATE private.energy_planning_heads SET active_job_id=j.id WHERE home_id=v_home;
  PERFORM private.expire_energy_planning_job(j.id);
  SELECT * INTO j FROM private.energy_planning_jobs WHERE id=j.id;
  RETURN private.energy_planning_receipt(j);
END; $$;

CREATE OR REPLACE FUNCTION public.publish_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='30s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; r public.energy_optimisation_plan_runs%ROWTYPE; v_current jsonb:=$1->'current';
BEGIN
  PERFORM private.expire_energy_planning_job(($1->>'job_id')::uuid);
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.state='failed' THEN RETURN private.energy_planning_receipt(j); END IF;
  IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint
 OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
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
  BEGIN
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
  IF clock_timestamp() >= j.deadline_at THEN
    RAISE EXCEPTION 'Planning publication exceeded its request deadline' USING ERRCODE='57014';
  END IF;
  EXCEPTION WHEN query_canceled THEN
    -- Roll back current/run/request writes before recording terminal failure.
    PERFORM private.expire_energy_planning_job(j.id);
    SELECT * INTO j FROM private.energy_planning_jobs WHERE id=j.id;
    RETURN private.energy_planning_receipt(j);
  END;
  RETURN private.energy_planning_receipt(j,false);
END; $$;

CREATE OR REPLACE FUNCTION public.fail_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  PERFORM private.expire_energy_planning_job(($1->>'job_id')::uuid);
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.state='failed' THEN RETURN private.energy_planning_receipt(j); END IF;
  IF j.id IS NULL OR j.state<>'pending' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint
    OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
  IF NULLIF($1->>'code','') IS NULL OR NULLIF($1->>'detail','') IS NULL THEN RAISE EXCEPTION 'Missing planning failure'; END IF;
  UPDATE private.energy_planning_jobs SET state='failed',code=$1->>'code',detail=$1->>'detail',
    lease_until=NULL,finished_at=now() WHERE id=j.id RETURNING * INTO j;
  UPDATE public.energy_optimisation_current SET replan_error=j.detail
    WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
  RETURN private.energy_planning_receipt(j);
END; $$;
CREATE OR REPLACE FUNCTION private.sweep_energy_planning_jobs()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM private.energy_planning_jobs WHERE state='pending' AND deadline_at<=clock_timestamp()
    ORDER BY deadline_at LIMIT 20 LOOP
    PERFORM private.expire_energy_planning_job(v_id);
  END LOOP;
  DELETE FROM private.energy_planning_jobs WHERE id IN (
    SELECT id FROM private.energy_planning_jobs WHERE state<>'pending'
      AND finished_at<now()-CASE WHEN state='failed' THEN interval '14 days' ELSE interval '7 days' END
    ORDER BY finished_at LIMIT 100);
END; $$;

DROP FUNCTION public.commit_energy_planning_step(json);
DROP FUNCTION public.claim_energy_planning_step(uuid);
DROP FUNCTION public.verify_energy_planning_token(text);
DROP FUNCTION private.wake_energy_planning_job(uuid);
DROP TABLE private.energy_planning_credentials;
DROP TABLE private.energy_planning_parts;
ALTER TABLE private.energy_planning_jobs DROP COLUMN continuation, DROP COLUMN phase,
  DROP COLUMN step, DROP COLUMN expiry_count, DROP COLUMN wake_after;
REVOKE ALL ON FUNCTION private.expire_energy_planning_job(uuid),public.claim_energy_planning_job(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_energy_planning_job(uuid) TO service_role;

-- Cloud publication is not completion: the matching HA acknowledgement is.
CREATE FUNCTION private.complete_energy_planning_delivery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE v_request uuid;
BEGIN
  SELECT (context->>'observed_replan_request_id')::uuid INTO v_request
    FROM private.energy_planning_jobs WHERE home_id=NEW.home_id AND plan_id=NEW.plan_id
      AND snapshot_id=NEW.snapshot_id AND state='published';
  IF v_request IS NULL OR v_request IS DISTINCT FROM NEW.replan_request_id THEN RETURN NEW; END IF;
  IF NEW.ha_ack_status='accepted' THEN
    UPDATE public.energy_optimisation_current SET replan_completed_request_id=v_request,replan_error=NULL
      WHERE home_id=NEW.home_id AND plan_id=NEW.plan_id AND replan_request_id=v_request;
  ELSIF NEW.ha_ack_status='rejected' THEN
    UPDATE public.energy_optimisation_current SET replan_error=NEW.ha_ack_error->>'message'
      WHERE home_id=NEW.home_id AND plan_id=NEW.plan_id AND replan_request_id=v_request;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER energy_planning_delivery_completed AFTER UPDATE OF ha_ack_status ON public.energy_optimisation_current
  FOR EACH ROW WHEN (NEW.ha_ack_status IN ('accepted','rejected'))
  EXECUTE FUNCTION private.complete_energy_planning_delivery();
REVOKE ALL ON FUNCTION private.complete_energy_planning_delivery() FROM PUBLIC,anon,authenticated;
