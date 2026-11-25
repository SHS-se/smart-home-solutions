-- Start-up history is read per device, across rooms and source revisions. The
-- key-existence predicate is indexable; the numeric check still excludes
-- unavailable counters without changing any retained measured intervals.
CREATE INDEX energy_heating_observations_device_energy
  ON public.energy_heating_observations USING gin(device_energy_kwh);

CREATE OR REPLACE FUNCTION public.get_energy_heat_pump_intervals(
  p_home_id uuid, p_customer_id uuid, p_device_key text, p_from timestamptz, p_to timestamptz
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private AS $$
  SELECT CASE WHEN EXISTS (SELECT FROM public.energy_optimisation_devices d
    WHERE d.home_id = p_home_id AND d.customer_id = p_customer_id AND d.device_key = p_device_key
      AND d.retired_at IS NULL AND d.category = 'heating'
      AND COALESCE(d.load_type_override, d.suggested_load_type) = 'inverter') THEN (
  WITH intervals AS (
    SELECT DISTINCT ON (o.start_ts, o.duration_s) o.start_ts, o.duration_s,
      (o.device_energy_kwh ->> p_device_key)::double precision AS energy_kwh,
      o.outdoor_temperature_c, o.cooling, o.device_statistics ->> p_device_key AS statistic_id
    FROM public.energy_heating_observations o
    WHERE o.home_id = p_home_id AND o.customer_id = p_customer_id
      AND o.start_ts >= p_from AND o.start_ts < p_to
      AND o.device_energy_kwh ? p_device_key
      AND jsonb_typeof(o.device_energy_kwh -> p_device_key) = 'number'
    ORDER BY o.start_ts, o.duration_s, o.learning_updated_at DESC
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_array(
    extract(epoch FROM i.start_ts)::bigint, i.duration_s, i.energy_kwh, i.outdoor_temperature_c, p.peak_w, i.cooling
  ) ORDER BY i.start_ts, i.duration_s), '[]'::jsonb)
  FROM intervals i
  LEFT JOIN private.energy_heating_power_peaks p ON p.home_id = p_home_id AND p.device_key = p_device_key
    AND p.start_ts = i.start_ts AND p.duration_s = i.duration_s
  WHERE NOT EXISTS (SELECT FROM private.energy_heating_meter_exclusions x
    WHERE x.home_id = p_home_id AND x.device_key = p_device_key AND x.statistic_id = i.statistic_id
      AND x.valid_from < i.start_ts + make_interval(secs => i.duration_s) AND x.valid_to > i.start_ts)
  ) END;
$$;
REVOKE ALL ON FUNCTION public.get_energy_heat_pump_intervals(uuid, uuid, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_heat_pump_intervals(uuid, uuid, text, timestamptz, timestamptz)
  TO service_role;

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
  -- Publishing useful draw must not mark a failed start-up fit complete. Keep
  -- the same fenced job pending for the existing durable sweep to retry.
  IF j.owner_kind='device' AND patch#>'{last_fit_attempt,issues}' ? 'heat_pump_startup_unavailable' THEN
    UPDATE private.energy_learning_jobs SET pending=true,lease_until=NULL,
      wake_after=now()+interval '5 minutes',last_error='Heat pump start-up fit needs retry',finished_at=NULL
    WHERE id=j.id;
  ELSE
    UPDATE private.energy_learning_jobs SET pending=false,lease_until=NULL,last_error=NULL,finished_at=now() WHERE id=j.id;
  END IF;
  RETURN true;
END; $$;

-- Repair already-completed partial fits on deployment. No valid model or
-- observation is discarded; the normal leased worker publishes the result.
UPDATE private.energy_learning_jobs j SET pending=true,generation=j.generation+1,fence=j.fence+1,
  lease_until=NULL,wake_after=now(),attempts=0,last_error='Heat pump start-up fit needs retry',finished_at=NULL
FROM public.energy_optimisation_device_operating_points m,public.energy_optimisation_devices d
WHERE j.owner_kind='device' AND NOT j.pending AND j.last_error IS NULL
  AND m.home_id=j.home_id AND m.device_key=j.owner_key
  AND m.last_fit_attempt->'issues' ? 'heat_pump_startup_unavailable'
  AND d.home_id=j.home_id AND d.customer_id=j.customer_id AND d.device_key=j.owner_key
  AND d.retired_at IS NULL AND d.category='heating'
  AND COALESCE(d.load_type_override,d.suggested_load_type)='inverter';
