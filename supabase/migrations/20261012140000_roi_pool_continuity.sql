-- Owner-stated pool initialization and independent model continuations.
CREATE TABLE public.energy_roi_pool_seeds (
 home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
 seed jsonb NOT NULL CHECK(jsonb_typeof(seed)='object'),
 source text NOT NULL DEFAULT 'owner_stated' CHECK(source='owner_stated'),
 CHECK(public.energy_home_matches_customer(home_id,customer_id))
);
CREATE TABLE public.energy_roi_pool_checkpoints (
 home_id uuid NOT NULL REFERENCES public.energy_roi_reports(home_id) ON DELETE CASCADE,
 customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
 generation bigint NOT NULL,
 month text NOT NULL CHECK(month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 checkpoint jsonb NOT NULL CHECK(jsonb_typeof(checkpoint)='object'),
 PRIMARY KEY(home_id,generation,month),
 CHECK(public.energy_home_matches_customer(home_id,customer_id))
);
ALTER TABLE public.energy_roi_pool_seeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_roi_pool_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Subscribers read pool seed" ON public.energy_roi_pool_seeds FOR SELECT TO authenticated USING(public.can_access_energy_billing_customer(customer_id));
CREATE POLICY "Subscribers read pool continuity" ON public.energy_roi_pool_checkpoints FOR SELECT TO authenticated USING(public.can_access_energy_billing_customer(customer_id));
REVOKE ALL ON public.energy_roi_pool_seeds,public.energy_roi_pool_checkpoints FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.energy_roi_pool_seeds,public.energy_roi_pool_checkpoints TO authenticated,service_role;

CREATE FUNCTION public.energy_roi_report_json(r public.energy_roi_reports) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT jsonb_build_object('generation',r.generation,'version',r.version,'model',r.model,'months',r.months,'checkpoints',
  (SELECT coalesce(jsonb_object_agg(month,checkpoint),'{}'::jsonb) FROM public.energy_roi_pool_checkpoints WHERE home_id=r.home_id AND generation=r.generation));
$$;
REVOKE ALL ON FUNCTION public.energy_roi_report_json(public.energy_roi_reports) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.valid_energy_roi_pool_state(s jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(s)='object' AND s-ARRAY['poolC','heaterState']='{}'::jsonb AND s ?& ARRAY['poolC','heaterState']
  AND jsonb_typeof(s->'poolC')='number' AND jsonb_typeof(s->'heaterState')='object'
  AND CASE WHEN (s->'heaterState')->>'kind' IN ('off_unobserved','steady') THEN (s->'heaterState')-'kind'='{}'::jsonb
   WHEN (s->'heaterState')->>'kind' IN ('off','running') THEN (s->'heaterState')-ARRAY['kind','seconds']='{}'::jsonb
    AND jsonb_typeof((s->'heaterState')->'seconds')='number' AND ((s->'heaterState')->>'seconds')::numeric>=0 ELSE false END,false);
$$;
REVOKE ALL ON FUNCTION public.valid_energy_roi_pool_state(jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.publish_energy_roi_pool_seed(p_home_id uuid,p_customer_id uuid,p_month text,p_temperature_c numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v jsonb; old jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false) THEN RAISE EXCEPTION 'Pool seed publication access denied'; END IF;
 IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' OR p_temperature_c IS NULL OR NOT(p_temperature_c>'-Infinity'::numeric AND p_temperature_c<'Infinity'::numeric) THEN RAISE EXCEPTION 'Invalid pool seed'; END IF;
 v := jsonb_build_object('month',p_month,'temperatureC',p_temperature_c);
 v := v || jsonb_build_object('hash',encode(sha256(convert_to(v::text,'UTF8')),'hex'));
 PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:'||p_home_id::text,0));
 SELECT seed INTO old FROM public.energy_roi_pool_seeds WHERE home_id=p_home_id;
 IF old=v THEN RETURN v; END IF;
 INSERT INTO public.energy_roi_pool_seeds(home_id,customer_id,seed) VALUES(p_home_id,p_customer_id,v) ON CONFLICT(home_id) DO UPDATE SET seed=EXCLUDED.seed;
 DELETE FROM public.energy_roi_pool_checkpoints WHERE home_id=p_home_id;
 UPDATE public.energy_roi_reports SET model=jsonb_set(model,'{roi_pool_seed}',v),months='{}'::jsonb,generation=generation+1,updated_at=now() WHERE home_id=p_home_id;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.publish_energy_roi_pool_seed(uuid,uuid,text,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_energy_roi_pool_seed(uuid,uuid,text,numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.pin_energy_roi_report(p_home_id uuid, p_customer_id uuid, p_version text, p_model jsonb, p_expected_generation bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.energy_roi_reports;
BEGIN
  IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false)
    OR (auth.role() IS DISTINCT FROM 'service_role' AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id),false)) THEN
    RAISE EXCEPTION 'ROI report access denied';
  END IF;
  IF p_version IS NULL OR p_model IS NULL OR p_version !~ '^roi-month-v5:[a-f0-9]{64}$' OR jsonb_typeof(p_model) <> 'object'
    OR octet_length(p_model::text) > 65536
    OR p_model - ARRAY['captured_at','timezone','capabilities','battery','ev_battery','pool','device_physics','pool_model','grid','value_settings','device_models','services','comfort','policy','criteria','roi_solar_profile','roi_pool_seed'] <> '{}'::jsonb
    OR NOT p_model ?& ARRAY['captured_at','timezone','capabilities','device_models','services','grid','comfort','policy','criteria','roi_solar_profile','roi_pool_seed'] THEN
    RAISE EXCEPTION 'Invalid compact ROI model';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:' || p_home_id::text,0));
  IF (p_model->>'roi_solar_profile') IS DISTINCT FROM (SELECT profile_hash FROM public.energy_roi_solar_profiles WHERE home_id=p_home_id) THEN
    RAISE EXCEPTION 'ROI solar profile changed; reload the report';
  END IF;
  IF coalesce(p_model->'roi_pool_seed','null'::jsonb) IS DISTINCT FROM coalesce((SELECT seed FROM public.energy_roi_pool_seeds WHERE home_id=p_home_id),'null'::jsonb) THEN RAISE EXCEPTION 'ROI pool seed changed; reload the report'; END IF;
  INSERT INTO public.energy_roi_reports(home_id,customer_id,version,model)
    VALUES(p_home_id,p_customer_id,p_version,p_model) ON CONFLICT(home_id) DO NOTHING;
  SELECT * INTO r FROM public.energy_roi_reports WHERE home_id=p_home_id FOR UPDATE;
  IF r.version <> p_version OR (p_expected_generation IS NOT NULL AND r.generation=p_expected_generation) THEN
    DELETE FROM public.energy_roi_pool_checkpoints WHERE home_id=p_home_id;
    UPDATE public.energy_roi_reports SET version=p_version,model=p_model,months='{}'::jsonb,
      generation=r.generation+1,updated_at=now() WHERE home_id=p_home_id RETURNING * INTO r;
  END IF;
  RETURN public.energy_roi_report_json(r);
END $$;

CREATE OR REPLACE FUNCTION public.save_energy_roi_month(p_home_id uuid, p_customer_id uuid, p_generation bigint, p_version text,
  p_ledger jsonb, p_input_hash text, p_expected_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.energy_roi_reports; month_key text; previous jsonb; next_months jsonb; seed jsonb; previous_checkpoint jsonb; initial_states jsonb; parent_hash text; parent_month text; checkpoint_value jsonb;
BEGIN
  IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false)
    OR (auth.role() IS DISTINCT FROM 'service_role' AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id),false)) THEN
    RAISE EXCEPTION 'ROI report access denied';
  END IF;
  IF p_version IS NULL OR p_version !~ '^roi-month-v5:[a-f0-9]{64}$' THEN RAISE EXCEPTION 'ROI calculation updated; reload the page'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy-roi:' || p_home_id::text,0));
  month_key := p_ledger->>'month';
  IF p_generation IS NULL OR p_version IS NULL OR p_input_hash IS NULL OR month_key IS NULL OR month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' OR p_input_hash !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_ledger) <> 'object' OR octet_length(p_ledger::text)>16384
    OR p_ledger - ARRAY['month','start','end','timeZone','coverage','baseline','recorded','priceArea',
      'reconstructedPriceQuarters','assumedPriceQuarters','recovery','assumptions','quality','quarters','gaps','scheduler','modeled','replay','solar','pool'] <> '{}'::jsonb
    OR NOT p_ledger ?& ARRAY['start','end','coverage','baseline','recorded','scheduler','modeled','replay','quality','gaps','solar','pool']
    OR (p_ledger->>'end')::timestamptz <= (p_ledger->>'start')::timestamptz THEN
    RAISE EXCEPTION 'Invalid compact ROI month';
  END IF;
  SELECT * INTO r FROM public.energy_roi_reports WHERE home_id=p_home_id AND customer_id=p_customer_id FOR UPDATE;
  IF NOT FOUND OR r.generation<>p_generation OR r.version<>p_version THEN RAISE EXCEPTION 'ROI model changed; recalculate the report'; END IF;
  IF (r.model->>'roi_solar_profile') IS DISTINCT FROM (SELECT profile_hash FROM public.energy_roi_solar_profiles WHERE home_id=p_home_id)
    OR (p_ledger->'solar'->>'profileHash') IS DISTINCT FROM (r.model->>'roi_solar_profile') THEN
    RAISE EXCEPTION 'ROI solar profile changed; reload the report';
  END IF;
  seed := r.model->'roi_pool_seed';
  IF coalesce(seed,'null'::jsonb) IS DISTINCT FROM coalesce((SELECT s.seed FROM public.energy_roi_pool_seeds s WHERE home_id=p_home_id),'null'::jsonb) THEN RAISE EXCEPTION 'ROI pool seed changed; reload the report'; END IF;
  IF coalesce(seed,'null'::jsonb)='null'::jsonb THEN
    IF p_ledger->'pool' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unexpected pool continuation'; END IF;
  ELSE
    IF (p_ledger->>'start')::timestamptz IS DISTINCT FROM (to_date(month_key||'-01','YYYY-MM-DD')::timestamp AT TIME ZONE (r.model->>'timezone'))
     OR (p_ledger->>'end')::timestamptz > ((to_date(month_key||'-01','YYYY-MM-DD')+interval '1 month') AT TIME ZONE (r.model->>'timezone'))
     OR ((p_ledger->>'coverage')::numeric=1 AND (p_ledger->>'end')::timestamptz IS DISTINCT FROM ((to_date(month_key||'-01','YYYY-MM-DD')+interval '1 month') AT TIME ZONE (r.model->>'timezone'))) THEN RAISE EXCEPTION 'Invalid pool month boundaries'; END IF;
    IF month_key<seed->>'month' OR jsonb_typeof(p_ledger->'pool') IS DISTINCT FROM 'object'
     OR (p_ledger->'pool')-ARRAY['parentHash','initial','final']<>'{}'::jsonb
     OR NOT public.valid_energy_roi_pool_state((p_ledger->'pool')->'initial'->'baseline') OR NOT public.valid_energy_roi_pool_state((p_ledger->'pool')->'initial'->'scheduler')
     OR NOT public.valid_energy_roi_pool_state((p_ledger->'pool')->'final'->'baseline') OR NOT public.valid_energy_roi_pool_state((p_ledger->'pool')->'final'->'scheduler') THEN RAISE EXCEPTION 'Invalid pool continuation'; END IF;
    IF month_key=seed->>'month' THEN
      parent_hash := seed->>'hash';
      initial_states := jsonb_build_object('baseline',jsonb_build_object('poolC',seed->'temperatureC','heaterState',jsonb_build_object('kind','off_unobserved')),'scheduler',jsonb_build_object('poolC',seed->'temperatureC','heaterState',jsonb_build_object('kind','off_unobserved')));
    ELSE
      parent_month := to_char(to_date(month_key||'-01','YYYY-MM-DD')-interval '1 month','YYYY-MM');
      SELECT checkpoint INTO previous_checkpoint FROM public.energy_roi_pool_checkpoints WHERE home_id=p_home_id AND generation=p_generation AND month=parent_month;
      IF previous_checkpoint IS NULL OR (previous_checkpoint->>'end')::timestamptz IS DISTINCT FROM (p_ledger->>'start')::timestamptz THEN RAISE EXCEPTION 'ROI pool predecessor missing'; END IF;
      parent_hash := previous_checkpoint->>'inputHash'; initial_states := previous_checkpoint->'final';
    END IF;
    IF (p_ledger->'pool')->>'parentHash' IS DISTINCT FROM parent_hash OR (p_ledger->'pool')->'initial' IS DISTINCT FROM initial_states THEN RAISE EXCEPTION 'ROI pool predecessor changed; reload the report'; END IF;
  END IF;
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
  IF coalesce(seed,'null'::jsonb)<>'null'::jsonb THEN
    DELETE FROM public.energy_roi_pool_checkpoints WHERE home_id=p_home_id AND generation=p_generation AND month>=month_key;
    SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO r.months FROM jsonb_each(r.months) WHERE key<=month_key;
    IF (p_ledger->>'coverage')::numeric=1 THEN
      checkpoint_value := (p_ledger->'pool')||jsonb_build_object('month',month_key,'start',p_ledger->>'start','end',p_ledger->>'end','inputHash',p_input_hash);
      INSERT INTO public.energy_roi_pool_checkpoints(home_id,customer_id,generation,month,checkpoint) VALUES(p_home_id,p_customer_id,p_generation,month_key,checkpoint_value);
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


