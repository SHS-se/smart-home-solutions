-- One bounded evidence owner for general and band responses. Raw history and
-- archived calibrations keep their independent retention/provenance contracts.
-- One current ledger per scope holds at most ten working records; accepted
-- model revisions retain their compact support in the existing revision archive.
ALTER TABLE public.energy_optimisation_zone_models DROP CONSTRAINT energy_optimisation_zone_models_rejection_reason_check;
ALTER TABLE public.energy_optimisation_zone_models ADD CONSTRAINT energy_optimisation_zone_models_rejection_reason_check
 CHECK(rejection_reason IS NULL OR rejection_reason IN ('insufficient_samples','insufficient_heating',
 'singular','poor_fit','non_physical','sensor_tracks_outdoor','response_unresolved','insufficient_heating_runs'));

ALTER TABLE private.energy_room_fit_progress DROP CONSTRAINT energy_room_fit_progress_cells_check;
ALTER TABLE private.energy_room_fit_progress ADD CONSTRAINT energy_room_fit_progress_cells_check
 CHECK(jsonb_typeof(cells)='array' AND jsonb_array_length(cells)<=36);

CREATE TABLE private.energy_room_run_ledgers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL,
 room_key text NOT NULL,
 scope_key text NOT NULL,
 model_revision bigint NOT NULL,
 job_id uuid NOT NULL,
 generation bigint NOT NULL,
 evidence jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(home_id,room_key,scope_key),
 CHECK(evidence IS NULL OR (jsonb_typeof(evidence->'runs')='array' AND jsonb_array_length(evidence->'runs')<=10))
);
ALTER TABLE private.energy_room_run_ledgers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_room_run_ledgers FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_metadata jsonb,p_capture_base64 text,p_cell jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF p_expected_cursor=-1 THEN
   IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR p_capture_base64 IS NULL
     OR p_cell IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial room fit capture'; END IF;
   INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture)
   VALUES(p_job_id,p_generation,p_revision,p_metadata,decode(p_capture_base64,'base64'))
   ON CONFLICT(job_id) DO NOTHING;
 ELSE
   IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR p_expected_cursor>=36
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

CREATE OR REPLACE FUNCTION public.checkpoint_energy_room_heat_iteration(
 p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_expected_state jsonb,p_heat_state jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR p_expected_cursor>=36
   OR jsonb_typeof(p_heat_state) IS DISTINCT FROM 'object'
   OR p_heat_state->>'version' IS DISTINCT FROM '2'
   OR (p_heat_state->>'index')::integer IS DISTINCT FROM mod(p_expected_cursor,18) THEN
   RAISE EXCEPTION 'Invalid room response iteration';
 END IF;
 UPDATE private.energy_room_fit_progress SET metadata=jsonb_set(metadata,'{heat_state}',p_heat_state)
 WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
   AND jsonb_array_length(cells)=p_expected_cursor
   AND nullif(metadata->'heat_state','null'::jsonb) IS NOT DISTINCT FROM nullif(p_expected_state,'null'::jsonb);
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;

DROP FUNCTION public.complete_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb);
CREATE FUNCTION public.complete_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_model jsonb,p_run_ledger jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE captured jsonb; owner private.energy_learning_jobs%ROWTYPE; fitted integer; retained integer;
 previous_library jsonb; new_summary jsonb; scope text; changed boolean; new_candidates jsonb;
