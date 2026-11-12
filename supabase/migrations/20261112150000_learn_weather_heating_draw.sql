-- Weather observations ride on the existing device quarter. Group at the
-- database boundary so the learner does not pull a year of raw telemetry.
CREATE FUNCTION public.get_energy_weather_heating_days(
  p_home_id uuid, p_customer_id uuid, p_device_key text, p_binding text,
  p_from timestamptz, p_to timestamptz
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(day_band) ORDER BY day, outdoor_c), '[]'::jsonb)
  FROM (
    SELECT (s.start_ts AT TIME ZONE 'UTC')::date AS day,
      avg(o.temperature_c)::double precision AS outdoor_c,
      avg(s.energy_kwh * 4000)::double precision AS watts,
      count(*) * 0.25 AS hours
    FROM public.energy_optimisation_devices d
    JOIN public.energy_optimisation_device_slots s
      ON s.device_id=d.id AND s.home_id=d.home_id AND s.customer_id=d.customer_id
    JOIN public.energy_optimisation_outdoor_slots o
      ON o.home_id=s.home_id AND o.customer_id=s.customer_id AND o.start_ts=s.start_ts
    WHERE d.home_id=p_home_id AND d.customer_id=p_customer_id AND d.device_key=p_device_key
      AND d.retired_at IS NULL AND s.start_ts >= p_from AND s.start_ts < p_to
      AND s.quality->>'weather_heating_binding'=p_binding
      AND s.energy_kwh > 0 AND o.temperature_c IS NOT NULL
    GROUP BY (s.start_ts AT TIME ZONE 'UTC')::date, floor(o.temperature_c)
  ) day_band;
$$;
REVOKE ALL ON FUNCTION public.get_energy_weather_heating_days(uuid,uuid,text,text,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_weather_heating_days(uuid,uuid,text,text,timestamptz,timestamptz)
  TO service_role;

-- An equipment or observation change supersedes the earlier fit through the
-- existing per-device lease and publication fence.
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
