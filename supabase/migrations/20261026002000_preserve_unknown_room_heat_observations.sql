-- Recorder temperatures are quarter means. Unknown or partial heater energy
-- cannot be fitted as measured OFF; retain the observation with a null input.
CREATE OR REPLACE FUNCTION public.get_energy_thermal_training_quarters(
  p_customer_id uuid,
  p_home_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  room_key text,
  room_name text,
  active_power_w double precision,
  start_ts timestamptz,
  room_temperature_c double precision,
  cooling boolean,
  outdoor_temperature_c double precision,
  solar_w_per_m2 double precision,
  house_temperature_c double precision,
  heat_w double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
    AND (NOT public.can_access_energy_billing_customer(p_customer_id)
      OR NOT public.energy_home_matches_customer(p_home_id, p_customer_id))
  THEN
    RAISE EXCEPTION 'Home not found or access denied';
  END IF;

  RETURN QUERY
  WITH room_devices AS (
    SELECT
      device.mapping_summary ->> 'room_key' AS room_key,
      max(device.mapping_summary ->> 'room_name') AS room_name,
      sum(COALESCE(device.active_power_w, 0)) AS active_power_w,
      count(*) AS required_device_count
    FROM public.energy_optimisation_devices AS device
    WHERE device.home_id = p_home_id
      AND device.customer_id = p_customer_id
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override IN ('setpoint', 'switch_schedule')
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = device.control_type_override
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
      AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
    GROUP BY device.mapping_summary ->> 'room_key'
  ),
  room_energy AS (
    SELECT
      device.mapping_summary ->> 'room_key' AS room_key,
      energy.start_ts,
      sum(energy.energy_kwh) AS energy_kwh,
      count(DISTINCT device.id) FILTER (WHERE energy.energy_kwh IS NOT NULL) AS observed_device_count
    FROM public.energy_optimisation_device_slots AS energy
    JOIN public.energy_optimisation_devices AS device
      ON device.id = energy.device_id
    WHERE energy.home_id = p_home_id
      AND energy.customer_id = p_customer_id
      AND energy.start_ts >= p_from
      AND energy.start_ts < p_to
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override IN ('setpoint', 'switch_schedule')
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = device.control_type_override
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
      AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
    GROUP BY device.mapping_summary ->> 'room_key', energy.start_ts
  )
  SELECT
    slot.room_key,
    room.room_name,
    room.active_power_w::double precision,
    slot.start_ts,
    slot.room_temperature_c::double precision,
    slot.cooling_duty > 0,
    outdoor.temperature_c::double precision,
    outdoor.solar_w_per_m2::double precision,
    house.temperature_c::double precision,
    (CASE WHEN energy.observed_device_count = room.required_device_count
      THEN energy.energy_kwh * 4000.0 ELSE NULL END)::double precision
  FROM public.energy_optimisation_thermal_slots AS slot
  JOIN room_devices AS room ON room.room_key = slot.room_key
  LEFT JOIN public.energy_optimisation_outdoor_slots AS outdoor
    ON outdoor.home_id = slot.home_id AND outdoor.start_ts = slot.start_ts
  LEFT JOIN public.energy_optimisation_house_slots AS house
    ON house.home_id = slot.home_id AND house.start_ts = slot.start_ts
  LEFT JOIN room_energy AS energy
    ON energy.room_key = slot.room_key AND energy.start_ts = slot.start_ts
  WHERE slot.home_id = p_home_id
    AND slot.customer_id = p_customer_id
    AND slot.start_ts >= p_from
    AND slot.start_ts < p_to
  ORDER BY slot.room_key, slot.start_ts;
END;
$$;

REVOKE ALL ON FUNCTION public.get_energy_thermal_training_quarters(
  uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_thermal_training_quarters(
  uuid, uuid, timestamptz, timestamptz
) TO authenticated, service_role;
