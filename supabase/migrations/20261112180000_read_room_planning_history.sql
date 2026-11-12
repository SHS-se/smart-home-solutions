-- Read temperature coverage and complete heater energy independently so a
-- missing temperature row cannot be mistaken for missing meter data.
CREATE FUNCTION public.get_energy_room_planning_history(
  p_customer_id uuid, p_home_id uuid, p_room_keys text[],
  p_from timestamptz, p_to timestamptz
) RETURNS TABLE (room_key text, temperature_starts jsonb, heater_quarters jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH room_devices AS (
    SELECT device.id, device.mapping_summary ->> 'room_key' AS room_key
    FROM public.energy_optimisation_devices AS device
    WHERE device.home_id = p_home_id AND device.customer_id = p_customer_id
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override IN ('setpoint', 'switch_schedule')
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = device.control_type_override
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
      AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
      AND device.mapping_summary ->> 'room_key' = ANY(p_room_keys)
  ), rooms AS (
    SELECT device.room_key, count(*) AS heater_count
    FROM room_devices AS device GROUP BY device.room_key
  ), temperature AS (
    SELECT slot.room_key, jsonb_agg(extract(epoch FROM slot.start_ts) * 1000 ORDER BY slot.start_ts) AS starts
    FROM public.energy_optimisation_thermal_slots AS slot
    JOIN rooms ON rooms.room_key = slot.room_key
    WHERE slot.home_id = p_home_id AND slot.customer_id = p_customer_id
      AND slot.start_ts >= p_from AND slot.start_ts < p_to
    GROUP BY slot.room_key
  ), heater AS (
    SELECT device.room_key, slot.start_ts, sum(slot.energy_kwh) * 4000 AS watts
    FROM public.energy_optimisation_device_slots AS slot
    JOIN room_devices AS device ON device.id = slot.device_id
    JOIN rooms ON rooms.room_key = device.room_key
    WHERE slot.home_id = p_home_id AND slot.customer_id = p_customer_id
      AND slot.start_ts >= p_from AND slot.start_ts < p_to
    GROUP BY device.room_key, slot.start_ts, rooms.heater_count
    HAVING count(slot.energy_kwh) = rooms.heater_count
  ), heating AS (
    SELECT heater.room_key, jsonb_agg(jsonb_build_array(extract(epoch FROM heater.start_ts) * 1000, heater.watts)
      ORDER BY heater.start_ts) AS quarters
    FROM heater GROUP BY heater.room_key
  )
  SELECT rooms.room_key, COALESCE(temperature.starts, '[]'::jsonb), COALESCE(heating.quarters, '[]'::jsonb)
  FROM rooms
  LEFT JOIN temperature USING (room_key)
  LEFT JOIN heating USING (room_key)
  ORDER BY rooms.room_key;
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_planning_history(uuid,uuid,text[],timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_planning_history(uuid,uuid,text[],timestamptz,timestamptz)
  TO service_role;
