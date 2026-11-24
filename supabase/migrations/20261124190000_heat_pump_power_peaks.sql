-- The highest power reading of a heat pump in each native heating interval.
-- User requirement, 24 November 2026: a heat pump's start-up peak, several
-- times its running power on a cold day, must be learned so starts can be
-- planned within the house limit. Home Assistant sends the peak beside the interval's
-- energy in the heating history; it is stored apart from the room evidence so
-- it never advances a room's learning clock.
CREATE TABLE private.energy_heating_power_peaks (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  device_key text NOT NULL CHECK (length(device_key) > 0),
  start_ts timestamptz NOT NULL,
  duration_s integer NOT NULL CHECK (duration_s IN (900, 3600)),
  peak_w double precision NOT NULL CHECK (peak_w >= 0 AND peak_w < 1000000),
  PRIMARY KEY (home_id, device_key, start_ts, duration_s),
  CHECK (mod(extract(epoch FROM start_ts)::numeric, duration_s) = 0)
);
ALTER TABLE private.energy_heating_power_peaks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_heating_power_peaks FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_energy_heating_power_peaks(p_home_id uuid, p_customer_id uuid, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
DECLARE written integer;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Peaks must be an array'; END IF;
  INSERT INTO private.energy_heating_power_peaks (home_id, customer_id, device_key, start_ts, duration_s, peak_w)
  SELECT p_home_id, p_customer_id, r.device_key, r.start, r.duration_s, r.peak_w
  FROM jsonb_to_recordset(p_rows) AS r(device_key text, start timestamptz, duration_s integer, peak_w double precision)
  WHERE r.duration_s IN (900, 3600) AND r.peak_w >= 0 AND r.peak_w < 1000000
    AND mod(extract(epoch FROM r.start)::numeric, r.duration_s) = 0
    AND EXISTS (SELECT FROM public.energy_optimisation_devices d WHERE d.home_id = p_home_id
      AND d.customer_id = p_customer_id AND d.device_key = r.device_key AND d.retired_at IS NULL)
  ON CONFLICT (home_id, device_key, start_ts, duration_s) DO UPDATE SET peak_w = EXCLUDED.peak_w
    WHERE energy_heating_power_peaks.peak_w IS DISTINCT FROM EXCLUDED.peak_w;
  GET DIAGNOSTICS written = ROW_COUNT;
  DELETE FROM private.energy_heating_power_peaks WHERE ctid IN (
    SELECT ctid FROM private.energy_heating_power_peaks WHERE home_id = p_home_id
      AND start_ts < now() - interval '400 days' ORDER BY start_ts LIMIT 1000 FOR UPDATE SKIP LOCKED);
  RETURN written;
END;
$$;
REVOKE ALL ON FUNCTION public.record_energy_heating_power_peaks(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_energy_heating_power_peaks(uuid, uuid, jsonb) TO service_role;

-- One device's native intervals for its start-up model: energy and outdoor
-- temperature from the room evidence, and the peak where one was sent. A
-- reviewed unreliable meter period is left out, as for the heating draw.
-- NULL when the device is not a heat pump: a heating device set up as an
-- inverter load.
CREATE FUNCTION public.get_energy_heat_pump_intervals(
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
