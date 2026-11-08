-- Learning owners for measured operating points.
-- The pool's fit publishes `operating_points` with the rest of its row. Every
-- other variable-power device is a `device` owner with the same daily cadence,
-- lease, fence and revision as a room or the pool. Its publication writes only
-- its own operating points, never equipment capability or another owner.
ALTER TABLE private.energy_learning_jobs DROP CONSTRAINT energy_learning_jobs_owner_kind_check;
ALTER TABLE private.energy_learning_jobs ADD CONSTRAINT energy_learning_jobs_owner_kind_check
  CHECK (owner_kind IN ('room','pool','device'));

-- As in 20261104150000, with the device owner's cadence added.
CREATE OR REPLACE FUNCTION public.request_energy_device_learning(p_home_id uuid,p_customer_id uuid,p_owners jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE o jsonb; v_id uuid; n integer:=0; due boolean;
BEGIN
  IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
  IF jsonb_typeof(p_owners) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid learning owners'; END IF;
  -- The capture supplies the complete current ownership set. Removal fences an
  -- in-flight fit too; retained models stay available if a device is remapped.
  UPDATE private.energy_learning_jobs j SET pending=false,generation=generation+1,fence=fence+1,
    lease_until=NULL,finished_at=now(),last_error='Learning owner removed'
  WHERE home_id=p_home_id AND pending AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_owners) AS current_owner(value)
      WHERE current_owner.value->>'kind'=j.owner_kind AND current_owner.value->>'key'=j.owner_key);
  FOR o IN SELECT value FROM jsonb_array_elements(p_owners) LOOP
    IF o->>'kind'='room' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at < now()-CASE WHEN trained THEN interval '24 hours' ELSE interval '1 hour' END
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
        OR last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'device_operating_points_v1'
      INTO due FROM public.energy_optimisation_device_operating_points WHERE home_id=p_home_id AND device_key=o->>'key';
    ELSE RAISE EXCEPTION 'Invalid learning owner'; END IF;
    IF COALESCE(due,true) THEN
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

-- As in 20261026001000, with operating_points for the pool and the device owner added.
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
      'solar_gain_c_per_h_per_wm2','solar_mean_w_per_m2','r2','residual_std_c','heat_lag_h','house_coupling_per_h','prediction_error_c'];
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
  IF j.owner_kind='room' AND (previous->>'trained')::boolean AND NOT (patch->>'trained')::boolean THEN
    patch:=jsonb_build_object('home_id',j.home_id,'room_key',j.owner_key,
      'last_attempted_at',patch->'last_attempted_at','last_fit_attempt',patch->'last_fit_attempt');
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

-- As in 20261026001000, with each device's operating points in the bundle.
CREATE OR REPLACE FUNCTION public.capture_energy_device_models(p_home_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object('rooms',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY room_key)
    FROM energy_optimisation_zone_models m WHERE home_id=p_home_id),'[]'::jsonb),
    'pool',(SELECT to_jsonb(m) FROM energy_optimisation_pool_model m WHERE home_id=p_home_id),
    'devices',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY device_key)
      FROM energy_optimisation_device_operating_points m WHERE home_id=p_home_id),'[]'::jsonb));
$$;
