-- Require reports generated with the full directional battery physics.
-- Existing version/generation transactions invalidate obsolete cached months.
CREATE OR REPLACE FUNCTION public.pin_energy_roi_report(p_home_id uuid, p_customer_id uuid, p_version text, p_model jsonb, p_expected_generation bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.energy_roi_reports;
BEGIN
  IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false)
    OR (auth.role() IS DISTINCT FROM 'service_role' AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id),false)) THEN
    RAISE EXCEPTION 'ROI report access denied';
  END IF;
  IF p_version IS NULL OR p_version !~ '^roi-month-v9:[a-f0-9]{64}$' THEN RAISE EXCEPTION 'ROI calculation updated; reload the page'; END IF;
  IF p_model IS NULL OR jsonb_typeof(p_model) <> 'object'
    OR octet_length(p_model::text) > 65536
    OR p_model - ARRAY['captured_at','timezone','capabilities','battery','ev_battery','pool','device_physics','pool_model','grid','value_settings','device_models','services','comfort','policy','criteria','roi_solar_profile','roi_pool_seed','roi_simulation_seed'] <> '{}'::jsonb
    OR NOT p_model ?& ARRAY['captured_at','timezone','capabilities','device_models','services','grid','comfort','policy','criteria','roi_solar_profile','roi_pool_seed','roi_simulation_seed'] THEN
    RAISE EXCEPTION 'Invalid compact ROI model';
  END IF;
  IF p_model->'roi_simulation_seed' <> 'null'::jsonb AND (
    jsonb_typeof(p_model->'roi_simulation_seed') IS DISTINCT FROM 'object'
    OR (p_model->'roi_simulation_seed')-ARRAY['month','hash'] <> '{}'::jsonb
    OR coalesce(p_model->'roi_simulation_seed'->>'month','') !~ '^\d{4}-(0[1-9]|1[0-2])$'
    OR coalesce(p_model->'roi_simulation_seed'->>'hash','') !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'Invalid simulation seed'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:' || p_home_id::text,0));
  IF (p_model->>'roi_solar_profile') IS DISTINCT FROM (SELECT profile_hash FROM public.energy_roi_solar_profiles WHERE home_id=p_home_id) THEN
    RAISE EXCEPTION 'ROI solar profile changed; reload the report';
  END IF;
  IF coalesce(p_model->'roi_pool_seed','null'::jsonb) IS DISTINCT FROM coalesce((SELECT seed FROM public.energy_roi_pool_seeds WHERE home_id=p_home_id),'null'::jsonb) THEN RAISE EXCEPTION 'ROI pool seed changed; reload the report'; END IF;
  INSERT INTO public.energy_roi_reports(home_id,customer_id,version,model)
    VALUES(p_home_id,p_customer_id,p_version,p_model) ON CONFLICT(home_id) DO NOTHING;
  SELECT * INTO r FROM public.energy_roi_reports WHERE home_id=p_home_id FOR UPDATE;
  IF r.version <> p_version OR (p_expected_generation IS NOT NULL AND r.generation=p_expected_generation) THEN
    DELETE FROM public.energy_roi_checkpoints WHERE home_id=p_home_id;
    UPDATE public.energy_roi_reports SET version=p_version,model=p_model,months='{}'::jsonb,
      generation=r.generation+1,updated_at=now() WHERE home_id=p_home_id RETURNING * INTO r;
  END IF;
  RETURN public.energy_roi_report_json(r);
END $$;
CREATE OR REPLACE FUNCTION public.save_energy_roi_month(p_home_id uuid, p_customer_id uuid, p_generation bigint, p_version text,
  p_ledger jsonb, p_input_hash text, p_expected_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.energy_roi_reports; month_key text; previous jsonb; next_months jsonb; seed jsonb; previous_checkpoint jsonb; initial_states jsonb; parent_hash text; parent_month text; checkpoint_value jsonb; continuation_unchanged boolean; response_state jsonb; seed_state jsonb;
BEGIN
  IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false)
    OR (auth.role() IS DISTINCT FROM 'service_role' AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id),false)) THEN
    RAISE EXCEPTION 'ROI report access denied';
  END IF;
  IF p_version IS NULL OR p_version !~ '^roi-month-v9:[a-f0-9]{64}$' THEN RAISE EXCEPTION 'ROI calculation updated; reload the page'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:' || p_home_id::text,0));
  month_key := p_ledger->>'month';
  IF p_generation IS NULL OR p_version IS NULL OR p_input_hash IS NULL OR month_key IS NULL OR month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' OR p_input_hash !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_ledger) <> 'object' OR octet_length(p_ledger::text)>16384
    OR p_ledger - ARRAY['month','start','end','timeZone','coverage','baseline','recorded','priceArea',
      'reconstructedPriceQuarters','assumedPriceQuarters','recovery','assumptions','quality','quarters','gaps','scheduler','modeled','replay','solar','continuation'] <> '{}'::jsonb
    OR NOT p_ledger ?& ARRAY['start','end','coverage','baseline','recorded','scheduler','modeled','replay','quality','gaps','solar','continuation']
    OR (p_ledger->>'end')::timestamptz <= (p_ledger->>'start')::timestamptz THEN
    RAISE EXCEPTION 'Invalid compact ROI month';
  END IF;
  SELECT * INTO r FROM public.energy_roi_reports WHERE home_id=p_home_id AND customer_id=p_customer_id FOR UPDATE;
  IF NOT FOUND OR r.generation<>p_generation OR r.version<>p_version THEN RAISE EXCEPTION 'ROI model changed; recalculate the report'; END IF;
  IF (r.model->>'roi_solar_profile') IS DISTINCT FROM (SELECT profile_hash FROM public.energy_roi_solar_profiles WHERE home_id=p_home_id)
    OR (p_ledger->'solar'->>'profileHash') IS DISTINCT FROM (r.model->>'roi_solar_profile') THEN
    RAISE EXCEPTION 'ROI solar profile changed; reload the report';
  END IF;
  seed := r.model->'roi_simulation_seed';
  IF coalesce(r.model->'roi_pool_seed','null'::jsonb) IS DISTINCT FROM coalesce((SELECT s.seed FROM public.energy_roi_pool_seeds s WHERE home_id=p_home_id),'null'::jsonb) THEN RAISE EXCEPTION 'ROI pool seed changed; reload the report'; END IF;
  IF coalesce(seed,'null'::jsonb)='null'::jsonb THEN
    IF p_ledger->'continuation' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unexpected simulation continuation'; END IF;
  ELSE
    IF (p_ledger->>'start')::timestamptz IS DISTINCT FROM (to_date(month_key||'-01','YYYY-MM-DD')::timestamp AT TIME ZONE (r.model->>'timezone'))
     OR (p_ledger->>'end')::timestamptz > ((to_date(month_key||'-01','YYYY-MM-DD')+interval '1 month') AT TIME ZONE (r.model->>'timezone'))
     OR ((p_ledger->>'coverage')::numeric=1 AND (p_ledger->>'end')::timestamptz IS DISTINCT FROM ((to_date(month_key||'-01','YYYY-MM-DD')+interval '1 month') AT TIME ZONE (r.model->>'timezone'))) THEN RAISE EXCEPTION 'Invalid simulation month boundaries'; END IF;
    IF month_key<seed->>'month' OR jsonb_typeof(p_ledger->'continuation') IS DISTINCT FROM 'object'
     OR (p_ledger->'continuation')-ARRAY['parentHash','initial','final']<>'{}'::jsonb
     OR NOT public.valid_energy_roi_simulation_state((p_ledger->'continuation')->'initial'->'baseline') OR NOT public.valid_energy_roi_simulation_state((p_ledger->'continuation')->'initial'->'scheduler')
     OR NOT public.valid_energy_roi_simulation_state((p_ledger->'continuation')->'final'->'baseline') OR NOT public.valid_energy_roi_simulation_state((p_ledger->'continuation')->'final'->'scheduler') THEN RAISE EXCEPTION 'Invalid simulation continuation'; END IF;
    IF month_key=seed->>'month' THEN
      parent_hash := seed->>'hash';
      initial_states := (p_ledger->'continuation')->'initial';
      IF initial_states->'baseline' IS DISTINCT FROM initial_states->'scheduler' THEN RAISE EXCEPTION 'ROI simulation predecessor changed; reload the report'; END IF;
      IF r.model->'roi_pool_seed' <> 'null'::jsonb THEN
        SELECT value INTO response_state FROM jsonb_array_elements(jsonb_build_array(
          r.model->'pool_model'->'thermal_dynamics'->'initial_state', r.model->'pool_model'->'thermal_dynamics'->'state'))
          WITH ORDINALITY AS states(value,position)
          WHERE (value->>'at')::timestamptz=(p_ledger->>'start')::timestamptz ORDER BY position LIMIT 1;
        seed_state := jsonb_build_object('poolC',r.model->'roi_pool_seed'->'temperatureC',
          'pendingHeatKwh',coalesce(response_state->'pending_heat_kwh','0'::jsonb),
          'sourceDepletionKwh',coalesce(response_state->'source_depletion_kwh','null'::jsonb),
          'heaterState',jsonb_build_object('kind','off_unobserved'));
        IF initial_states->'baseline'->'pool' IS DISTINCT FROM seed_state THEN RAISE EXCEPTION 'ROI simulation predecessor changed; reload the report'; END IF;
      END IF;
    ELSE
      parent_month := to_char(to_date(month_key||'-01','YYYY-MM-DD')-interval '1 month','YYYY-MM');
      SELECT checkpoint INTO previous_checkpoint FROM public.energy_roi_checkpoints WHERE home_id=p_home_id AND generation=p_generation AND month=parent_month;
      IF previous_checkpoint IS NULL OR (previous_checkpoint->>'end')::timestamptz IS DISTINCT FROM (p_ledger->>'start')::timestamptz THEN RAISE EXCEPTION 'ROI simulation predecessor missing'; END IF;
      parent_hash := previous_checkpoint->>'inputHash'; initial_states := previous_checkpoint->'final';
    END IF;
    IF (p_ledger->'continuation')->>'parentHash' IS DISTINCT FROM parent_hash OR (p_ledger->'continuation')->'initial' IS DISTINCT FROM initial_states THEN RAISE EXCEPTION 'ROI simulation predecessor changed; reload the report'; END IF;
  END IF;
  continuation_unchanged := EXISTS(SELECT 1 FROM public.energy_roi_checkpoints WHERE home_id=p_home_id AND generation=p_generation AND month=month_key AND checkpoint->>'inputHash'=p_input_hash);
  previous := r.months->month_key;
  IF previous IS NOT NULL AND previous->>'inputHash'=p_input_hash THEN
    previous := jsonb_set(previous,'{computedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    UPDATE public.energy_roi_reports SET months=jsonb_set(r.months,ARRAY[month_key],previous),updated_at=now()
      WHERE home_id=p_home_id RETURNING * INTO r;
    RETURN public.energy_roi_report_json(r);
  END IF;
  IF (previous->>'inputHash') IS DISTINCT FROM p_expected_hash
    OR (previous IS NOT NULL AND (previous->'ledger'->>'end')::timestamptz > (p_ledger->>'end')::timestamptz) THEN
    RAISE EXCEPTION 'ROI month changed in another session; reload the report';
  END IF;
  IF coalesce(seed,'null'::jsonb)<>'null'::jsonb AND NOT continuation_unchanged THEN
    DELETE FROM public.energy_roi_checkpoints WHERE home_id=p_home_id AND generation=p_generation AND month>=month_key;
    SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO r.months FROM jsonb_each(r.months) WHERE key<=month_key;
    IF (p_ledger->>'coverage')::numeric=1 THEN
      checkpoint_value := (p_ledger->'continuation')||jsonb_build_object('month',month_key,'start',p_ledger->>'start','end',p_ledger->>'end','inputHash',p_input_hash);
      INSERT INTO public.energy_roi_checkpoints(home_id,customer_id,generation,month,checkpoint) VALUES(p_home_id,p_customer_id,p_generation,month_key,checkpoint_value);
    END IF;
  END IF;
  next_months := r.months || jsonb_build_object(month_key,jsonb_build_object('ledger',p_ledger,'inputHash',p_input_hash,'computedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  -- Keep the twelve most recently calculated months, matching the report limit.
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO next_months FROM
    (SELECT key,value FROM jsonb_each(next_months) ORDER BY value->>'computedAt' DESC,key DESC LIMIT 12) recent;
  UPDATE public.energy_roi_reports SET months=next_months,updated_at=now() WHERE home_id=p_home_id RETURNING * INTO r;
  RETURN public.energy_roi_report_json(r);
END $$;
REVOKE ALL ON FUNCTION public.pin_energy_roi_report(uuid,uuid,text,jsonb,bigint) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.save_energy_roi_month(uuid,uuid,bigint,text,jsonb,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pin_energy_roi_report(uuid,uuid,text,jsonb,bigint) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_energy_roi_month(uuid,uuid,bigint,text,jsonb,text,text) TO authenticated,service_role;
