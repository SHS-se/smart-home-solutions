-- Causal room forecasts carry a measured temperature state. The existing 108
-- numerical cells still fit all families, but only finite/integrator responses
-- publish executable forecasts. Algebraic evidence remains descriptive.
-- Only the numerical implementation changes: source archive identities, policy,
-- capture version, accepted references and complete run ledgers are untouched.
CREATE OR REPLACE FUNCTION public.claim_energy_device_learning(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; owner record;
 lane private.energy_room_learning_lanes%ROWTYPE; progress jsonb; revision bigint;
BEGIN
 SELECT home_id,owner_kind INTO owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF owner.owner_kind='room' THEN
   INSERT INTO private.energy_room_learning_lanes(home_id) VALUES(owner.home_id) ON CONFLICT DO NOTHING;
   -- Claim locks lane then job. Release only locks the lane; ordinary request,
   -- publication and checkpoint never lock it, so there is no reverse order.
   SELECT * INTO lane FROM private.energy_room_learning_lanes
     WHERE home_id=owner.home_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND OR lane.lease_until>now() THEN RETURN NULL; END IF;
   IF private.next_energy_room_learning_job(owner.home_id) IS DISTINCT FROM p_job_id THEN
     PERFORM private.wake_energy_learning_job(p_job_id);
     RETURN NULL;
   END IF;
   SELECT * INTO j FROM private.energy_learning_jobs
     WHERE id=p_job_id AND home_id=owner.home_id AND owner_kind='room' AND pending
       AND wake_after<=now() AND (lease_until IS NULL OR lease_until<=now())
     FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN RETURN NULL; END IF;
   UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
     wake_after=now()+interval '60 seconds',attempts=attempts+1,room_last_started_at=now()
     WHERE id=p_job_id RETURNING * INTO j;
   UPDATE private.energy_room_learning_lanes SET job_id=j.id,generation=j.generation,
     fence=j.fence,lease_until=j.lease_until WHERE home_id=j.home_id;
   SELECT model_revision INTO revision FROM energy_optimisation_zone_models
     WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
   DELETE FROM private.energy_room_fit_progress
     WHERE job_id=j.id AND (generation<>j.generation OR base_revision<>coalesce(revision,0)
       OR metadata->>'version' IS DISTINCT FROM '5'
       OR metadata#>>'{capture,implementation}' IS DISTINCT FROM 'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1'
       OR NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(j.home_id) c
          WHERE c.room_key=j.owner_key AND c.binding=metadata#>>'{capture,binding}'));
   SELECT jsonb_build_object('metadata',p.metadata,'cells',p.cells,'cursor',jsonb_array_length(p.cells),
     'base_revision',p.base_revision) INTO progress FROM private.energy_room_fit_progress p WHERE p.job_id=j.id;
 ELSE
   -- Preserve the existing pool/device lease and retry behavior.
   UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
     wake_after=now()+interval '60 seconds',attempts=attempts+1
   WHERE id=p_job_id AND owner_kind<>'room' AND pending AND (lease_until IS NULL OR lease_until<=now())
   RETURNING * INTO j;
   IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 RETURN to_jsonb(j)||jsonb_build_object('room_fit_progress',progress);
END; $$;

CREATE OR REPLACE FUNCTION public.checkpoint_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_metadata jsonb,p_capture_base64 text,p_cell jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE owner private.energy_learning_jobs%ROWTYPE; cap jsonb; evidence jsonb;
 start_at timestamptz; finish_at timestamptz; current_policy text;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF p_expected_cursor=-1 THEN
   IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR p_capture_base64 IS NULL
     OR p_metadata->>'version' IS DISTINCT FROM '5'
     OR p_metadata#>>'{capture,implementation}' IS DISTINCT FROM 'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1'
     OR p_cell IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial room fit capture'; END IF;
   SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
   cap:=p_metadata->'capture'; evidence:=cap->'evidence';
   start_at:=(evidence->>'fromAt')::timestamptz; finish_at:=(evidence->>'toAt')::timestamptz;
   IF start_at IS NULL OR finish_at IS NULL OR NOT isfinite(start_at) OR NOT isfinite(finish_at) OR finish_at<start_at
     OR cap->>'homeId' IS DISTINCT FROM owner.home_id::text OR cap->>'customerId' IS DISTINCT FROM owner.customer_id::text
     OR cap->>'roomKey' IS DISTINCT FROM owner.owner_key OR (cap->>'baseRevision')::bigint IS DISTINCT FROM p_revision
   THEN RAISE EXCEPTION 'Invalid room capture ownership or scope'; END IF;
   PERFORM private.lock_room_evidence(owner.home_id);
   -- Read current eligibility in a fresh READ COMMITTED statement after a
   -- concurrent source-policy writer has released the evidence clock lock.
   SELECT private.room_evidence_policy_fingerprint(owner.home_id,owner.owner_key,c.binding,start_at,finish_at)
     INTO current_policy FROM private.energy_room_heating_contexts(owner.home_id) c
     WHERE c.room_key=owner.owner_key AND c.binding=cap->>'binding';
   IF current_policy IS NULL OR p_metadata->>'policy_fingerprint' IS DISTINCT FROM current_policy THEN
     PERFORM private.resume_energy_room_fit(p_job_id);
     RETURN false;
   END IF;
   INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture)
   VALUES(p_job_id,p_generation,p_revision,p_metadata,decode(p_capture_base64,'base64'))
   ON CONFLICT(job_id) DO NOTHING;
 ELSE
   IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR p_expected_cursor>=108
     OR p_metadata IS NOT NULL OR p_capture_base64 IS NOT NULL
     OR jsonb_typeof(p_cell) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid room fit cell'; END IF;
   UPDATE private.energy_room_fit_progress SET cells=cells||jsonb_build_array(p_cell),metadata=metadata-'heat_state'
   WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
     AND jsonb_array_length(cells)=p_expected_cursor;
 END IF;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.complete_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_model jsonb,p_run_ledger jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE
 owner private.energy_learning_jobs%ROWTYPE; envelope jsonb; captured jsonb; evidence jsonb; prior jsonb;
 bands jsonb:=p_model->'heating_bands'; response jsonb:=bands->'reference';
 response_revision text:=bands->>'reference_revision'; v_binding text:=bands->>'binding';
 policy constant text:='measured_room_runs_v1'; training jsonb; support jsonb;
 fitted integer; freedom integer; start_at timestamptz; finish_at timestamptz;
 assessment_revision text; ledger_scope text;
 captured_revision bigint; live_revision bigint; current_policy text; complete_scope boolean; changed boolean;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 SELECT metadata INTO envelope FROM private.energy_room_fit_progress WHERE job_id=p_job_id AND generation=p_generation
   AND base_revision=p_revision AND jsonb_array_length(cells)=p_expected_cursor;
 IF p_expected_cursor IS DISTINCT FROM 108 OR envelope->>'version' IS DISTINCT FROM '5' THEN RETURN false; END IF;
 -- A previous worker may finish during rollout. Leave its earned cells and
 -- immutable bytes for the new worker's in-service certification or reset.
 IF NOT (envelope ? 'policy_fingerprint') THEN RETURN false; END IF;
 captured:=envelope->'capture'; evidence:=captured->'evidence';
 start_at:=(evidence->>'fromAt')::timestamptz; finish_at:=(evidence->>'toAt')::timestamptz;
 captured_revision:=(evidence->>'sourceRevision')::bigint;
 IF captured->>'homeId' IS DISTINCT FROM owner.home_id::text OR captured->>'customerId' IS DISTINCT FROM owner.customer_id::text
   OR captured->>'roomKey' IS DISTINCT FROM owner.owner_key OR captured->>'binding' IS DISTINCT FROM v_binding OR v_binding IS NULL
   OR (captured->>'baseRevision')::bigint IS DISTINCT FROM p_revision
   OR start_at IS NULL OR finish_at IS NULL OR NOT isfinite(start_at) OR NOT isfinite(finish_at) OR start_at>finish_at
   OR captured_revision IS NULL OR captured_revision<0 OR evidence->>'implementation' IS DISTINCT FROM 'chronological_native_evidence_v1'
   OR captured->>'implementation' IS DISTINCT FROM 'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1' OR captured->>'implementation' IS DISTINCT FROM bands#>>'{shared_attempt,implementation}'
   OR bands#>'{shared_attempt,evidence}' IS DISTINCT FROM evidence OR bands->>'calibration_policy' IS DISTINCT FROM policy
 THEN RAISE EXCEPTION 'Invalid chronological room capture'; END IF;
 live_revision:=private.lock_room_evidence(owner.home_id);
 -- Policy reads have their own statement snapshot after the clock lock.
 SELECT private.room_evidence_policy_fingerprint(owner.home_id,owner.owner_key,c.binding,start_at,finish_at)
   INTO current_policy FROM private.energy_room_heating_contexts(owner.home_id) c
   WHERE c.room_key=owner.owner_key AND c.binding=v_binding;
 SELECT COALESCE(range_agg(tstzrange(b.from_at,b.to_at,'[)')),'{}'::tstzmultirange) @> tstzrange(start_at,finish_at,'[)')
   AND NOT coalesce(bool_or(EXISTS(SELECT FROM private.energy_room_evidence_changes d WHERE d.home_id=b.home_id
     AND d.room_key IN ('',b.room_key) AND d.revision>b.source_revision AND d.revision<=captured_revision
     AND d.affected && tstzrange(greatest(start_at,b.from_at-interval '1 hour'),least(finish_at,b.to_at+interval '1 hour'),'[)'))),false)
 INTO complete_scope FROM private.energy_room_evidence_blocks b WHERE b.home_id=owner.home_id AND b.room_key=owner.owner_key
   AND b.customer_id=owner.customer_id AND b.binding=v_binding AND b.implementation=evidence->>'implementation'
   AND b.from_at<finish_at AND b.to_at>start_at;
 IF NOT complete_scope OR captured_revision>live_revision OR current_policy IS NULL
   OR envelope->>'policy_fingerprint' IS DISTINCT FROM current_policy THEN
   DELETE FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
   PERFORM private.resume_energy_room_fit(p_job_id);
   RETURN false;
 END IF;
 SELECT heating_bands INTO prior FROM public.energy_optimisation_zone_models WHERE home_id=owner.home_id AND room_key=owner.owner_key;
 IF prior->>'binding' IS DISTINCT FROM v_binding THEN prior:=NULL; END IF;
 changed:=response_revision IS DISTINCT FROM prior->>'reference_revision';
 p_run_ledger:=nullif(p_run_ledger,'null'::jsonb);
 training:=p_model#>'{last_fit_attempt,learning}'; support:=training->'measured_runs';
 PERFORM private.validate_measured_room_ledger(p_run_ledger,support);
 IF support->>'policy' IS DISTINCT FROM policy
   OR support->>'measurement_method' IS DISTINCT FROM 'native_mean_onset_peak_v1'
   OR p_run_ledger->>'assessed_against' IS DISTINCT FROM response_revision
   OR (training ? 'source_evidence' AND training->'source_evidence' IS DISTINCT FROM evidence)
 THEN RAISE EXCEPTION 'Invalid measured room attempt'; END IF;
 IF changed THEN
   fitted:=(support->>'fitted_observations')::integer; freedom:=(support->>'residual_degrees_of_freedom')::integer;
   IF response_revision IS NULL OR response#>>'{scope,kind}' IS DISTINCT FROM 'shared' OR bands->'active' IS DISTINCT FROM '[]'::jsonb
     OR bands#>>'{shared_attempt,status}' IS DISTINCT FROM 'fitted'
     OR coalesce(response#>>'{model,response_family}','') NOT IN ('finite','integrator')
     OR fitted IS NULL OR freedom IS NULL OR freedom<=0 OR freedom>=fitted
     OR fitted IS DISTINCT FROM (response#>>'{model,sample_count}')::integer OR fitted IS DISTINCT FROM (p_model->>'sample_count')::integer
     OR ((response->'learning_evidence')-'source_evidence') IS DISTINCT FROM (training-'source_evidence')
     OR (response->'learning_evidence' ? 'source_evidence' AND response#>'{learning_evidence,source_evidence}' IS DISTINCT FROM evidence)
     THEN RAISE EXCEPTION 'Invalid measured room support'; END IF;
   p_model:=jsonb_set(p_model,'{heating_bands,reference,learning_evidence,source_evidence}',evidence);
 ELSIF bands#>>'{shared_attempt,status}' IS DISTINCT FROM 'unidentified'
   OR response IS DISTINCT FROM prior->'reference' THEN RAISE EXCEPTION 'Failed fit must retain its accepted response'; END IF;
 assessment_revision:=CASE WHEN changed THEN response_revision
   ELSE 'attempt:'||p_job_id::text||':'||p_generation::text||':'||(p_revision+1)::text END;
 ledger_scope:=CASE WHEN changed THEN 'shared' ELSE 'attempt' END;
 IF NOT public.publish_energy_device_learning(p_job_id,p_generation,p_fence,p_revision,p_model) THEN RETURN false; END IF;
 INSERT INTO private.energy_room_run_assessments(home_id,room_key,response_revision,position,run)
 SELECT owner.home_id,owner.owner_key,assessment_revision,
   row_number() OVER (ORDER BY (run->>'from_ms')::numeric DESC,run->>'id'),run
 FROM jsonb_array_elements(p_run_ledger->'runs') run;
 -- Accepted and latest-attempt pages have independent immutable revisions.
 -- Failed attempts retain both the accepted response and its assessment page.
 IF changed THEN
   DELETE FROM private.energy_room_run_ledgers WHERE home_id=owner.home_id AND room_key=owner.owner_key;
 END IF;
 INSERT INTO private.energy_room_run_ledgers(home_id,customer_id,room_key,scope_key,model_revision,job_id,generation,evidence)
 VALUES(owner.home_id,owner.customer_id,owner.owner_key,ledger_scope,p_revision+1,p_job_id,p_generation,
   (p_run_ledger-'runs')||jsonb_build_object('runs','[]'::jsonb,'assessment_revision',assessment_revision))
 ON CONFLICT(home_id,room_key,scope_key) DO UPDATE SET model_revision=EXCLUDED.model_revision,
   job_id=EXCLUDED.job_id,generation=EXCLUDED.generation,evidence=EXCLUDED.evidence,created_at=now();
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.request_energy_device_learning(p_home_id uuid,p_customer_id uuid,p_owners jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE o jsonb; v_id uuid; n integer:=0; due boolean; heating_bindings jsonb;
BEGIN
  IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
  IF jsonb_typeof(p_owners) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid learning owners'; END IF;
  SELECT COALESCE(jsonb_object_agg(c.room_key,c.binding),'{}'::jsonb) INTO heating_bindings
    FROM private.energy_room_heating_contexts(p_home_id) c;
  -- The capture supplies the complete current ownership set. Removal fences an
  -- in-flight fit too; retained models stay available if a device is remapped.
  UPDATE private.energy_learning_jobs j SET pending=false,generation=generation+1,fence=fence+1,
    lease_until=NULL,finished_at=now(),last_error='Learning owner removed'
  WHERE home_id=p_home_id AND pending AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_owners) AS current_owner(value)
      WHERE current_owner.value->>'kind'=j.owner_kind AND current_owner.value->>'key'=j.owner_key);
  FOR o IN SELECT value FROM jsonb_array_elements(p_owners) LOOP
    IF o->>'kind'='room' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at < now()-CASE
          WHEN trained AND (heating_bands IS NULL OR heating_bands->>'reference_revision' IS NOT NULL)
          THEN interval '24 hours' ELSE interval '1 hour' END
        OR (heating_bindings ? (o->>'key') AND heating_bands->>'calibration_policy' IS DISTINCT FROM 'measured_room_runs_v1')
        OR (heating_bindings ? (o->>'key') AND heating_bands#>>'{shared_attempt,implementation}' IS DISTINCT FROM
          'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1')
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL
          AND heating_bands->>'binding' IS DISTINCT FROM heating_bindings->>(o->>'key'))
        OR (trained AND NOT (heating_bindings ? (o->>'key'))
          AND (last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'interval_mean_transition_holdout_v1'
            OR last_fit_attempt->'learning'->>'family' IS DISTINCT FROM 'house_outdoor_solar_v1'))
      INTO due FROM public.energy_optimisation_zone_models WHERE home_id=p_home_id AND room_key=o->>'key';
    ELSIF o->>'kind'='pool' AND o->>'key'='pool' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at<now()-interval '24 hours'
        OR (heat_pump_epoch_start IS NOT NULL AND heat_pump_epoch_start>last_attempted_at)
        OR last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'pool_interval_mean_v1'
      INTO due FROM public.energy_optimisation_pool_model WHERE home_id=p_home_id;
    ELSIF o->>'kind'='device' AND COALESCE(o->>'key','')<>'' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at<now()-interval '24 hours'
        OR last_fit_attempt->'learning'->>'method' IS DISTINCT FROM
          CASE WHEN o->'input'->>'weather_heating_binding' IS NULL
            THEN 'device_operating_points_v1' ELSE 'weather_heating_draw_v1' END
        OR (o->'input'->>'weather_heating_binding' IS NOT NULL AND
          operating_points->>'binding' IS DISTINCT FROM o->'input'->>'weather_heating_binding')
      INTO due FROM public.energy_optimisation_device_operating_points WHERE home_id=p_home_id AND device_key=o->>'key';
    ELSE RAISE EXCEPTION 'Invalid learning owner'; END IF;
    IF COALESCE(due,true) OR (o->>'kind'='device' AND EXISTS (
      SELECT 1 FROM private.energy_learning_jobs j
      WHERE j.home_id=p_home_id AND j.owner_kind='device' AND j.owner_key=o->>'key'
        AND j.pending AND j.input IS DISTINCT FROM o->'input'
    )) THEN
      INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
        VALUES(p_home_id,p_customer_id,o->>'kind',o->>'key',o->'input')
      ON CONFLICT(home_id,owner_kind,owner_key) DO UPDATE SET
        pending=true,generation=energy_learning_jobs.generation+1,input=EXCLUDED.input,
        fence=energy_learning_jobs.fence+1,lease_until=NULL,wake_after=now(),attempts=0,last_error=NULL,finished_at=NULL
        WHERE NOT energy_learning_jobs.pending OR energy_learning_jobs.input IS DISTINCT FROM EXCLUDED.input RETURNING id INTO v_id;
      IF FOUND THEN PERFORM private.wake_energy_learning_job(v_id); n:=n+1; END IF;
    END IF;
  END LOOP;
  RETURN n;
END; $$;

CREATE OR REPLACE FUNCTION public.get_energy_room_response_evidence(p_home_id uuid,p_room_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.homes h WHERE h.id=p_home_id AND public.can_access_energy_billing_customer(h.customer_id)) THEN
   RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object(
   'room',(SELECT jsonb_build_object('trained',m.trained,'rejection_reason',m.rejection_reason,
     'last_attempted_at',m.last_attempted_at,'last_fit_attempt',m.last_fit_attempt,
     'policy',m.heating_bands->>'calibration_policy','shared_attempt',m.heating_bands->'shared_attempt')
     FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id AND m.room_key=p_room_key),
   'response',(SELECT CASE WHEN m.heating_bands#>>'{reference,scope,kind}'='shared' THEN jsonb_build_object(
     'revision',m.heating_bands->>'reference_revision','model',m.heating_bands#>'{reference,model}',
     'training_from',m.heating_bands#>'{reference,training_from}','training_to',m.heating_bands#>'{reference,training_to}',
     'warnings',m.heating_bands#>'{reference,warnings}',
     'measured_runs',m.heating_bands#>'{reference,learning_evidence,measured_runs}',
     'descriptive_fit',m.heating_bands#>'{reference,learning_evidence,descriptive_fit}',
     'transition_calibration',m.heating_bands#>'{reference,learning_evidence,transition_calibration}',
     'run_calibration',m.heating_bands#>'{reference,learning_evidence,run_calibration}') END
     FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id AND m.room_key=p_room_key),
   'ledgers',(SELECT coalesce(jsonb_agg(jsonb_build_object('scope_key',l.scope_key,'model_revision',l.model_revision,
     'created_at',l.created_at,'evidence',CASE WHEN l.evidence->>'policy' IN ('shared_interval_transitions_v1','measured_room_runs_v1') THEN
       l.evidence||jsonb_build_object('runs',public.get_energy_room_run_assessments(p_home_id,p_room_key,coalesce(l.evidence->>'assessment_revision',l.evidence->>'assessed_against'),0,
         CASE WHEN l.evidence->>'policy'='measured_room_runs_v1' THEN 100 ELSE 50 END))
       ELSE l.evidence END) ORDER BY l.scope_key),'[]'::jsonb)
     FROM private.energy_room_run_ledgers l WHERE l.home_id=p_home_id AND l.room_key=p_room_key));
END; $$;

-- Fence numerical work from the previous implementation using the existing
-- room rollout/request cadence. The version comparison above makes the next
-- ordinary request due even for a recently completed previous-method attempt.
UPDATE private.energy_learning_jobs SET pending=true,generation=generation+1,fence=fence+1,
  lease_until=NULL,wake_after=now()+interval '15 minutes',attempts=0,last_error=NULL,finished_at=NULL
WHERE owner_kind='room';
DELETE FROM private.energy_room_fit_progress
WHERE metadata#>>'{capture,implementation}' IS DISTINCT FROM
  'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1';
NOTIFY pgrst, 'reload schema';
