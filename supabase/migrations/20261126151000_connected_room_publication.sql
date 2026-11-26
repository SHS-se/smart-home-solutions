-- A receiving response publishes under the same owner, binding, evidence and map fences.
ALTER TABLE private.energy_room_fit_progress ADD COLUMN adaptive_cursor integer NOT NULL DEFAULT 0 CHECK(adaptive_cursor>=0);
CREATE OR REPLACE FUNCTION public.complete_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_model jsonb,p_run_ledger jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE
 owner private.energy_learning_jobs%ROWTYPE; envelope jsonb; captured jsonb; evidence jsonb; prior jsonb;
 bands jsonb:=p_model->'heating_bands'; response jsonb:=bands->'reference';
 response_revision text:=bands->>'reference_revision'; v_binding text:=bands->>'binding';
 policy constant text:='measured_room_runs_v1'; training jsonb; support jsonb;
 fitted integer; freedom integer; start_at timestamptz; finish_at timestamptz;
 assessment_revision text; ledger_scope text; connected jsonb; connected_basis jsonb; observed_only boolean;
 captured_revision bigint; live_revision bigint; current_policy text; complete_scope boolean; changed boolean;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT * INTO STRICT owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 SELECT metadata INTO envelope FROM private.energy_room_fit_progress WHERE job_id=p_job_id AND generation=p_generation
   AND base_revision=p_revision
   AND CASE WHEN metadata ? 'heat_state' THEN adaptive_cursor ELSE jsonb_array_length(cells) END=p_expected_cursor;
 IF envelope->>'version' IS DISTINCT FROM '6' OR
   (envelope#>>'{heat_state,stage}' IS DISTINCT FROM 'complete' AND p_expected_cursor IS DISTINCT FROM 108) THEN RETURN false; END IF;
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
   OR captured->>'implementation' IS DISTINCT FROM 'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1' OR captured->>'implementation' IS DISTINCT FROM bands#>>'{shared_attempt,implementation}'
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
 training:=p_model#>'{last_fit_attempt,learning}';
 IF envelope#>>'{heat_state,stage}'='complete' THEN
   connected:=response->'connected_exchange';
   observed_only:=(captured#>>'{connected,observedOnly}')::boolean;
   IF p_run_ledger IS NOT NULL OR observed_only IS NULL
     OR captured#>>'{connected,policyFingerprint}' IS DISTINCT FROM current_policy
     OR training->'source_evidence' IS DISTINCT FROM evidence
   THEN RAISE EXCEPTION 'Invalid connected room evidence'; END IF;
   IF changed THEN
     connected_basis:=jsonb_build_object(
       'graph_owner',captured#>'{connected,graph,owner}','graph_revision',captured#>'{connected,graph,revision}',
       'topology_hash',captured#>'{connected,graph,topology_hash}','source_policy',to_jsonb(current_policy),
       'source_revision',evidence->'sourceRevision','history_from',evidence->'fromAt','history_to',evidence->'toAt');
     IF response_revision IS NULL OR response#>>'{scope,kind}' IS DISTINCT FROM 'shared'
       OR bands->'active' IS DISTINCT FROM '[]'::jsonb OR bands#>>'{shared_attempt,status}' IS DISTINCT FROM 'fitted'
       OR connected->>'family' IS DISTINCT FROM 'adaptive_connected_native_v1'
       OR connected->'basis' IS DISTINCT FROM connected_basis
       OR jsonb_typeof(connected->'incoming') IS DISTINCT FROM 'array'
       OR jsonb_typeof(connected->'reference_state') IS DISTINCT FROM 'object'
       OR jsonb_typeof(connected->'evidence') IS DISTINCT FROM 'object'
       OR jsonb_typeof(connected#>'{thermal,outdoor_per_h}') IS DISTINCT FROM 'number'
       OR jsonb_typeof(connected#>'{thermal,background_per_h}') IS DISTINCT FROM 'number'
       OR jsonb_typeof(connected#>'{thermal,solar_per_wm2_h}') IS DISTINCT FROM 'number'
       OR (observed_only AND (response->'model' IS DISTINCT FROM 'null'::jsonb
         OR connected#>'{thermal,heater}' IS DISTINCT FROM 'null'::jsonb))
       OR (NOT observed_only AND NOT (
         (coalesce(response#>>'{model,response_family}','') IN ('finite','integrator')
           AND jsonb_typeof(connected#>'{thermal,heater}') IS NOT DISTINCT FROM 'object')
         OR (response->'model' IS NOT DISTINCT FROM 'null'::jsonb
           AND connected#>'{thermal,heater}' IS NOT DISTINCT FROM 'null'::jsonb
           AND connected#>'{evidence,heater_identified}' IS NOT DISTINCT FROM 'false'::jsonb
           AND connected#>'{evidence,unidentified_heater}' IS NOT DISTINCT FROM 'true'::jsonb)))
       OR response->'learning_evidence' IS DISTINCT FROM training
     THEN RAISE EXCEPTION 'Invalid connected room response'; END IF;
   ELSIF bands#>>'{shared_attempt,status}' IS DISTINCT FROM 'unidentified'
     OR response IS DISTINCT FROM prior->'reference' THEN RAISE EXCEPTION 'Failed fit must retain its accepted response'; END IF;
   IF NOT public.publish_energy_device_learning(p_job_id,p_generation,p_fence,p_revision,p_model) THEN RETURN false; END IF;
   IF changed THEN
     -- Old descriptive-run ledgers cannot claim assessment against this new
     -- receiving response. Immutable assessments remain revision-addressable.
     DELETE FROM private.energy_room_run_ledgers WHERE home_id=owner.home_id AND room_key=owner.owner_key;
   END IF;
   RETURN true;
 END IF;
 support:=training->'measured_runs';
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

ALTER TABLE public.energy_optimisation_zone_models DROP CONSTRAINT energy_optimisation_zone_model_complete;
ALTER TABLE public.energy_optimisation_zone_models ADD CONSTRAINT energy_optimisation_zone_model_complete CHECK (
    (trained AND rejection_reason IS NULL
      AND gain_c_per_wh IS NOT NULL
      AND cooling_constant_per_h IS NOT NULL
      AND background_gain_c_per_h IS NOT NULL)
    OR
    (trained AND rejection_reason IS NULL AND gain_c_per_wh IS NULL AND cooling_constant_per_h IS NULL
      AND coalesce((heating_bands#>>'{reference,model,response_family}'='equilibrium'
      AND jsonb_typeof(heating_bands#>'{reference,model,heater_c_per_w}')='number'
      AND jsonb_typeof(heating_bands#>'{reference,model,outdoor_share}')='number'
      AND jsonb_typeof(heating_bands#>'{reference,model,offset_c}')='number'),false))
    OR
    (trained AND rejection_reason IS NULL AND gain_c_per_wh IS NULL AND cooling_constant_per_h IS NULL
      AND coalesce((heating_bands#>'{reference,model}'='null'::jsonb
      AND heating_bands#>>'{reference,connected_exchange,family}'='adaptive_connected_native_v1'
      AND heating_bands#>'{reference,connected_exchange,thermal,heater}'='null'::jsonb),false))
    OR
    (NOT trained AND rejection_reason IS NOT NULL
      AND gain_c_per_wh IS NULL
      AND cooling_constant_per_h IS NULL)
  );
