-- Model calibration revisions live independently of measured quarter retention.
ALTER TABLE public.energy_optimisation_zone_models ADD COLUMN heating_bands jsonb;

CREATE TABLE private.energy_heating_calibration_revisions (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('room','device')),
  owner_key text NOT NULL,
  revision uuid NOT NULL,
  band_c integer,
  calibration jsonb NOT NULL,
  PRIMARY KEY (home_id, owner_kind, owner_key, revision)
);
ALTER TABLE private.energy_heating_calibration_revisions ENABLE ROW LEVEL SECURITY;

-- Hash the room's current physical sources and members, including the meter identity.
-- Historic quarters preceding an observed room probe or a current meter are not
-- presumed to have the same provenance. A later binding change starts a new epoch.
CREATE FUNCTION private.energy_room_heating_contexts(p_home_id uuid, p_history boolean DEFAULT false)
RETURNS TABLE(room_key text, binding text, observed_since timestamptz)
LANGUAGE sql STABLE SET search_path=public AS $$
  WITH grouped AS (
    SELECT d.mapping_summary->>'room_key' AS room_key,
      max(d.first_seen_at) AS meters_since,
      jsonb_agg(jsonb_build_array(d.id,d.statistic_id,d.control_type_override) ORDER BY d.id) AS meters
    FROM energy_optimisation_devices d
    WHERE d.home_id=p_home_id AND d.retired_at IS NULL AND d.planning_role_override='controllable'
      AND d.control_type_override IN ('setpoint','switch_schedule')
      AND jsonb_typeof(d.mapping_summary->'room_key')='string'
    GROUP BY d.mapping_summary->>'room_key'
    HAVING bool_and(d.category='heating') AND bool_or(d.mapping_status='ready' AND d.mapped_control_type=d.control_type_override)
  ), changed AS (
    SELECT max(note_date)::timestamptz AS since
    FROM energy_history_notes
    WHERE home_id=p_home_id AND note_date<=current_date
      AND event_type IN ('renovation','heating_system_change')
  )
  SELECT g.room_key,
    md5(jsonb_build_array(g.meters,p.rooms->g.room_key->>'source_key',changed.since)::text),
    CASE WHEN probe.first_at IS NOT NULL THEN greatest(g.meters_since, probe.first_at, prior.last_at, changed.since) END
  FROM grouped g
  CROSS JOIN changed
  LEFT JOIN energy_room_profiles p ON p.home_id=p_home_id
  LEFT JOIN LATERAL (
    SELECT min(s.start_ts) AS first_at FROM energy_room_probe_slots s
    WHERE p_history AND s.home_id=p_home_id AND s.room_key=g.room_key AND s.source_key=p.rooms->g.room_key->>'source_key'
  ) probe ON true
  LEFT JOIN LATERAL (
    SELECT max(s.start_ts) + interval '15 minutes' AS last_at FROM energy_room_probe_slots s
    WHERE p_history AND s.home_id=p_home_id AND s.room_key=g.room_key AND s.source_key<>p.rooms->g.room_key->>'source_key'
  ) prior ON true;
$$;
REVOKE ALL ON FUNCTION private.energy_room_heating_contexts(uuid,boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.capture_energy_device_models(p_home_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT jsonb_build_object(
    'rooms',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY room_key)
      FROM energy_optimisation_zone_models m WHERE home_id=p_home_id),'[]'::jsonb),
    'pool',(SELECT to_jsonb(m) FROM energy_optimisation_pool_model m WHERE home_id=p_home_id),
    'devices',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY device_key)
      FROM energy_optimisation_device_operating_points m WHERE home_id=p_home_id),'[]'::jsonb),
    'room_heating',COALESCE((SELECT jsonb_object_agg(c.room_key,jsonb_build_object(
      'binding',c.binding,'observed_since',c.observed_since))
      FROM private.energy_room_heating_contexts(p_home_id) c),'{}'::jsonb)
  );
$$;

