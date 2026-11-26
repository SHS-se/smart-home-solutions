-- Bounded adaptive numerical continuations share the existing fenced room lane.
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
       OR metadata->>'version' IS DISTINCT FROM '6'
       OR metadata#>>'{capture,implementation}' IS DISTINCT FROM 'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1'
       OR NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(j.home_id) c
          WHERE c.room_key=j.owner_key AND c.binding=metadata#>>'{capture,binding}'));
   SELECT jsonb_build_object('metadata',p.metadata,'cells',p.cells,'cursor',CASE WHEN p.metadata ? 'heat_state' THEN p.adaptive_cursor ELSE jsonb_array_length(p.cells) END,
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
     OR p_metadata->>'version' IS DISTINCT FROM '6'
     OR p_metadata#>>'{capture,implementation}' IS DISTINCT FROM 'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1'
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
     AND jsonb_array_length(cells)=p_expected_cursor AND adaptive_cursor=0 AND NOT (metadata ? 'heat_state');
 END IF;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;



-- The numerical continuation owns its own scalar cursor; completed response
-- cells keep their existing array. A lost reply cannot apply an update twice.
CREATE FUNCTION public.checkpoint_energy_room_adaptive_fit(
 p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_expected_state jsonb,p_state jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
BEGIN
 p_expected_state:=nullif(p_expected_state,'null'::jsonb);
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR jsonb_typeof(p_state) IS DISTINCT FROM 'object'
   OR p_state->>'version' IS DISTINCT FROM '1'
   OR coalesce(p_state->>'stage','') NOT IN ('static','adaptive','validation_static','validation_adaptive','process_posterior','full','posterior','complete')
 THEN RAISE EXCEPTION 'Invalid adaptive room continuation'; END IF;
 UPDATE private.energy_room_fit_progress SET adaptive_cursor=adaptive_cursor+1,
   metadata=jsonb_set(metadata,'{heat_state}',p_state)
 WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
   AND metadata->>'version'='6' AND adaptive_cursor=p_expected_cursor AND jsonb_array_length(cells)=0
   AND nullif(metadata->'heat_state','null'::jsonb) IS NOT DISTINCT FROM p_expected_state;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.checkpoint_energy_room_adaptive_fit(uuid,bigint,bigint,bigint,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_room_adaptive_fit(uuid,bigint,bigint,bigint,integer,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.reset_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE cursor integer;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT CASE WHEN metadata ? 'heat_state' THEN adaptive_cursor ELSE jsonb_array_length(cells) END INTO cursor FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
 IF coalesce(cursor,-1) IS DISTINCT FROM p_expected_cursor THEN RETURN false; END IF;
 DELETE FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;
