-- An explicit household assignment shares a meter with the room learner, not the scheduler.
CREATE TABLE private.energy_room_passive_heat_sources (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  room_key text NOT NULL,
  device_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (home_id, room_key),
  FOREIGN KEY (device_id, home_id, customer_id)
    REFERENCES public.energy_optimisation_devices(id, home_id, customer_id) ON DELETE CASCADE
);
REVOKE ALL ON private.energy_room_passive_heat_sources FROM PUBLIC, anon, authenticated;

ALTER TABLE public.energy_optimisation_zone_models ADD COLUMN passive_heat jsonb;

CREATE FUNCTION public.get_energy_room_passive_heat(
  p_customer_id uuid, p_home_id uuid, p_room_keys text[], p_from timestamptz, p_to timestamptz
) RETURNS TABLE (room_key text, device_key text, quarters jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private AS $$
  SELECT source.room_key, device.device_key, COALESCE((
    SELECT jsonb_agg(jsonb_build_array(extract(epoch FROM slot.start_ts) * 1000, slot.energy_kwh * 4000)
                     ORDER BY slot.start_ts)
    FROM public.energy_optimisation_device_slots slot
    WHERE slot.device_id = device.id AND slot.home_id = p_home_id AND slot.customer_id = p_customer_id
      AND slot.start_ts >= p_from AND slot.start_ts < p_to
  ), '[]'::jsonb)
  FROM private.energy_room_passive_heat_sources source
  JOIN public.energy_optimisation_devices device ON device.id = source.device_id
  WHERE source.home_id = p_home_id AND source.customer_id = p_customer_id
    AND source.room_key = ANY(p_room_keys)
    AND device.retired_at IS NULL AND device.planning_role_override = 'base_load';
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_passive_heat(uuid,uuid,text[],timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_passive_heat(uuid,uuid,text[],timestamptz,timestamptz)
  TO service_role;

-- The existing owner fence publishes the optional heat response with the room fit.
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
      'solar_gain_c_per_h_per_wm2','solar_mean_w_per_m2','r2','residual_std_c','heat_lag_h','house_coupling_per_h','prediction_error_c','passive_heat'];
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