CREATE FUNCTION public.get_energy_room_heating_context(p_home_id uuid,p_room_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT to_jsonb(c)-'room_key'
  FROM private.energy_room_heating_contexts(p_home_id,true) c WHERE c.room_key=p_room_key;
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_heating_context(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_heating_context(uuid,text) TO service_role;

-- Find the last metered heating event per older weather band. The worker
-- reads one bounded training/holdout window, without loading a year of quarters.
CREATE FUNCTION public.get_energy_room_heating_band_history(
  p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(band_c integer,last_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT (floor(o.temperature_c/5)*5)::integer,max(o.start_ts)
  FROM energy_optimisation_devices d
  JOIN energy_optimisation_device_slots s ON s.device_id=d.id AND s.home_id=d.home_id
  JOIN energy_optimisation_outdoor_slots o ON o.home_id=s.home_id AND o.start_ts=s.start_ts
  JOIN energy_optimisation_thermal_slots t ON t.home_id=s.home_id AND t.start_ts=s.start_ts AND t.room_key=p_room_key
  WHERE d.home_id=p_home_id AND d.mapping_summary->>'room_key'=p_room_key AND d.retired_at IS NULL
    AND d.category='heating' AND d.planning_role_override='controllable'
    AND d.control_type_override IN ('setpoint','switch_schedule')
    AND s.start_ts>=p_from AND s.start_ts<p_to AND s.energy_kwh>0
    AND o.temperature_c IS NOT NULL AND t.room_temperature_c IS NOT NULL
  GROUP BY floor(o.temperature_c/5);
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_heating_band_history(uuid,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_heating_band_history(uuid,text,timestamptz,timestamptz) TO service_role;

CREATE FUNCTION private.archive_energy_heating_calibrations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE owner text; owner_key text; points jsonb; ref uuid; point jsonb; binding text;
BEGIN
  IF TG_TABLE_NAME='energy_optimisation_zone_models' THEN
    owner := 'room';
    owner_key := NEW.room_key;
    points := NEW.heating_bands->'active';
    binding := NEW.heating_bands->>'binding';
    ref := (NEW.heating_bands->>'reference_revision')::uuid;
    IF ref IS NOT NULL THEN
      INSERT INTO private.energy_heating_calibration_revisions(home_id,owner_kind,owner_key,revision,calibration)
      VALUES(NEW.home_id,owner,owner_key,ref,
        (to_jsonb(NEW)-'heating_bands'-'last_fit_attempt'-'last_attempted_at'-'model_revision')
          || jsonb_build_object('binding',binding))
      ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    owner := 'device';
    owner_key := NEW.device_key;
    points := NEW.operating_points->'points';
    binding := NEW.operating_points->>'binding';
    ref := (NEW.operating_points->'reference'->>'revision')::uuid;
    IF ref IS NOT NULL THEN
      INSERT INTO private.energy_heating_calibration_revisions(home_id,owner_kind,owner_key,revision,calibration)
      VALUES(NEW.home_id,owner,owner_key,ref,NEW.operating_points->'reference' || jsonb_build_object('binding',binding))
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  IF jsonb_typeof(points)='array' THEN
    FOR point IN SELECT value FROM jsonb_array_elements(points) WHERE value ? 'revision' LOOP
      INSERT INTO private.energy_heating_calibration_revisions(home_id,owner_kind,owner_key,revision,band_c,calibration)
      VALUES(NEW.home_id,owner,owner_key,(point->>'revision')::uuid,(point->>'band_c')::integer,
        point || jsonb_build_object('binding',binding))
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.archive_energy_heating_calibrations() FROM PUBLIC,anon,authenticated;

CREATE TRIGGER archive_room_heating_calibrations
  AFTER INSERT OR UPDATE OF heating_bands ON public.energy_optimisation_zone_models
  FOR EACH ROW EXECUTE FUNCTION private.archive_energy_heating_calibrations();
CREATE TRIGGER archive_device_heating_calibrations
  AFTER INSERT OR UPDATE OF operating_points ON public.energy_optimisation_device_operating_points
  FOR EACH ROW EXECUTE FUNCTION private.archive_energy_heating_calibrations();

CREATE OR REPLACE FUNCTION public.publish_energy_device_learning(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,p_model jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; previous jsonb; patch jsonb:=p_model;
  model_table text; keys text; columns_sql text; values_sql text; update_sql text; allowed text[];
BEGIN
  SELECT * INTO j FROM private.energy_learning_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR NOT j.pending OR j.generation<>p_generation OR j.fence<>p_fence
    OR j.lease_until IS NULL OR j.lease_until<=now() THEN RETURN false; END IF;
  IF j.owner_kind='room' THEN
    model_table:='energy_optimisation_zone_models'; keys:='home_id,room_key';
    SELECT to_jsonb(m) INTO previous FROM public.energy_optimisation_zone_models m
      WHERE home_id=j.home_id AND room_key=j.owner_key FOR UPDATE;
    allowed:=ARRAY['home_id','customer_id','room_key','room_name','fitted_at','training_from','training_to','sample_count',
      'trained','rejection_reason','last_attempted_at','last_fit_attempt','gain_c_per_wh','cooling_constant_per_h',
      'background_gain_c_per_h','thermal_capacity_wh_per_c','heat_loss_w_per_c','time_constant_h','heating_rate_c_per_h',
      'solar_gain_c_per_h_per_wm2','solar_mean_w_per_m2','r2','residual_std_c','heat_lag_h','house_coupling_per_h','prediction_error_c','passive_heat','doorway_exchange','heating_bands'];
  ELSIF j.owner_kind='device' THEN
    model_table:='energy_optimisation_device_operating_points'; keys:='home_id,device_key';
    SELECT to_jsonb(m) INTO previous FROM public.energy_optimisation_device_operating_points m
      WHERE home_id=j.home_id AND device_key=j.owner_key FOR UPDATE;
    allowed:=ARRAY['home_id','customer_id','device_key','fitted_at','operating_points','last_attempted_at','last_fit_attempt'];
  ELSE
    model_table:='energy_optimisation_pool_model'; keys:='home_id';
    SELECT to_jsonb(m) INTO previous FROM public.energy_optimisation_pool_model m WHERE home_id=j.home_id FOR UPDATE;
    allowed:=ARRAY['home_id','customer_id','fitted_at','loss_kw_per_k','rated_cop','cop_per_air_c','background_kw','r2',
      'sample_count','heated_sample_count','rejection','idle_loss_kw_per_k','idle_loss_hours','idle_loss_run_count',
      'idle_loss_rejection','response','thermal_dynamics','operating_points','last_attempted_at','last_fit_attempt'];
  END IF;
  IF COALESCE((previous->>'model_revision')::bigint,0)<>p_revision THEN
    UPDATE private.energy_learning_jobs SET lease_until=NULL,wake_after=now(),last_error='Model changed during fit' WHERE id=j.id;
    RETURN false;
  END IF;
  IF jsonb_typeof(patch)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(patch) k WHERE NOT k=ANY(allowed))
    OR (patch->>'home_id')::uuid IS DISTINCT FROM j.home_id OR (patch->>'customer_id')::uuid IS DISTINCT FROM j.customer_id
    OR (j.owner_kind='room' AND patch->>'room_key' IS DISTINCT FROM j.owner_key)
    OR (j.owner_kind='device' AND patch->>'device_key' IS DISTINCT FROM j.owner_key) THEN
    RAISE EXCEPTION 'Learning publication crosses owner boundary';
  END IF;
  IF j.owner_kind='room' AND jsonb_typeof(patch->'heating_bands')='object'
    AND patch->'heating_bands'->>'binding' IS DISTINCT FROM (
      SELECT c.binding FROM private.energy_room_heating_contexts(j.home_id) c WHERE c.room_key=j.owner_key
    ) THEN
    UPDATE private.energy_learning_jobs SET lease_until=NULL,wake_after=now(),last_error='Heating sources changed during fit' WHERE id=j.id;
    RETURN false;
  END IF;
  IF j.owner_kind='room' AND (previous->>'trained')::boolean AND NOT (patch->>'trained')::boolean THEN
    patch:=jsonb_build_object('home_id',j.home_id,'room_key',j.owner_key,
      'last_attempted_at',patch->'last_attempted_at','last_fit_attempt',patch->'last_fit_attempt')
      || CASE WHEN patch ? 'heating_bands' THEN jsonb_build_object('heating_bands',patch->'heating_bands') ELSE '{}'::jsonb END;
  END IF;
  -- Merge the existing record to satisfy complete-row constraints on conflict;
  -- update only supplied, whitelisted columns. Defaults apply on cold insert.
  SELECT string_agg(format('%I',k),','),string_agg(format('r.%I',k),','),
    string_agg(format('%I=EXCLUDED.%I',k,k),',')
    INTO columns_sql,values_sql,update_sql FROM jsonb_object_keys(COALESCE(previous,'{}')||patch) k
    WHERE k=ANY(allowed);
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r
    ON CONFLICT(%s) DO UPDATE SET %s',model_table,columns_sql,values_sql,model_table,keys,update_sql)
    USING COALESCE(previous,'{}')||patch;
  UPDATE private.energy_learning_jobs SET pending=false,lease_until=NULL,last_error=NULL,finished_at=now() WHERE id=j.id;
  RETURN true;
END; $$;

-- Read the two directions of a doorway distinctly. The selected room is the
-- source in this scenario, so its neighbours supply the receiving-room fits.
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
      || jsonb_build_object('temperature_bands', COALESCE((
        SELECT model.heating_bands->'active' FROM private.energy_room_heating_contexts(p_home_id) c
        WHERE c.room_key=model.room_key AND c.binding=model.heating_bands->>'binding'
      ),'[]'::jsonb))
      FROM public.energy_optimisation_zone_models model
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
        OR (heating_bands IS NOT NULL AND heating_bands->>'binding' IS DISTINCT FROM heating_bindings->>(o->>'key'))
        OR (trained AND last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'interval_mean_transition_holdout_v1')
        OR (trained AND last_fit_attempt->'learning'->>'family' IS DISTINCT FROM 'house_outdoor_solar_v1')
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
