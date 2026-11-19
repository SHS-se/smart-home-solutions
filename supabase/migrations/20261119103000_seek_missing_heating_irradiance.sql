-- Thermal evidence revisions do not invalidate already observed solar coverage.
-- Seek one bounded gap in the current, source-qualified observation set. The
-- optional cursor gives later gaps a turn when a provider cannot fill an hour.
CREATE INDEX energy_heating_observations_missing_solar
 ON public.energy_heating_observations(home_id,room_key,start_ts) WHERE solar_w_per_m2 IS NULL;

CREATE FUNCTION public.get_energy_room_missing_irradiance_window(
 p_home_id uuid,p_customer_id uuid,p_room_key text,p_binding text,
 p_from timestamptz,p_to timestamptz,p_after timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,private SET work_mem='32MB' AS $$
DECLARE first_at timestamptz; last_at timestamptz;
BEGIN
 IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 IF NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(p_home_id) c
   WHERE c.room_key=p_room_key AND c.binding=p_binding) THEN RAISE EXCEPTION 'Heating source changed'; END IF;
 SELECT n.start_ts INTO first_at
 FROM energy_heating_observations n, private.energy_heating_observation_sources(p_home_id) s
 WHERE n.home_id=p_home_id AND n.customer_id=p_customer_id AND n.room_key=p_room_key
   AND n.solar_w_per_m2 IS NULL AND s.room_key=n.room_key
   AND n.start_ts>=greatest(p_from,coalesce(p_after,p_from)) AND n.start_ts<p_to
   AND n.start_ts+make_interval(secs=>n.duration_s)<=p_to
   AND private.energy_heating_source_matches(p_home_id,n.room_key,n.source_key,n.device_statistics,
     s.source_key,s.device_statistics,n.start_ts,n.duration_s)
 ORDER BY n.start_ts LIMIT 1;
 IF first_at IS NULL AND p_after IS NOT NULL THEN
   RETURN public.get_energy_room_missing_irradiance_window(p_home_id,p_customer_id,p_room_key,p_binding,p_from,p_to,NULL);
 END IF;
 IF first_at IS NULL THEN RETURN NULL; END IF;
 -- Provider values are preceding-hour means. Start at an hour boundary so
 -- quarter-resolution holes do not cross the bounded request's left edge.
 first_at:=date_trunc('hour',first_at);
 SELECT max(n.start_ts+make_interval(secs=>n.duration_s)) INTO last_at
 FROM energy_heating_observations n, private.energy_heating_observation_sources(p_home_id) s
 WHERE n.home_id=p_home_id AND n.customer_id=p_customer_id AND n.room_key=p_room_key
   AND n.solar_w_per_m2 IS NULL AND s.room_key=n.room_key
   AND n.start_ts>=greatest(p_from,first_at) AND n.start_ts<least(p_to,first_at+interval '31 days')
   AND n.start_ts+make_interval(secs=>n.duration_s)<=least(p_to,first_at+interval '31 days')
   AND private.energy_heating_source_matches(p_home_id,n.room_key,n.source_key,n.device_statistics,
     s.source_key,s.device_statistics,n.start_ts,n.duration_s);
 RETURN jsonb_build_object('from_at',first_at,'to_at',last_at);
END;
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_missing_irradiance_window(uuid,uuid,text,text,timestamptz,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_missing_irradiance_window(uuid,uuid,text,text,timestamptz,timestamptz,timestamptz) TO service_role;
