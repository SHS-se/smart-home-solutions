-- Refit rooms whose accepted fit was made by another version of the room
-- learner, on the next upload and before a requested replan. The version is a
-- digest of the learner's source (scripts/room-learner-version.ts).

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
        -- A fit made by another room learner is refitted on the next upload.
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL AND o->'input' ? 'learner_version'
          AND heating_bands#>>'{shared_attempt,learner_version}' IS DISTINCT FROM o->'input'->>'learner_version')
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


-- Room learning that a requested replan waits for: a pending room job that has
-- not failed. Routine refits count too, since the plan should use what they publish.
CREATE FUNCTION private.energy_room_refits_pending(p_home_id uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path=public,private AS $$
  SELECT count(*)::integer FROM private.energy_learning_jobs
  WHERE home_id=p_home_id AND owner_kind='room' AND pending AND last_error IS NULL
$$;
REVOKE ALL ON FUNCTION private.energy_room_refits_pending(uuid) FROM PUBLIC,anon,authenticated;

-- A requested replan is held back from Home Assistant while rooms refit, so the
-- house answers it once, with the new models. The hold ends after 20 minutes,
-- the same point at which the portal calls a replan overdue: a refit that has
-- not finished by then must not keep the household from replanning.
CREATE FUNCTION public.energy_replan_held_for_refit(p_home_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT coalesce((SELECT c.replan_request_id IS NOT NULL AND c.replan_request_id IS DISTINCT FROM c.replan_completed_request_id
      AND c.replan_error IS NULL AND c.replan_requested_at > now()-interval '20 minutes'
      AND private.energy_room_refits_pending(p_home_id)>0
    FROM public.energy_optimisation_current c WHERE c.home_id=p_home_id),false)
$$;
REVOKE ALL ON FUNCTION public.energy_replan_held_for_refit(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.energy_replan_held_for_refit(uuid) TO service_role;

-- A replan refits every room whose accepted fit was made by another learner.
-- Each room keeps its last requested input; only the learner version changes.
CREATE FUNCTION public.request_energy_stale_room_refits(p_home_id uuid,p_learner_version text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE v_id uuid; n integer:=0;
BEGIN
  IF coalesce(p_learner_version,'')='' THEN RAISE EXCEPTION 'Invalid room learner version'; END IF;
  FOR v_id IN SELECT j.id FROM private.energy_learning_jobs j
    JOIN public.energy_optimisation_zone_models m ON m.home_id=j.home_id AND m.room_key=j.owner_key
    WHERE j.home_id=p_home_id AND j.owner_kind='room' AND m.heating_bands IS NOT NULL
      AND m.heating_bands#>>'{shared_attempt,learner_version}' IS DISTINCT FROM p_learner_version
      AND NOT (j.pending AND j.input->>'learner_version' IS NOT DISTINCT FROM p_learner_version)
    ORDER BY j.owner_key
  LOOP
    UPDATE private.energy_learning_jobs SET pending=true,generation=generation+1,fence=fence+1,
      input=input||jsonb_build_object('learner_version',p_learner_version),lease_until=NULL,wake_after=now(),
      attempts=0,last_error=NULL,finished_at=NULL
    WHERE id=v_id;
    PERFORM private.wake_energy_learning_job(v_id);
    n:=n+1;
  END LOOP;
  RETURN n;
END; $$;
REVOKE ALL ON FUNCTION public.request_energy_stale_room_refits(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_energy_stale_room_refits(uuid,text) TO service_role;

-- Where a requested replan has got to, for the portal's button.
CREATE FUNCTION public.get_energy_replan_progress(p_home_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE c record; refitting integer;
BEGIN
  IF NOT EXISTS(SELECT FROM public.homes h WHERE h.id=p_home_id AND public.can_access_energy_billing_customer(h.customer_id)) THEN
    RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE='42501';
  END IF;
  SELECT replan_request_id,replan_completed_request_id,replan_error INTO c
    FROM public.energy_optimisation_current WHERE home_id=p_home_id;
  IF c.replan_request_id IS NULL OR c.replan_request_id IS NOT DISTINCT FROM c.replan_completed_request_id THEN
    RETURN jsonb_build_object('request_id',c.replan_request_id,'stage','idle','refitting_rooms',0);
  END IF;
  IF c.replan_error IS NOT NULL THEN
    RETURN jsonb_build_object('request_id',c.replan_request_id,'stage','failed','refitting_rooms',0);
  END IF;
  refitting:=private.energy_room_refits_pending(p_home_id);
  RETURN jsonb_build_object('request_id',c.replan_request_id,'refitting_rooms',refitting,'stage',CASE
    WHEN public.energy_replan_held_for_refit(p_home_id) THEN 'refitting'
    WHEN EXISTS(SELECT FROM private.energy_planning_jobs j WHERE j.home_id=p_home_id AND j.state='pending'
      AND j.context->>'replan_request_id'=c.replan_request_id::text) THEN 'planning'
    ELSE 'measuring' END);
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_replan_progress(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_energy_replan_progress(uuid) TO authenticated,service_role;
