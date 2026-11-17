-- An optional calibration, published atomically alongside the receiving room model.
ALTER TABLE public.energy_optimisation_zone_models ADD COLUMN doorway_exchange jsonb;

-- Return only current probe sources for configured edges. A NULL training start
-- requests one observation per peer at or before the completed capture quarter.
CREATE FUNCTION public.get_energy_doorway_probes(
  p_home_id uuid, p_room_keys text[], p_from timestamptz, p_to timestamptz
) RETURNS TABLE (room_key text, other_key text, room_source text, other_source text, quarters jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT edge.room_key, edge.other_key, binding.receiver, binding.peer, observed.quarters
  FROM public.energy_room_profiles profile
  CROSS JOIN LATERAL jsonb_array_elements(profile.connections) AS connection(pair)
  CROSS JOIN LATERAL (VALUES
    (connection.pair->'rooms'->>0, connection.pair->'rooms'->>1),
    (connection.pair->'rooms'->>1, connection.pair->'rooms'->>0)
  ) AS edge(room_key, other_key)
  CROSS JOIN LATERAL (VALUES
    (profile.rooms->edge.room_key->>'source_key', profile.rooms->edge.other_key->>'source_key')
  ) AS binding(receiver, peer)
  CROSS JOIN LATERAL (
    SELECT CASE WHEN p_from IS NULL THEN COALESCE((
      SELECT jsonb_build_array(jsonb_build_array(extract(epoch FROM slot.start_ts)*1000,slot.temperature_c))
      FROM public.energy_room_probe_slots slot
      WHERE slot.home_id = p_home_id AND slot.room_key = edge.other_key
        AND slot.source_key = binding.peer AND slot.start_ts < p_to
      ORDER BY slot.start_ts DESC LIMIT 1
    ),'[]'::jsonb) ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_array(extract(epoch FROM slot.start_ts)*1000,slot.temperature_c,receiver.temperature_c) ORDER BY slot.start_ts)
      FROM public.energy_room_probe_slots slot
      JOIN public.energy_room_probe_slots receiver
        ON receiver.home_id = slot.home_id AND receiver.room_key = edge.room_key
        AND receiver.source_key = binding.receiver AND receiver.start_ts = slot.start_ts
      WHERE slot.home_id = p_home_id AND slot.room_key = edge.other_key
        AND slot.source_key = binding.peer AND slot.start_ts >= p_from AND slot.start_ts < p_to
    ),'[]'::jsonb) END AS quarters
  ) AS observed
  WHERE profile.home_id = p_home_id AND edge.room_key = ANY(p_room_keys)
    AND binding.receiver IS NOT NULL AND binding.peer IS NOT NULL
  ORDER BY edge.room_key, edge.other_key;
$$;
REVOKE ALL ON FUNCTION public.get_energy_doorway_probes(uuid,text[],timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_doorway_probes(uuid,text[],timestamptz,timestamptz) TO service_role;

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
      'solar_gain_c_per_h_per_wm2','solar_mean_w_per_m2','r2','residual_std_c','heat_lag_h','house_coupling_per_h','prediction_error_c','passive_heat','doorway_exchange'];
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
