-- Qualify supplied owners separately from the loop variable when discovering observed rooms.
CREATE OR REPLACE FUNCTION public.request_energy_device_learning(p_home_id uuid,p_customer_id uuid,p_owners jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE o jsonb; v_id uuid; n integer:=0; due boolean; heating_bindings jsonb;
BEGIN
  IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
  IF jsonb_typeof(p_owners) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid learning owners'; END IF;
  -- Complete durable ownership includes passive observed graph nodes, but does
  -- not change the app's controllable-device roster or planning permissions.
  p_owners:=p_owners||coalesce((SELECT jsonb_agg(jsonb_build_object('kind','room','key',c.room_key,
    'input',coalesce((SELECT supplied.owner->'input' FROM jsonb_array_elements(p_owners) AS supplied(owner) WHERE supplied.owner->>'kind'='room' LIMIT 1),'{}'::jsonb)))
    FROM private.energy_room_observed_contexts(p_home_id,false) c
    WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(p_owners) AS supplied(owner)
      WHERE supplied.owner->>'kind'='room' AND supplied.owner->>'key'=c.room_key)),'[]'::jsonb);
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
          'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1')
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