BEGIN
 p_run_ledger:=nullif(p_run_ledger,'null'::jsonb);
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT metadata->'capture' INTO captured FROM private.energy_room_fit_progress
 WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
   AND jsonb_array_length(cells)=p_expected_cursor;
 IF p_expected_cursor IS DISTINCT FROM 36 OR captured IS NULL THEN RETURN false; END IF;
 IF p_run_ledger IS NOT NULL THEN
   IF p_run_ledger->>'policy' IS DISTINCT FROM 'recent_independent_runs_v1'
     OR jsonb_typeof(p_run_ledger->'runs') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_run_ledger->'runs')>10 THEN RAISE EXCEPTION 'Invalid run evidence'; END IF;
   SELECT count(*) FILTER(WHERE run->>'disposition'='fitted'),count(*) INTO fitted,retained
   FROM jsonb_array_elements(p_run_ledger->'runs') run;
   IF fitted IS DISTINCT FROM (p_run_ledger->>'fitted_runs')::integer
     OR retained IS DISTINCT FROM (p_run_ledger->>'retained_runs')::integer
     OR (fitted>0 AND fitted<3)
     OR retained<>(SELECT count(DISTINCT run->>'id') FROM jsonb_array_elements(p_run_ledger->'runs') run) THEN
     RAISE EXCEPTION 'Run support must contain three to ten distinct events';
   END IF;
 END IF;
 SELECT * INTO owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 scope:=captured#>>'{window,window_key}';
 SELECT heating_bands INTO previous_library FROM public.energy_optimisation_zone_models
 WHERE home_id=owner.home_id AND room_key=owner.owner_key;
 IF scope='general' THEN
   changed:=p_model#>>'{heating_bands,reference_revision}' IS DISTINCT FROM previous_library->>'reference_revision';
   new_summary:=p_model#>'{heating_bands,reference,learning_evidence,run_calibration}';
 ELSE
   SELECT coalesce(jsonb_agg(candidate),'[]'::jsonb) INTO new_candidates
   FROM jsonb_array_elements(coalesce(p_model#>'{heating_bands,active}','[]'::jsonb)) candidate
   WHERE candidate->>'band_c'=scope AND NOT EXISTS (
     SELECT FROM jsonb_array_elements(coalesce(previous_library->'active','[]'::jsonb)) old
     WHERE old->>'revision'=candidate->>'revision');
   IF jsonb_array_length(new_candidates)>1 THEN RAISE EXCEPTION 'Only one response revision may be published per band'; END IF;
   changed:=jsonb_array_length(new_candidates)=1;
   new_summary:=new_candidates#>'{0,learning_evidence,run_calibration}';
   IF p_model#>>ARRAY['heating_bands','diagnostics',scope,'status']='fitted' AND NOT changed THEN
     RAISE EXCEPTION 'Fitted attempt must activate its new response revision';
   END IF;
 END IF;
 IF coalesce(changed,false) AND (p_run_ledger IS NULL OR fitted<3
   OR new_summary IS DISTINCT FROM (p_run_ledger-'runs')) THEN
   RAISE EXCEPTION 'Published response must match its fitted run evidence';
 END IF;
 -- Publication retains source, owner and model-revision checks. The detailed
 -- ledger is not placed in heating_bands or sent in every planning capture.
 IF NOT public.publish_energy_device_learning(p_job_id,p_generation,p_fence,p_revision,p_model) THEN RETURN false; END IF;
 INSERT INTO private.energy_room_run_ledgers(home_id,customer_id,room_key,scope_key,model_revision,job_id,generation,evidence)
 VALUES(owner.home_id,owner.customer_id,owner.owner_key,captured#>>'{window,window_key}',p_revision+1,p_job_id,p_generation,p_run_ledger)
 ON CONFLICT(home_id,room_key,scope_key) DO UPDATE SET model_revision=EXCLUDED.model_revision,
   job_id=EXCLUDED.job_id,generation=EXCLUDED.generation,evidence=EXCLUDED.evidence,created_at=now();
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.complete_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb,jsonb) TO service_role;

CREATE FUNCTION public.get_energy_room_run_evidence(p_home_id uuid,p_room_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.homes h WHERE h.id=p_home_id AND public.can_access_energy_billing_customer(h.customer_id)) THEN
   RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE='42501';
 END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(latest) ORDER BY scope_key),'[]'::jsonb) FROM (
   SELECT DISTINCT ON(scope_key) scope_key,model_revision,created_at,evidence FROM private.energy_room_run_ledgers
   WHERE home_id=p_home_id AND room_key=p_room_key ORDER BY scope_key,model_revision DESC
 ) latest);
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_room_run_evidence(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_energy_room_run_evidence(uuid,text) TO authenticated,service_role;

-- Model tabs describe stored revisions, including retained unassessed fits.
CREATE OR REPLACE FUNCTION public.get_energy_room_model_scenario(p_home_id uuid, p_room_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT FROM public.homes
    WHERE id = p_home_id AND public.can_access_energy_billing_customer(customer_id)) THEN
    RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'room', (SELECT (to_jsonb(model) - 'doorway_exchange' - 'passive_heat' - 'heating_bands')
      || COALESCE(fit.reference,'{}'::jsonb)
      || jsonb_build_object('temperature_bands', COALESCE(fit.bands,'[]'::jsonb),
        'general_learning_evidence',fit.reference_evidence)
      FROM public.energy_optimisation_zone_models model
      LEFT JOIN LATERAL (
        SELECT model.heating_bands->'active' AS bands, model.heating_bands->'reference'->'model' AS reference,
          model.heating_bands#>'{reference,learning_evidence}' AS reference_evidence
        FROM private.energy_room_heating_contexts(p_home_id) c
        WHERE c.room_key=model.room_key AND c.binding=model.heating_bands->>'binding'
      ) fit ON true
      WHERE model.home_id = p_home_id AND model.room_key = p_room_key),
    'connections', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', edge.other_key, 'name', profile.rooms->edge.other_key->>'name',
        'model', CASE WHEN learned.peer IS NOT NULL
          THEN to_jsonb(receiver) - 'doorway_exchange' - 'passive_heat' - 'heating_bands' END,
        'doorway', CASE WHEN learned.peer IS NOT NULL THEN jsonb_build_object(
          'weight', learned.peer->'weight', 'usual', learned.peer->'usual') END
      ) ORDER BY profile.rooms->edge.other_key->>'name', edge.other_key)
      FROM public.energy_room_profiles profile
      CROSS JOIN LATERAL jsonb_array_elements(profile.connections) AS connection(pair)
      CROSS JOIN LATERAL (VALUES
        (connection.pair->'rooms'->>0, connection.pair->'rooms'->>1),
        (connection.pair->'rooms'->>1, connection.pair->'rooms'->>0)
      ) AS edge(room_key, other_key)
      LEFT JOIN public.energy_optimisation_zone_models receiver
        ON receiver.home_id = profile.home_id AND receiver.room_key = edge.other_key AND receiver.trained
      LEFT JOIN LATERAL (
        SELECT peer FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(receiver.doorway_exchange->'peers') = 'array'
            THEN receiver.doorway_exchange->'peers' ELSE '[]'::jsonb END
        ) AS fit(peer)
        WHERE receiver.doorway_exchange->>'source' = profile.rooms->edge.other_key->>'source_key'
          AND peer->>'key' = p_room_key
          AND peer->>'source' = profile.rooms->p_room_key->>'source_key'
      ) learned ON true
      WHERE profile.home_id = p_home_id AND edge.room_key = p_room_key
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

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
        OR (heating_bindings ? (o->>'key') AND heating_bands->>'calibration_policy' IS DISTINCT FROM 'recent_independent_runs_v1')
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL
          AND heating_bands->>'binding' IS DISTINCT FROM heating_bindings->>(o->>'key'))
        OR (trained AND (heating_bands->>'reference_revision' IS NULL OR NOT (heating_bindings ? (o->>'key')))
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
    (NOT trained AND rejection_reason IS NOT NULL
      AND gain_c_per_wh IS NULL
      AND cooling_constant_per_h IS NULL)
  );
