-- A job outlives its HTTP exchanges. HA's existing receipt polls drive bounded
-- batches through ingest -> plan-step; no per-slice SQL writes or new worker.
WITH cancelled AS (
  UPDATE private.energy_planning_jobs SET state='failed',fence=fence+1,lease_until=NULL,
    finished_at=clock_timestamp(),code='planner_upgraded',detail='Planning execution changed. Request a new replan.'
    WHERE state='pending' RETURNING id,home_id,context,detail
)
UPDATE public.energy_optimisation_current c SET replan_error=j.detail
  FROM cancelled j JOIN private.energy_planning_heads h ON h.active_job_id=j.id AND h.home_id=j.home_id
  WHERE c.home_id=j.home_id AND c.replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND c.replan_request_id IS DISTINCT FROM c.replan_completed_request_id;
DROP FUNCTION public.claim_energy_planning_job(uuid);
DROP FUNCTION private.expire_energy_planning_job(uuid);
DROP INDEX private.energy_planning_jobs_due;
ALTER TABLE private.energy_planning_jobs DROP COLUMN deadline_at,
  ADD COLUMN phase text NOT NULL DEFAULT 'solving' CHECK (phase IN ('solving','assembling')),
  ADD COLUMN steps bigint NOT NULL DEFAULT 0 CHECK (steps >= 0),
  ADD COLUMN continuation json;
ALTER TABLE private.energy_planning_jobs ALTER COLUMN continuation SET COMPRESSION lz4;
CREATE TABLE private.energy_planning_parts (
  job_id uuid NOT NULL REFERENCES private.energy_planning_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('completed','rankings')),
  ordinal bigint NOT NULL CHECK (ordinal > 0),
  value json NOT NULL,
  PRIMARY KEY (job_id,kind,ordinal)
);
ALTER TABLE private.energy_planning_parts ALTER COLUMN value SET COMPRESSION lz4;
ALTER TABLE private.energy_planning_parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_planning_parts FROM PUBLIC,anon,authenticated,service_role;

-- Claims never encode the frozen input or accumulated results while holding
-- the home lock. Expiry permits takeover, not deletion or terminal failure.
CREATE FUNCTION public.claim_energy_planning_batch(p_home_id uuid,p_job_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id) THEN RETURN NULL; END IF;
  j:=private.lock_energy_planning_job(p_job_id);
  IF j.id IS NULL OR j.state<>'pending' OR j.lease_until>clock_timestamp() THEN RETURN NULL; END IF;
  UPDATE private.energy_planning_jobs SET fence=fence+1,lease_until=clock_timestamp()+interval '60 seconds'
    WHERE id=j.id RETURNING * INTO j;
  RETURN json_build_object('id',j.id,'home_id',j.home_id,'customer_id',j.customer_id,'snapshot_id',j.snapshot_id,
    'protocol',j.protocol,'fence',j.fence,'steps',j.steps,'phase',j.phase);
END; $$;

CREATE FUNCTION public.load_energy_planning_batch(p_home_id uuid,p_job_id uuid,p_fence bigint)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id
    AND state='pending' AND fence=p_fence AND lease_until IS NOT NULL;
  IF NOT FOUND OR NOT private.energy_planning_is_current(j) THEN RETURN NULL; END IF;
  RETURN json_build_object('input',j.input,'context',j.context,
    'continuation',json_build_object(
      'completed',COALESCE((SELECT json_agg(value ORDER BY ordinal) FROM private.energy_planning_parts WHERE job_id=j.id AND kind='completed'),'[]'::json),
      'rankings',COALESCE((SELECT json_agg(value ORDER BY ordinal) FROM private.energy_planning_parts WHERE job_id=j.id AND kind='rankings'),'[]'::json),
      'checkpoint',j.continuation->'checkpoint','ranking_checkpoint',j.continuation->'ranking_checkpoint'));
END; $$;

