-- Protocol 10 persists an unsolved capture. Preparation and solve run in separate
-- authenticated requests under the existing durable owner and publication fence.
-- Old pending inputs fail explicitly as planner_upgraded; no dual protocol path.
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
