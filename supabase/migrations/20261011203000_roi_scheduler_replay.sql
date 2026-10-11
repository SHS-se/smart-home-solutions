CREATE OR REPLACE FUNCTION public.pin_energy_roi_report(p_home_id uuid, p_customer_id uuid, p_version text, p_model jsonb, p_expected_generation bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.energy_roi_reports;
BEGIN
  IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false)
    OR (auth.role() IS DISTINCT FROM 'service_role' AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id),false)) THEN
    RAISE EXCEPTION 'ROI report access denied';
  END IF;
  IF p_version IS NULL OR p_model IS NULL OR p_version !~ '^roi-month-v3:[a-f0-9]{64}$' OR jsonb_typeof(p_model) <> 'object'
    OR octet_length(p_model::text) > 65536
    OR p_model - ARRAY['captured_at','timezone','capabilities','battery','ev_battery','pool','device_physics','pool_model','grid','value_settings','device_models','services','comfort','policy','criteria'] <> '{}'::jsonb
    OR NOT p_model ?& ARRAY['captured_at','timezone','capabilities','device_models','services','grid','comfort','policy','criteria'] THEN
    RAISE EXCEPTION 'Invalid compact ROI model';
  END IF;
  INSERT INTO public.energy_roi_reports(home_id,customer_id,version,model)
    VALUES(p_home_id,p_customer_id,p_version,p_model) ON CONFLICT(home_id) DO NOTHING;
  SELECT * INTO r FROM public.energy_roi_reports WHERE home_id=p_home_id FOR UPDATE;
  IF r.version <> p_version OR (p_expected_generation IS NOT NULL AND r.generation=p_expected_generation) THEN
    UPDATE public.energy_roi_reports SET version=p_version,model=p_model,months='{}'::jsonb,
      generation=r.generation+1,updated_at=now() WHERE home_id=p_home_id RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('generation',r.generation,'version',r.version,'model',r.model,'months',r.months);
END $$;

CREATE OR REPLACE FUNCTION public.save_energy_roi_month(p_home_id uuid, p_customer_id uuid, p_generation bigint, p_version text,
  p_ledger jsonb, p_input_hash text, p_expected_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.energy_roi_reports; month_key text; previous jsonb; next_months jsonb;
BEGIN
  IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false)
    OR (auth.role() IS DISTINCT FROM 'service_role' AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id),false)) THEN
    RAISE EXCEPTION 'ROI report access denied';
  END IF;
  month_key := p_ledger->>'month';
  IF p_generation IS NULL OR p_version IS NULL OR p_input_hash IS NULL OR month_key IS NULL OR month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' OR p_input_hash !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_ledger) <> 'object' OR octet_length(p_ledger::text)>16384
    OR p_ledger - ARRAY['month','start','end','timeZone','coverage','baseline','recorded','priceArea',
      'reconstructedPriceQuarters','assumedPriceQuarters','recovery','assumptions','quality','quarters','gaps','scheduler','modeled','replay'] <> '{}'::jsonb
    OR NOT p_ledger ?& ARRAY['start','end','coverage','baseline','recorded','scheduler','modeled','replay','quality','gaps']
    OR (p_ledger->>'end')::timestamptz <= (p_ledger->>'start')::timestamptz THEN
    RAISE EXCEPTION 'Invalid compact ROI month';
  END IF;
  SELECT * INTO r FROM public.energy_roi_reports WHERE home_id=p_home_id AND customer_id=p_customer_id FOR UPDATE;
  IF NOT FOUND OR r.generation<>p_generation OR r.version<>p_version THEN RAISE EXCEPTION 'ROI model changed; recalculate the report'; END IF;
  previous := r.months->month_key;
  IF previous IS NOT NULL AND previous->>'inputHash'=p_input_hash THEN
    previous := jsonb_set(previous,'{computedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    UPDATE public.energy_roi_reports SET months=jsonb_set(r.months,ARRAY[month_key],previous),updated_at=now()
      WHERE home_id=p_home_id RETURNING * INTO r;
    RETURN jsonb_build_object('generation',r.generation,'version',r.version,'model',r.model,'months',r.months);
  END IF;
  IF (previous->>'inputHash') IS DISTINCT FROM p_expected_hash
    OR (previous IS NOT NULL AND (previous->'ledger'->>'end')::timestamptz > (p_ledger->>'end')::timestamptz) THEN
    RAISE EXCEPTION 'ROI month changed in another session; reload the report';
  END IF;
  next_months := r.months || jsonb_build_object(month_key,jsonb_build_object('ledger',p_ledger,'inputHash',p_input_hash,'computedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  -- Keep the twelve most recently calculated months, matching the report limit.
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO next_months FROM
    (SELECT key,value FROM jsonb_each(next_months) ORDER BY value->>'computedAt' DESC,key DESC LIMIT 12) recent;
  UPDATE public.energy_roi_reports SET months=next_months,updated_at=now() WHERE home_id=p_home_id RETURNING * INTO r;
  RETURN jsonb_build_object('generation',r.generation,'version',r.version,'model',r.model,'months',r.months);
END $$;
REVOKE ALL ON FUNCTION public.pin_energy_roi_report(uuid,uuid,text,jsonb,bigint) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.save_energy_roi_month(uuid,uuid,bigint,text,jsonb,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pin_energy_roi_report(uuid,uuid,text,jsonb,bigint) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_energy_roi_month(uuid,uuid,bigint,text,jsonb,text,text) TO authenticated,service_role;

CREATE FUNCTION public.get_energy_roi_criteria(p_customer_id uuid, p_home_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false)
 OR (auth.role() IS DISTINCT FROM 'service_role' AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id),false)) THEN
 RAISE EXCEPTION 'ROI report access denied'; END IF;
 RETURN coalesce((SELECT criteria FROM public.energy_planner_rule_policy WHERE id = true), '{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.get_energy_roi_criteria(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_energy_roi_criteria(uuid,uuid) TO authenticated,service_role;
