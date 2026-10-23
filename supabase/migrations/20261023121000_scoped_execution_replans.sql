-- Immutable execution evidence is a distinct automatic admission reason. Existing
-- reference, revision, and per-home job fences remain authoritative.
CREATE UNIQUE INDEX energy_planning_execution_request_identity
  ON private.energy_planning_jobs(home_id, ((context->'execution_replan'->>'request_id')))
  WHERE context->'execution_replan'->>'request_id' IS NOT NULL;

CREATE FUNCTION public.read_execution_planning_job(p_home_id uuid,p_request_id uuid)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=p_home_id
    AND context->'execution_replan'->>'request_id'=p_request_id::text;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN public.read_energy_planning_job(p_home_id,NULL,j.snapshot_id);
END; $$;
REVOKE ALL ON FUNCTION public.read_execution_planning_job(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_execution_planning_job(uuid,uuid) TO service_role;

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

CREATE OR REPLACE FUNCTION public.get_energy_replan_state(p_home_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE c public.energy_optimisation_current%ROWTYPE; reference jsonb;
BEGIN
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=p_home_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF c.plan->>'status'='ready' THEN
    SELECT jsonb_build_object('plan_id',c.plan_id,'operating_scope',c.snapshot->'operating_scope',
      'execution_availability',c.snapshot->'execution_availability','hot_water_permissions',c.plan->'hot_water_permissions','slots',COALESCE(jsonb_agg(jsonb_build_object(
      'start',value->'start','pool_w',value->'pool_w','pool_command_w',value->'pool_command_w','pool_permitted',value->'pool_permitted',
      'device_loads_w',value->'device_loads_w','room_heating_w',value->'room_heating_w',
      'ev_target_current_a',value->'ev_target_current_a','ev_min_current_a',value->'ev_min_current_a','ev_max_current_a',value->'ev_max_current_a',
      'boiler_battery_allowed',value->'boiler_battery_allowed','boiler_permitted',value->'boiler_permitted','boiler_expected_w',value->'boiler_expected_w',
      'battery_instruction',value->'battery_instruction','battery_command',value->'battery_command','device_commands',value->'device_commands') ORDER BY ordinal),'[]'::jsonb))
      INTO reference FROM jsonb_array_elements(c.plan->'plans'->'priority'->'slots') WITH ORDINALITY AS slots(value,ordinal);
  END IF;
  RETURN jsonb_build_object('fixed_plan',c.fixed_plan,'fixed_plan_revision',c.fixed_plan_revision,
    'reference_plan_id',c.plan_id,'ha_ack_status',c.ha_ack_status,'published_commands',reference);
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_replan_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_replan_state(uuid) TO service_role;