CREATE OR REPLACE FUNCTION public.publish_energy_roi_solar_profile(p_home_id uuid,p_customer_id uuid,p_profile_hash text,p_start timestamptz,p_end timestamptz,p_provenance jsonb,p_hours jsonb)
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
    months=CASE WHEN coalesce(r.model->'roi_pool_seed','null'::jsonb)<>'null'::jsonb THEN '{}'::jsonb ELSE (SELECT coalesce(jsonb_object_agg(key,jsonb_set(jsonb_set(value,'{ledger,solar,profileHash}',to_jsonb(p_profile_hash)),
      '{inputHash}',to_jsonb(encode(sha256(convert_to('roi-solar-profile:' || p_profile_hash || ':' || (value->>'inputHash'),'UTF8')),'hex')))), '{}'::jsonb)
      FROM jsonb_each(r.months) WHERE NOT (
        ((value->'ledger'->>'start')::timestamptz<p_end AND (value->'ledger'->>'end')::timestamptz>p_start)
        OR (old_start IS NOT NULL AND (value->'ledger'->>'start')::timestamptz<old_end AND (value->'ledger'->>'end')::timestamptz>old_start))) END,
    generation=r.generation+1,updated_at=now() WHERE home_id=p_home_id;
  DELETE FROM public.energy_roi_pool_checkpoints WHERE home_id=p_home_id;
  RETURN p_profile_hash;
END $$;
REVOKE ALL ON FUNCTION public.publish_energy_roi_solar_profile(uuid,uuid,text,timestamptz,timestamptz,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_energy_roi_solar_profile(uuid,uuid,text,timestamptz,timestamptz,jsonb,jsonb) TO service_role;

