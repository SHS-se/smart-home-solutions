-- A newer household publication may precede this deployment while HA's
-- independently accepted battery still owns an older server-issued contract.
-- Recover only identity fields fixed by that publication's immutable input;
-- executable commands must already exist in a server-owned reference.
DO $$
DECLARE
  home uuid; c public.energy_optimisation_current%ROWTYPE;
  own private.energy_planning_jobs%ROWTYPE;
  run public.energy_optimisation_plan_runs%ROWTYPE;
  publication private.energy_command_publications%ROWTYPE;
  accepted jsonb; identity jsonb; commands jsonb; candidate jsonb;
BEGIN
  FOR home IN SELECT home_id FROM public.energy_optimisation_current
    WHERE accepted_reference_unresolved AND accepted_battery_reference IS NULL ORDER BY home_id
  LOOP
    PERFORM 1 FROM private.energy_planning_heads WHERE home_id=home FOR UPDATE;
    SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=home FOR UPDATE;
    IF NOT c.accepted_reference_unresolved OR c.accepted_battery_reference IS NOT NULL THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM private.energy_command_publications p WHERE p.home_id=home
      AND p.plan_id=c.plan_id AND p.completion_basis='publication') THEN CONTINUE; END IF;
    accepted:=c.ha_runtime->'battery_plan'->'accepted';
    SELECT j.* INTO own FROM private.energy_planning_jobs j
      JOIN public.energy_optimisation_plan_runs r ON r.home_id=j.home_id AND r.id=j.plan_id AND r.snapshot_id=j.snapshot_id
      WHERE j.home_id=home AND j.plan_id::text=accepted->>'plan_id' AND j.state='published'
        AND r.status='ready' AND r.plan_schema_version IN (9,10)
        AND j.input->'snapshot'->>'schema_version'=r.plan_schema_version::text
        AND j.input->'snapshot'->'capabilities'->>'battery'='true'
        AND json_typeof(j.input->'snapshot'->'battery')='object'
        AND j.input->'snapshot'->'operating_scope'->'modes'->>'$battery' IN ('controlling','control_verification')
        AND j.input->'snapshot'->'battery_execution_feedback'->>'generation' ~ '^[1-9][0-9]*$'
        AND j.input->'snapshot'->'battery_execution_feedback'->>'generation'=accepted->>'generation'
        AND NULLIF(j.input->'snapshot'->'battery_execution_feedback'->>'scope_revision','')=accepted->>'scope_revision'
        AND j.plan_id::text||':battery:'||(j.input->'snapshot'->'battery_execution_feedback'->>'generation')=accepted->>'contract_id';
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO run FROM public.energy_optimisation_plan_runs WHERE home_id=home AND id=own.plan_id AND snapshot_id=own.snapshot_id;
    identity:=jsonb_build_object('id',own.plan_id::text||':battery:'||(own.input->'snapshot'->'battery_execution_feedback'->>'generation'),
      'scope_revision',own.input->'snapshot'->'battery_execution_feedback'->'scope_revision',
      'generation',own.input->'snapshot'->'battery_execution_feedback'->'generation');
    SELECT * INTO publication FROM private.energy_command_publications WHERE home_id=home AND plan_id=own.plan_id FOR UPDATE;
    IF FOUND AND (publication.completion_basis<>'home_assistant_ack' OR publication.snapshot_id<>own.snapshot_id
      OR publication.schema_version<>run.plan_schema_version
      OR (publication.battery_contract IS NOT NULL AND publication.battery_contract<>'null'::jsonb AND publication.battery_contract<>identity)) THEN CONTINUE; END IF;
    commands:=NULL;
    -- A nonempty existing projection is authoritative. Otherwise the old
    -- capture already detached this exact publication's commands before solve.
    FOR candidate IN
      SELECT publication.commands WHERE publication.commands->>'plan_id'=own.plan_id::text
      UNION ALL
      SELECT (j.input->'reference')::jsonb FROM private.energy_planning_jobs j
        WHERE j.home_id=home AND j.input->'reference'->>'plan_id'=own.plan_id::text
    LOOP
      IF jsonb_typeof(candidate->'slots') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
      IF candidate->'battery_contract' IS NOT NULL AND candidate->'battery_contract'<>'null'::jsonb
        AND candidate->'battery_contract'<>identity THEN CONTINUE; END IF;
      IF jsonb_array_length(candidate->'slots')=0 THEN
        -- Retention deliberately clears ended candidates. The stored actual
        -- horizon proves no FUTURE holds; missing/unknown horizons do not.
        IF NOT COALESCE(candidate=publication.commands AND publication.horizon_end<=clock_timestamp(),false) THEN CONTINUE; END IF;
        commands:=candidate-'publication_revision'; EXIT;
      END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'slots') s
        WHERE jsonb_typeof(s->'battery_command') IS DISTINCT FROM 'object') THEN CONTINUE; END IF;
      candidate:=candidate-'publication_revision';
      IF commands IS NOT NULL AND commands-'battery_contract' IS DISTINCT FROM candidate-'battery_contract' THEN
        -- Conflicting retained payloads do not authorize choosing one silently.
        commands:=NULL; EXIT;
      END IF;
      commands:=candidate;
    END LOOP;
    IF commands IS NULL THEN CONTINUE; END IF;
    commands:=commands||jsonb_build_object('battery_contract',identity);
    INSERT INTO private.energy_command_publications(home_id,plan_id,snapshot_id,schema_version,publication_revision,commands,horizon_end,battery_contract,completion_basis)
      VALUES(home,own.plan_id,own.snapshot_id,run.plan_schema_version,own.revision,commands,
        (SELECT max((s->>'start')::timestamptz)+make_interval(mins=>(own.input->'snapshot'->>'slot_minutes')::int)
          FROM jsonb_array_elements(commands->'slots') s),identity,'home_assistant_ack')
      ON CONFLICT(home_id,plan_id) DO UPDATE SET commands=EXCLUDED.commands,battery_contract=EXCLUDED.battery_contract;
    PERFORM private.promote_energy_command_reference(home,own.plan_id,'battery');
  END LOOP;
END; $$;