-- Fence and the last successful step count make a batch commit exactly once.
-- Append only new ordered results; never rewrite the whole growing ledger.
CREATE FUNCTION public.commit_energy_planning_batch(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private SET statement_timeout='8s' AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_kind text; v_count bigint; v_calls integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.energy_planning_jobs WHERE id=($1->>'job_id')::uuid AND home_id=($1->>'home_id')::uuid) THEN RETURN NULL; END IF;
  j:=private.lock_energy_planning_job(($1->>'job_id')::uuid);
  IF j.id IS NULL OR j.state<>'pending' OR j.phase<>'solving' OR j.fence IS DISTINCT FROM ($1->>'fence')::bigint
    OR j.steps IS DISTINCT FROM ($1->>'steps')::bigint OR j.lease_until IS NULL THEN RETURN NULL; END IF;
  v_calls:=($1->>'calls')::integer;
  IF v_calls IS NULL OR v_calls<0 OR v_calls>8 OR $1->>'phase' IS NULL OR $1->>'phase' NOT IN ('solving','assembling')
    OR json_typeof($1->'completed') IS DISTINCT FROM 'array' OR json_typeof($1->'rankings') IS DISTINCT FROM 'array'
    OR json_typeof($1->'continuation') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid planning batch' USING ERRCODE='22023';
  END IF;
  IF $1->>'phase'='assembling' AND (COALESCE(json_typeof($1->'continuation'->'checkpoint'),'null')<>'null'
    OR COALESCE(json_typeof($1->'continuation'->'ranking_checkpoint'),'null')<>'null') THEN
    RAISE EXCEPTION 'Completed planning batch has an active checkpoint' USING ERRCODE='22023';
  END IF;
  FOREACH v_kind IN ARRAY ARRAY['completed','rankings'] LOOP
    SELECT COALESCE(max(ordinal),0) INTO v_count FROM private.energy_planning_parts WHERE job_id=j.id AND kind=v_kind;
    INSERT INTO private.energy_planning_parts(job_id,kind,ordinal,value)
      SELECT j.id,v_kind,v_count+ordinal,value FROM json_array_elements($1->v_kind) WITH ORDINALITY AS parts(value,ordinal);
  END LOOP;
  UPDATE private.energy_planning_jobs SET continuation=$1->'continuation',phase=$1->>'phase',
    steps=steps+v_calls,lease_until=NULL WHERE id=j.id RETURNING * INTO j;
  RETURN private.energy_planning_receipt(j);
END; $$;

CREATE OR REPLACE FUNCTION public.accept_energy_planning_job(json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; c public.energy_optimisation_current%ROWTYPE;
  v_home uuid:=($1->>'home_id')::uuid; v_revision bigint;
BEGIN
  IF json_typeof($1->'input') IS DISTINCT FROM 'object' OR json_typeof($1->'context') IS DISTINCT FROM 'object'
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
  IF COALESCE(c.fixed_plan_revision,0)<>($1->'context'->>'fixed_revision')::integer
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
 OR j.lease_until IS NULL OR j.phase<>'assembling'
 OR j.steps IS DISTINCT FROM ($1->>'steps')::bigint THEN RETURN NULL; END IF;
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
    OR j.lease_until IS NULL OR j.steps IS DISTINCT FROM ($1->>'steps')::bigint THEN RETURN NULL; END IF;
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
BEGIN
  -- A missing HA connection pauses progression; it never discards healthy work.
  DELETE FROM private.energy_planning_jobs WHERE id IN (
    SELECT id FROM private.energy_planning_jobs WHERE state<>'pending'
      AND finished_at<now()-CASE WHEN state='failed' THEN interval '14 days' ELSE interval '7 days' END
    ORDER BY finished_at LIMIT 100);
END; $$;
REVOKE ALL ON FUNCTION public.claim_energy_planning_batch(uuid,uuid),
  public.load_energy_planning_batch(uuid,uuid,bigint),public.commit_energy_planning_batch(json)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_energy_planning_batch(uuid,uuid),
  public.load_energy_planning_batch(uuid,uuid,bigint),public.commit_energy_planning_batch(json) TO service_role;
