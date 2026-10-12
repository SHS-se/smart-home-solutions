-- Reconstructed solar is ROI model input, never measured production or issued forecasts.
CREATE TABLE public.energy_roi_solar_profiles (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  start_ts timestamptz NOT NULL,
  end_ts timestamptz NOT NULL,
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance)='object'),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(home_id,profile_hash),
  CHECK (public.energy_home_matches_customer(home_id,customer_id)),
  CHECK (start_ts < end_ts AND extract(epoch FROM start_ts)%3600=0 AND extract(epoch FROM end_ts)%3600=0)
);
CREATE TABLE public.energy_roi_solar_hours (
  home_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  profile_hash text NOT NULL,
  start_ts timestamptz NOT NULL CHECK (extract(epoch FROM start_ts)%3600=0),
  raw_kwh numeric NOT NULL CHECK (raw_kwh>=0 AND raw_kwh<'Infinity'::numeric),
  modeled_kwh numeric NOT NULL CHECK (modeled_kwh>=0 AND modeled_kwh<'Infinity'::numeric),
  PRIMARY KEY(home_id,start_ts),
  FOREIGN KEY(home_id,profile_hash) REFERENCES public.energy_roi_solar_profiles(home_id,profile_hash) ON DELETE CASCADE,
  CHECK (public.energy_home_matches_customer(home_id,customer_id))
);
CREATE TABLE public.energy_roi_installations (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  equipment text NOT NULL CHECK (equipment IN ('solar','battery','bergvarme')),
  installed_month text NOT NULL CHECK (installed_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  source text NOT NULL DEFAULT 'owner_stated' CHECK (source='owner_stated'),
  PRIMARY KEY(home_id,equipment),
  CHECK (public.energy_home_matches_customer(home_id,customer_id))
);
ALTER TABLE public.energy_roi_solar_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_roi_solar_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_roi_installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Subscribers read own ROI solar profile" ON public.energy_roi_solar_profiles FOR SELECT TO authenticated USING(public.can_access_energy_billing_customer(customer_id));
CREATE POLICY "Subscribers read own reconstructed solar" ON public.energy_roi_solar_hours FOR SELECT TO authenticated USING(public.can_access_energy_billing_customer(customer_id));
CREATE POLICY "Subscribers read own installation milestones" ON public.energy_roi_installations FOR SELECT TO authenticated USING(public.can_access_energy_billing_customer(customer_id));
REVOKE ALL ON public.energy_roi_solar_profiles,public.energy_roi_solar_hours,public.energy_roi_installations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.energy_roi_solar_profiles,public.energy_roi_solar_hours,public.energy_roi_installations TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.energy_roi_installations TO service_role;
GRANT SELECT ON public.energy_roi_solar_profiles,public.energy_roi_solar_hours TO service_role;

-- Roll forward the one known equivalent v3 model: only obsolete display
-- outputs are removed. Financial ledgers and timestamps remain byte-identical.
-- The derived identity records the old source hash plus this schema revision.
UPDATE public.energy_roi_reports r SET
  version='roi-month-v4:9d0e033dd0ca322e7a1a9979e80150afaaf95e8012cafb11cf79c93cdf1629d6',
  model=jsonb_set(r.model,'{roi_solar_profile}','null'::jsonb),
  months=(SELECT coalesce(jsonb_object_agg(key,jsonb_set(jsonb_set(value,'{ledger}',
    jsonb_set(value->'ledger','{modeled}',(value->'ledger'->'modeled')-ARRAY['effects','timing'])
      || jsonb_build_object('solar',jsonb_build_object('profileHash',NULL,'reconstructedKwh',0,'reconstructedQuarters',0))),
    '{inputHash}',to_jsonb(encode(sha256(convert_to('roi-solar-v4:' || (value->>'inputHash'),'UTF8')),'hex')))), '{}'::jsonb)
    FROM jsonb_each(r.months)),
  generation=r.generation+1,updated_at=now()
WHERE r.version='roi-month-v3:f7abb0ec0cc2ec52ffaf037f3a25746a196a0b482841fc4014a59061b30087ec';

CREATE FUNCTION public.publish_energy_roi_solar_profile(p_home_id uuid,p_customer_id uuid,p_profile_hash text,p_start timestamptz,p_end timestamptz,p_provenance jsonb,p_hours jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old_hash text; old_start timestamptz; old_end timestamptz; expected_hours integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false) THEN RAISE EXCEPTION 'Solar publication access denied'; END IF;
  IF p_profile_hash IS NULL OR p_profile_hash !~ '^[a-f0-9]{64}$' OR p_start IS NULL OR p_end IS NULL OR p_start>=p_end
    OR extract(epoch FROM p_start)%3600<>0 OR extract(epoch FROM p_end)%3600<>0
    OR p_provenance IS NULL OR jsonb_typeof(p_provenance)<>'object' OR octet_length(p_provenance::text)>65536
    OR p_hours IS NULL OR jsonb_typeof(p_hours)<>'array' THEN RAISE EXCEPTION 'Invalid solar publication'; END IF;
  expected_hours := extract(epoch FROM p_end-p_start)/3600;
  IF expected_hours>9000 OR jsonb_array_length(p_hours)<>expected_hours THEN RAISE EXCEPTION 'Solar publication must cover every hour'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:' || p_home_id::text,0));
  SELECT profile_hash,start_ts,end_ts INTO old_hash,old_start,old_end FROM public.energy_roi_solar_profiles WHERE home_id=p_home_id;
  IF old_hash=p_profile_hash THEN RETURN old_hash; END IF;
  DELETE FROM public.energy_roi_solar_profiles WHERE home_id=p_home_id;
  INSERT INTO public.energy_roi_solar_profiles(home_id,customer_id,profile_hash,start_ts,end_ts,provenance)
    VALUES(p_home_id,p_customer_id,p_profile_hash,p_start,p_end,p_provenance);
  INSERT INTO public.energy_roi_solar_hours(home_id,customer_id,profile_hash,start_ts,raw_kwh,modeled_kwh)
    SELECT p_home_id,p_customer_id,p_profile_hash,start_ts,raw_kwh,modeled_kwh
      FROM jsonb_to_recordset(p_hours) AS hours(start_ts timestamptz,raw_kwh numeric,modeled_kwh numeric);
  IF (SELECT count(*) FROM public.energy_roi_solar_hours WHERE home_id=p_home_id AND start_ts>=p_start AND start_ts<p_end)<>expected_hours THEN
    RAISE EXCEPTION 'Solar publication must cover every hour'; END IF;
  -- Retain completed months outside both the new and superseded coverage.
  -- Their numeric ledgers are unchanged; only their pinned source identity moves.
  UPDATE public.energy_roi_reports r SET model=jsonb_set(r.model,'{roi_solar_profile}',to_jsonb(p_profile_hash)),
    months=(SELECT coalesce(jsonb_object_agg(key,jsonb_set(jsonb_set(value,'{ledger,solar,profileHash}',to_jsonb(p_profile_hash)),
      '{inputHash}',to_jsonb(encode(sha256(convert_to('roi-solar-profile:' || p_profile_hash || ':' || (value->>'inputHash'),'UTF8')),'hex')))), '{}'::jsonb)
      FROM jsonb_each(r.months) WHERE NOT (
        ((value->'ledger'->>'start')::timestamptz<p_end AND (value->'ledger'->>'end')::timestamptz>p_start)
        OR (old_start IS NOT NULL AND (value->'ledger'->>'start')::timestamptz<old_end AND (value->'ledger'->>'end')::timestamptz>old_start))),
    generation=r.generation+1,updated_at=now() WHERE home_id=p_home_id;
  RETURN p_profile_hash;
END $$;
REVOKE ALL ON FUNCTION public.publish_energy_roi_solar_profile(uuid,uuid,text,timestamptz,timestamptz,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_energy_roi_solar_profile(uuid,uuid,text,timestamptz,timestamptz,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.pin_energy_roi_report(p_home_id uuid, p_customer_id uuid, p_version text, p_model jsonb, p_expected_generation bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.energy_roi_reports;
BEGIN
  IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false)
    OR (auth.role() IS DISTINCT FROM 'service_role' AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id),false)) THEN
    RAISE EXCEPTION 'ROI report access denied';
  END IF;
  IF p_version IS NULL OR p_model IS NULL OR p_version !~ '^roi-month-v4:[a-f0-9]{64}$' OR jsonb_typeof(p_model) <> 'object'
    OR octet_length(p_model::text) > 65536
    OR p_model - ARRAY['captured_at','timezone','capabilities','battery','ev_battery','pool','device_physics','pool_model','grid','value_settings','device_models','services','comfort','policy','criteria','roi_solar_profile'] <> '{}'::jsonb
    OR NOT p_model ?& ARRAY['captured_at','timezone','capabilities','device_models','services','grid','comfort','policy','criteria','roi_solar_profile'] THEN
    RAISE EXCEPTION 'Invalid compact ROI model';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:' || p_home_id::text,0));
  IF (p_model->>'roi_solar_profile') IS DISTINCT FROM (SELECT profile_hash FROM public.energy_roi_solar_profiles WHERE home_id=p_home_id) THEN
    RAISE EXCEPTION 'ROI solar profile changed; reload the report';
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
  IF p_version IS NULL OR p_version !~ '^roi-month-v4:[a-f0-9]{64}$' THEN RAISE EXCEPTION 'ROI calculation updated; reload the page'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:' || p_home_id::text,0));
  month_key := p_ledger->>'month';
  IF p_generation IS NULL OR p_version IS NULL OR p_input_hash IS NULL OR month_key IS NULL OR month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' OR p_input_hash !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_ledger) <> 'object' OR octet_length(p_ledger::text)>16384
    OR p_ledger - ARRAY['month','start','end','timeZone','coverage','baseline','recorded','priceArea',
      'reconstructedPriceQuarters','assumedPriceQuarters','recovery','assumptions','quality','quarters','gaps','scheduler','modeled','replay','solar'] <> '{}'::jsonb
    OR NOT p_ledger ?& ARRAY['start','end','coverage','baseline','recorded','scheduler','modeled','replay','quality','gaps','solar']
    OR (p_ledger->>'end')::timestamptz <= (p_ledger->>'start')::timestamptz THEN
    RAISE EXCEPTION 'Invalid compact ROI month';
  END IF;
  SELECT * INTO r FROM public.energy_roi_reports WHERE home_id=p_home_id AND customer_id=p_customer_id FOR UPDATE;
  IF NOT FOUND OR r.generation<>p_generation OR r.version<>p_version THEN RAISE EXCEPTION 'ROI model changed; recalculate the report'; END IF;
  IF (r.model->>'roi_solar_profile') IS DISTINCT FROM (SELECT profile_hash FROM public.energy_roi_solar_profiles WHERE home_id=p_home_id)
    OR (p_ledger->'solar'->>'profileHash') IS DISTINCT FROM (r.model->>'roi_solar_profile') THEN
    RAISE EXCEPTION 'ROI solar profile changed; reload the report';
  END IF;
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

