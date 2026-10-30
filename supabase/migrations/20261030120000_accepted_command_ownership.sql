-- Publication identity and actual accepted command ownership are independent.
CREATE TABLE private.energy_command_publications (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL, snapshot_id uuid NOT NULL, schema_version smallint NOT NULL,
  publication_revision bigint NOT NULL, commands jsonb NOT NULL,
  completion_basis text NOT NULL DEFAULT 'home_assistant_ack' CHECK(completion_basis IN ('home_assistant_ack','publication')),
  horizon_end timestamptz, battery_contract jsonb,
  accepted_at timestamptz, rejected_at timestamptz, rejection jsonb,
  PRIMARY KEY(home_id,plan_id)
);
CREATE UNIQUE INDEX energy_command_publications_battery ON private.energy_command_publications(home_id,(battery_contract->>'id'))
  WHERE battery_contract->>'id' IS NOT NULL;
REVOKE ALL ON private.energy_command_publications FROM PUBLIC,anon,authenticated;
ALTER TABLE public.energy_optimisation_current
  ADD COLUMN accepted_household_reference jsonb,
  ADD COLUMN accepted_battery_reference jsonb,
  ADD COLUMN accepted_reference_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN accepted_reference_unresolved boolean NOT NULL DEFAULT false;

CREATE FUNCTION private.energy_command_reference(p_plan jsonb,p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT jsonb_build_object('plan_id',p_plan->'plan_id',
    'pool_planning_basis',p_plan->'pool'->'planning_basis','pool_stop_temperature_c',p_plan->'pool'->'stop_temperature_c',
    'operating_scope',p_snapshot->'operating_scope','execution_availability',p_snapshot->'execution_availability',
    'hot_water_permissions',p_plan->'hot_water_permissions',
    'battery_contract',CASE WHEN p_plan->'battery_execution'->>'id' IS NOT NULL THEN jsonb_build_object(
      'id',p_plan->'battery_execution'->'id','scope_revision',p_plan->'battery_execution'->'scope_revision',
      'generation',p_plan->'battery_execution'->'generation') ELSE NULL END,
    'slots',COALESCE(jsonb_agg(jsonb_build_object(
      'start',value->'start','pool_w',value->'pool_w','pool_command_w',value->'pool_command_w','pool_permitted',value->'pool_permitted',
      'device_loads_w',value->'device_loads_w','room_heating_w',value->'room_heating_w',
      'ev_target_current_a',value->'ev_target_current_a','ev_min_current_a',value->'ev_min_current_a','ev_max_current_a',value->'ev_max_current_a',
      'boiler_battery_allowed',value->'boiler_battery_allowed','boiler_permitted',value->'boiler_permitted','boiler_expected_w',value->'boiler_expected_w',
      'battery_instruction',value->'battery_instruction','battery_command',value->'battery_command','device_commands',value->'device_commands') ORDER BY ordinal),'[]'::jsonb))
    FROM jsonb_array_elements(COALESCE(p_plan->'plans'->'priority'->'slots','[]'::jsonb)) WITH ORDINALITY AS slots(value,ordinal);
$$;

-- The existing home head is the explicit cutover high-water. The authoritative
-- current publication outranks retained older candidates even if its job was
-- pruned. New publications advance that head; no predecessor order is invented.
INSERT INTO private.energy_command_publications(home_id,plan_id,snapshot_id,schema_version,publication_revision,commands,horizon_end,battery_contract,accepted_at,rejected_at,rejection,completion_basis)
SELECT c.home_id,c.plan_id,c.snapshot_id,c.plan_schema_version,COALESCE(h.revision,0),
  private.energy_command_reference(c.plan,c.snapshot),
  (SELECT max((s->>'start')::timestamptz)+make_interval(mins=>COALESCE((c.snapshot->>'slot_minutes')::int,15))
    FROM jsonb_array_elements(COALESCE(c.plan->'plans'->'priority'->'slots','[]'::jsonb)) s),
  private.energy_command_reference(c.plan,c.snapshot)->'battery_contract',
  CASE WHEN c.ha_ack_status='accepted' THEN c.ha_acknowledged_at END,
  CASE WHEN c.ha_ack_status='rejected' THEN c.ha_acknowledged_at END,c.ha_ack_error,COALESCE(j.context->>'completion_basis','home_assistant_ack')
FROM public.energy_optimisation_current c LEFT JOIN private.energy_planning_heads h ON h.home_id=c.home_id
LEFT JOIN private.energy_planning_jobs j ON j.home_id=c.home_id AND j.plan_id=c.plan_id
WHERE c.plan_id IS NOT NULL AND c.plan_schema_version IS NOT NULL;
UPDATE public.energy_optimisation_current c SET
  accepted_household_reference=CASE WHEN c.ha_ack_status='accepted' THEN p.commands||jsonb_build_object('publication_revision',p.publication_revision) END,
  accepted_battery_reference=CASE WHEN c.ha_runtime->'battery_plan'->'accepted'->>'plan_id'=p.plan_id::text
    AND c.ha_runtime->'battery_plan'->'accepted'->>'contract_id'=p.battery_contract->>'id'
    AND c.ha_runtime->'battery_plan'->'accepted'->>'scope_revision'=p.battery_contract->>'scope_revision'
    AND c.ha_runtime->'battery_plan'->'accepted'->>'generation'=p.battery_contract->>'generation'
    THEN p.commands||jsonb_build_object('publication_revision',p.publication_revision) END
FROM private.energy_command_publications p WHERE p.home_id=c.home_id AND p.plan_id=c.plan_id;

-- Older accepted commands are recoverable only with exact server run evidence
-- and the publication's own revision; never infer a predecessor revision.
INSERT INTO private.energy_command_publications(home_id,plan_id,snapshot_id,schema_version,publication_revision,commands,horizon_end,accepted_at)
SELECT DISTINCT ON (run.home_id,run.id) run.home_id,run.id,run.snapshot_id,run.plan_schema_version,own.revision,
  (captured.input->'reference')::jsonb,
  (SELECT max((s->>'start')::timestamptz)+interval '15 minutes' FROM jsonb_array_elements((captured.input->'reference'->'slots')::jsonb) s),run.ha_acknowledged_at
FROM public.energy_optimisation_plan_runs run
JOIN private.energy_planning_jobs own ON own.home_id=run.home_id AND own.plan_id=run.id
JOIN private.energy_planning_jobs captured ON captured.home_id=run.home_id AND captured.input->'reference'->>'plan_id'=run.id::text
WHERE run.ha_ack_status='accepted' AND run.plan_schema_version IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE public.energy_optimisation_current c SET accepted_household_reference=p.commands||jsonb_build_object('publication_revision',p.publication_revision)
FROM private.energy_command_publications p WHERE p.home_id=c.home_id AND p.accepted_at IS NOT NULL
  AND (c.accepted_household_reference IS NULL OR (c.accepted_household_reference->>'publication_revision')::bigint<p.publication_revision)
  AND NOT EXISTS (SELECT 1 FROM private.energy_command_publications newer WHERE newer.home_id=p.home_id AND newer.accepted_at IS NOT NULL AND newer.publication_revision>p.publication_revision);
UPDATE public.energy_optimisation_current c SET accepted_reference_unresolved=true
WHERE (c.accepted_household_reference IS NULL AND EXISTS(SELECT 1 FROM public.energy_optimisation_plan_runs r WHERE r.home_id=c.home_id AND r.ha_ack_status='accepted'))
 OR (c.ha_runtime->'battery_plan'->'accepted'->>'contract_id' IS NOT NULL AND c.accepted_battery_reference IS NULL
   AND NOT EXISTS(SELECT 1 FROM private.energy_planning_jobs j WHERE j.home_id=c.home_id AND j.plan_id=c.plan_id AND j.context->>'completion_basis'='publication'));

-- Explicit mirror completion authority governs the cutover, not historical ACK
-- summaries. A non-executing mirror has no local command owner to preserve.
UPDATE public.energy_optimisation_current c SET accepted_household_reference=NULL,
  accepted_battery_reference=NULL,accepted_reference_unresolved=false
WHERE EXISTS(SELECT 1 FROM private.energy_command_publications p WHERE p.home_id=c.home_id AND p.plan_id=c.plan_id AND p.completion_basis='publication');
UPDATE private.energy_command_publications p SET completion_basis='publication'
WHERE EXISTS(SELECT 1 FROM public.energy_optimisation_current c JOIN private.energy_command_publications current_p
 ON current_p.home_id=c.home_id AND current_p.plan_id=c.plan_id
 WHERE c.home_id=p.home_id AND current_p.completion_basis='publication');

CREATE OR REPLACE FUNCTION public.get_energy_replan_state(p_home_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT jsonb_build_object('fixed_plan',c.fixed_plan,'fixed_plan_revision',c.fixed_plan_revision,
   'reference_plan_id',c.plan_id,'accepted_reference_revision',c.accepted_reference_revision,
   'accepted_commands',jsonb_build_object('state',CASE WHEN c.accepted_reference_unresolved THEN 'unresolved' ELSE 'ready' END,
     'household',c.accepted_household_reference,'battery',c.accepted_battery_reference))
 FROM public.energy_optimisation_current c WHERE home_id=p_home_id;
$$;

-- All ownership writers serialize in the same head -> current -> job order.
CREATE FUNCTION private.promote_energy_command_reference(p_home_id uuid,p_plan_id uuid,p_owner text)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE p private.energy_command_publications%ROWTYPE; old jsonb;
BEGIN
  IF p_owner NOT IN ('household','battery') THEN RAISE EXCEPTION 'Unknown command owner'; END IF;
  SELECT * INTO p FROM private.energy_command_publications WHERE home_id=p_home_id AND plan_id=p_plan_id;
  IF NOT FOUND OR p.completion_basis='publication' THEN RETURN false; END IF;
  SELECT CASE WHEN p_owner='household' THEN accepted_household_reference ELSE accepted_battery_reference END INTO old
    FROM public.energy_optimisation_current WHERE home_id=p_home_id;
  IF old IS NOT NULL AND (old->>'publication_revision')::bigint>=p.publication_revision THEN RETURN true; END IF;
  UPDATE public.energy_optimisation_current SET
    accepted_household_reference=CASE WHEN p_owner='household' THEN p.commands||jsonb_build_object('publication_revision',p.publication_revision) ELSE accepted_household_reference END,
    accepted_battery_reference=CASE WHEN p_owner='battery' THEN p.commands||jsonb_build_object('publication_revision',p.publication_revision) ELSE accepted_battery_reference END,
    accepted_reference_revision=accepted_reference_revision+1
  WHERE home_id=p_home_id;
  UPDATE public.energy_optimisation_current SET accepted_reference_unresolved=false
    WHERE home_id=p_home_id AND accepted_reference_unresolved AND accepted_household_reference IS NOT NULL
      AND (ha_runtime->'battery_plan'->'accepted'->>'contract_id' IS NULL OR accepted_battery_reference IS NOT NULL);
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.acknowledge_energy_optimisation_plan(
  p_home_id uuid,p_plan_id uuid,p_snapshot_id uuid,p_plan_schema_version smallint,p_ack_status text,
  p_acknowledged_at timestamptz,p_integration_version text,p_ack_request_id text,p_ack_error jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE p private.energy_command_publications%ROWTYPE; outcome text;
BEGIN
  IF p_ack_status NOT IN ('accepted','rejected') THEN RAISE EXCEPTION 'Invalid acknowledgement status'; END IF;
  PERFORM 1 FROM private.energy_planning_heads WHERE home_id=p_home_id FOR UPDATE;
  PERFORM 1 FROM public.energy_optimisation_current WHERE home_id=p_home_id FOR UPDATE;
  SELECT * INTO p FROM private.energy_command_publications WHERE home_id=p_home_id AND plan_id=p_plan_id
    AND snapshot_id=p_snapshot_id AND schema_version=p_plan_schema_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE private.energy_command_publications SET
    accepted_at=CASE WHEN p_ack_status='accepted' THEN COALESCE(accepted_at,p_acknowledged_at) ELSE accepted_at END,
    rejected_at=CASE WHEN p_ack_status='rejected' THEN COALESCE(rejected_at,p_acknowledged_at) ELSE rejected_at END,
    rejection=CASE WHEN p_ack_status='rejected' THEN COALESCE(rejection,p_ack_error) ELSE rejection END
    WHERE home_id=p_home_id AND plan_id=p_plan_id RETURNING * INTO p;
  outcome:=CASE WHEN p.accepted_at IS NOT NULL THEN 'accepted' ELSE 'rejected' END;
  IF p_ack_status='accepted' THEN PERFORM private.promote_energy_command_reference(p_home_id,p_plan_id,'household'); END IF;
  UPDATE public.energy_optimisation_current SET ha_ack_status=outcome,
    ha_acknowledged_at=COALESCE(p.accepted_at,p.rejected_at),ha_integration_version=p_integration_version,
    ha_ack_request_id=p_ack_request_id,ha_ack_error=CASE WHEN outcome='rejected' THEN p.rejection END,updated_at=now()
    WHERE home_id=p_home_id AND plan_id=p_plan_id AND snapshot_id=p_snapshot_id AND plan_schema_version=p_plan_schema_version;
  UPDATE public.energy_optimisation_plan_runs SET ha_ack_status=outcome,
    ha_acknowledged_at=COALESCE(p.accepted_at,p.rejected_at),ha_integration_version=p_integration_version,
    ha_ack_request_id=p_ack_request_id,ha_ack_error=CASE WHEN outcome='rejected' THEN p.rejection END
    WHERE home_id=p_home_id AND id=p_plan_id AND snapshot_id=p_snapshot_id AND plan_schema_version=p_plan_schema_version;
  RETURN true;
END; $$;

-- Runtime admission, not publication or cache validation, resolves a handover.
CREATE OR REPLACE FUNCTION public.report_energy_runtime(p_home_id uuid, p_runtime jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,private AS $$
DECLARE
  current_row public.energy_optimisation_current%ROWTYPE;
  reference jsonb;
  admitted jsonb := p_runtime->'battery_plan'->'accepted';
  rejected jsonb := p_runtime->'battery_plan'->'rejection';
  recommendations jsonb;
BEGIN
  PERFORM 1 FROM private.energy_planning_heads WHERE home_id=p_home_id FOR UPDATE;
  PERFORM 1 FROM public.energy_optimisation_current WHERE home_id=p_home_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM private.energy_command_publications p WHERE p.home_id=p_home_id
    AND p.plan_id::text=admitted->>'plan_id' AND p.battery_contract->>'id'=admitted->>'contract_id'
    AND p.battery_contract->>'scope_revision'=admitted->>'scope_revision'
    AND p.battery_contract->>'generation'=admitted->>'generation') THEN
    PERFORM private.promote_energy_command_reference(p_home_id,(admitted->>'plan_id')::uuid,'battery');
  END IF;
  SELECT * INTO current_row FROM public.energy_optimisation_current WHERE home_id=p_home_id FOR UPDATE;
  IF NOT FOUND OR (current_row.ha_runtime IS NOT NULL AND
    (current_row.ha_runtime->>'observed_at')::timestamptz >= (p_runtime->>'observed_at')::timestamptz) THEN
    RETURN false;
  END IF;
  reference := current_row.plan->'battery_execution';
  recommendations := current_row.replan_recommendations;
  IF current_row.status='ready' AND admitted->>'plan_id'=current_row.plan_id::text
    AND admitted->>'contract_id'=reference->>'id'
    AND admitted->>'scope_revision'=reference->>'scope_revision'
    AND admitted->>'generation'=reference->>'generation' THEN
    SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO recommendations
      FROM jsonb_array_elements(recommendations) r
      WHERE NOT coalesce((r->>'key'='battery_plan_handover'
        AND r->>'scope_revision'=admitted->>'scope_revision'
        AND (r->>'generation')::bigint <= (admitted->>'generation')::bigint),false);
  ELSIF current_row.status='ready' AND rejected->>'contract_id'=reference->>'id'
    AND rejected->>'generation'=reference->>'generation'
    AND NOT coalesce(
      current_row.ha_runtime->'battery_plan'->'accepted'->>'plan_id'=current_row.plan_id::text
      AND current_row.ha_runtime->'battery_plan'->'accepted'->>'contract_id'=reference->>'id', false) THEN
    -- Obsolete contracts never create recommendations for a newer publication.
    SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO recommendations
      FROM jsonb_array_elements(recommendations) r
      WHERE NOT coalesce((r->>'key'='battery_plan_handover'
        AND r->>'scope_revision'=reference->>'scope_revision'
        AND (r->>'generation')::bigint <= (rejected->>'generation')::bigint),false);
    recommendations := recommendations || jsonb_build_array(jsonb_build_object(
      'key','battery_plan_handover', 'scope_revision',reference->>'scope_revision',
      'generation',(reference->>'generation')::bigint,
      'reason','Battery controller could not accept the replacement plan: ' || (rejected->>'reason'),
      'occurred_at',clock_timestamp()));
  END IF;
  UPDATE public.energy_optimisation_current
    SET ha_runtime=p_runtime, ha_runtime_received_at=clock_timestamp(), replan_recommendations=recommendations
    WHERE home_id=p_home_id;
  RETURN true;
END; $$;


CREATE OR REPLACE FUNCTION private.lock_energy_planning_job(p_job_id uuid)
RETURNS private.energy_planning_jobs LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_home uuid; accepted_revision bigint;
BEGIN
  SELECT home_id INTO v_home FROM private.energy_planning_jobs WHERE id=p_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM private.energy_planning_heads WHERE home_id=v_home FOR UPDATE;
  SELECT accepted_reference_revision INTO accepted_revision FROM public.energy_optimisation_current WHERE home_id=v_home FOR UPDATE;
  SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id FOR UPDATE;
  IF j.state='pending' AND NOT private.energy_planning_is_current(j) THEN
    UPDATE private.energy_planning_jobs SET state='superseded',lease_until=NULL,finished_at=now() WHERE id=j.id RETURNING * INTO j;
  ELSIF j.state='pending' AND (j.context->>'accepted_reference_revision')::bigint IS DISTINCT FROM COALESCE(accepted_revision,0) THEN
    UPDATE private.energy_planning_jobs SET state='failed',code='accepted_reference_changed',
      detail='Accepted command ownership changed. A fresh capture is required.',fence=fence+1,lease_until=NULL,finished_at=now()
      WHERE id=j.id RETURNING * INTO j;
  END IF;
  RETURN j;
END; $$;
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
    IF (c.accepted_household_reference->>'plan_id')::uuid IS DISTINCT FROM ($1->'context'->'execution_replan'->>'accepted_plan_id')::uuid
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
  IF c.accepted_reference_unresolved THEN RAISE EXCEPTION 'Accepted command provenance is unresolved' USING ERRCODE='22023'; END IF;
  IF COALESCE(c.accepted_reference_revision,0) IS DISTINCT FROM ($1->'context'->>'accepted_reference_revision')::bigint THEN
    RAISE EXCEPTION 'Accepted command ownership changed during preparation' USING ERRCODE='P4091';
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
      'recapture',CASE WHEN p_job.code IN ('planner_upgraded','capture_horizon_ended','accepted_reference_changed') AND private.energy_planning_is_current(p_job)
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
CREATE OR REPLACE FUNCTION private.require_energy_planning_recapture(p_home_id uuid,p_job_id uuid,
  p_replan_request_id uuid,p_execution_replan jsonb)
RETURNS json LANGUAGE plpgsql STABLE SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM private.energy_planning_jobs WHERE id=p_job_id AND home_id=p_home_id;
  IF NOT FOUND OR j.state<>'failed' OR j.code NOT IN ('planner_upgraded','capture_horizon_ended','accepted_reference_changed') OR NOT private.energy_planning_is_current(j)
    OR (j.context->>'replan_request_id')::uuid IS DISTINCT FROM p_replan_request_id
    OR (j.code<>'accepted_reference_changed' AND j.context->'execution_replan'->>'accepted_plan_id' IS DISTINCT FROM p_execution_replan->>'accepted_plan_id')
    OR ((j.context->'execution_replan'->>'request_id' IS NULL) IS DISTINCT FROM (p_execution_replan->>'request_id' IS NULL)) THEN
    RAISE EXCEPTION 'Planning recapture authority is no longer current or has a different purpose' USING ERRCODE='22023';
  END IF;
  RETURN j.context;
END; $$;-- TEST mirrors do not have HA control authority. Their server-selected
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
  INSERT INTO private.energy_command_publications(home_id,plan_id,snapshot_id,schema_version,publication_revision,commands,horizon_end,battery_contract,completion_basis)
  VALUES(j.home_id,r.id,j.snapshot_id,r.plan_schema_version,j.revision,
    private.energy_command_reference(v_current->'plan',v_current->'snapshot'),
    (SELECT max((s->>'start')::timestamptz)+make_interval(mins=>(v_current->'snapshot'->>'slot_minutes')::int)
      FROM jsonb_array_elements(COALESCE(v_current->'plan'->'plans'->'priority'->'slots','[]'::jsonb)) s),
    private.energy_command_reference(v_current->'plan',v_current->'snapshot')->'battery_contract',COALESCE(j.context->>'completion_basis','home_assistant_ack'));
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

-- Old immutable jobs cannot inherit newly introduced command ownership semantics.
UPDATE private.energy_planning_jobs SET state='failed',code='accepted_reference_changed',
  detail='Accepted command ownership must be captured explicitly.',fence=fence+1,lease_until=NULL,finished_at=now()
WHERE state='pending' AND context->>'accepted_reference_revision' IS NULL;

CREATE FUNCTION private.prune_energy_command_publications()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
  -- Identity and both ACK facts remain; only expired inactive command arrays
  -- are released. Durable accepted copies are never altered by retention.
  UPDATE private.energy_command_publications p SET commands=jsonb_set(p.commands,'{slots}','[]')
    WHERE p.horizon_end<=clock_timestamp() AND jsonb_array_length(p.commands->'slots')>0
      AND NOT EXISTS(SELECT 1 FROM public.energy_optimisation_current c WHERE c.home_id=p.home_id
        AND (c.plan_id=p.plan_id OR c.accepted_household_reference->>'plan_id'=p.plan_id::text
          OR c.accepted_battery_reference->>'plan_id'=p.plan_id::text));
END; $$;
SELECT cron.schedule('prune-energy-command-publications','*/5 * * * *','SELECT private.prune_energy_command_publications()');
REVOKE ALL ON FUNCTION private.energy_command_reference(jsonb,jsonb),private.promote_energy_command_reference(uuid,uuid,text),
 private.prune_energy_command_publications() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.read_energy_planning_job(p_home_id uuid,p_job_id uuid DEFAULT NULL,p_snapshot_id uuid DEFAULT NULL)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE; v_receipt json;
BEGIN
  IF (p_job_id IS NULL)=(p_snapshot_id IS NULL) THEN RAISE EXCEPTION 'Specify one planning job or snapshot'; END IF;
  SELECT * INTO j FROM private.energy_planning_jobs WHERE home_id=p_home_id
    AND ((p_job_id IS NOT NULL AND id=p_job_id) OR (p_snapshot_id IS NOT NULL AND snapshot_id=p_snapshot_id));
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_receipt:=private.energy_planning_receipt(j);
  IF p_snapshot_id IS NOT NULL THEN
    -- Build JSON directly; converting the frozen context through JSONB would
    -- reorder nested planning/configuration maps.
    RETURN json_build_object('job_id',j.id,'state',v_receipt->>'state',
      'pending',(v_receipt->>'pending')::boolean,
      'retry_after_ms',v_receipt->'retry_after_ms','last_error',v_receipt->'last_error','recapture',v_receipt->'recapture',
      'snapshot_id',j.snapshot_id,'source_hash',j.source_hash,
      'plan_id',v_receipt->'plan_id','plan',v_receipt->'plan',
      'code',j.code,'detail',j.detail,'exchange',j.context->'exchange');
  END IF;
  RETURN v_receipt;
END; $$;
