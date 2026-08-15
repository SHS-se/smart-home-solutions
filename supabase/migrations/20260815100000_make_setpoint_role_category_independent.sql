-- A user-selected setpoint contract is stronger evidence than the inferred
-- Energy Dashboard category. Heat-capable air conditioners and pool-room
-- heaters must therefore participate in the same room model as devices whose
-- copied meter label happened to classify them as heating.

CREATE OR REPLACE FUNCTION public.get_energy_thermal_training_moments(
  p_customer_id uuid,
  p_home_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  room_key text,
  room_name text,
  active_power_w numeric,
  n bigint,
  n_heated bigint,
  s_pp double precision,
  s_pd double precision,
  s_p double precision,
  s_dd double precision,
  s_d double precision,
  s_py double precision,
  s_dy double precision,
  s_y double precision,
  s_yy double precision,
  s_in double precision,
  s_out double precision,
  s_inin double precision,
  s_outout double precision,
  s_inout double precision
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
      sum(COALESCE(device.active_power_w, 0)) AS active_power_w
    FROM public.energy_optimisation_devices AS device
    WHERE device.home_id = p_home_id
      AND device.customer_id = p_customer_id
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override = 'setpoint'
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = 'setpoint'
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
      AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
    GROUP BY device.mapping_summary ->> 'room_key'
  ),
  room_energy AS (
    SELECT
      device.mapping_summary ->> 'room_key' AS room_key,
      energy.start_ts,
      sum(energy.energy_kwh) AS energy_kwh
    FROM public.energy_optimisation_device_slots AS energy
    JOIN public.energy_optimisation_devices AS device
      ON device.id = energy.device_id
    WHERE energy.home_id = p_home_id
      AND energy.customer_id = p_customer_id
      AND energy.start_ts >= p_from
      AND energy.start_ts < p_to
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override = 'setpoint'
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = 'setpoint'
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
    GROUP BY device.mapping_summary ->> 'room_key', energy.start_ts
  ),
  paired AS (
    SELECT
      slot.room_key,
      slot.room_temperature_c AS t_in,
      outdoor.temperature_c AS t_out,
      COALESCE(energy.energy_kwh, 0) * 4000.0 AS p_w,
      slot.cooling_duty,
      lead(slot.room_temperature_c) OVER w AS t_next,
      lead(slot.start_ts) OVER w AS next_start,
      slot.start_ts
    FROM public.energy_optimisation_thermal_slots AS slot
    JOIN public.energy_optimisation_outdoor_slots AS outdoor
      ON outdoor.home_id = slot.home_id
     AND outdoor.start_ts = slot.start_ts
    LEFT JOIN room_energy AS energy
      ON energy.room_key = slot.room_key
     AND energy.start_ts = slot.start_ts
    WHERE slot.home_id = p_home_id
      AND slot.customer_id = p_customer_id
      AND slot.start_ts >= p_from
      AND slot.start_ts < p_to
    WINDOW w AS (PARTITION BY slot.room_key ORDER BY slot.start_ts)
  ),
  usable AS (
    SELECT
      paired.room_key,
      paired.p_w AS p,
      (paired.t_out - paired.t_in) AS d,
      (paired.t_next - paired.t_in) / 0.25 AS y,
      paired.t_in,
      paired.t_out
    FROM paired
    WHERE paired.t_next IS NOT NULL
      AND paired.next_start = paired.start_ts + interval '15 minutes'
      AND paired.cooling_duty = 0
  )
  SELECT
    usable.room_key,
    room.room_name,
    room.active_power_w,
    count(*) AS n,
    count(*) FILTER (WHERE usable.p > 50) AS n_heated,
    sum(usable.p * usable.p), sum(usable.p * usable.d), sum(usable.p),
    sum(usable.d * usable.d), sum(usable.d),
    sum(usable.p * usable.y), sum(usable.d * usable.y), sum(usable.y),
    sum(usable.y * usable.y),
    sum(usable.t_in), sum(usable.t_out),
    sum(usable.t_in * usable.t_in), sum(usable.t_out * usable.t_out),
    sum(usable.t_in * usable.t_out)
  FROM usable
  JOIN room_devices AS room ON room.room_key = usable.room_key
  GROUP BY usable.room_key, room.room_name, room.active_power_w;
END;
$$;

REVOKE ALL ON FUNCTION public.get_energy_thermal_training_moments(
  uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_thermal_training_moments(
  uuid, uuid, timestamptz, timestamptz
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reconcile_energy_room_comfort_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_room_key text;
  new_room_name text;
BEGIN
  new_room_key := NEW.mapping_summary ->> 'room_key';
  new_room_name := NEW.mapping_summary ->> 'room_name';
  IF NEW.retired_at IS NULL
    AND NEW.planning_role_override = 'controllable'
    AND NEW.control_type_override = 'setpoint'
    AND NEW.mapping_status = 'ready'
    AND NEW.mapped_control_type = 'setpoint'
    AND new_room_key IS NOT NULL AND new_room_key <> ''
    AND new_room_name IS NOT NULL AND new_room_name <> ''
  THEN
    INSERT INTO public.energy_optimisation_comfort_schedules (
      customer_id, home_id, room_key, room_name
    ) VALUES (
      NEW.customer_id, NEW.home_id, new_room_key, new_room_name
    )
    ON CONFLICT (home_id, room_key) DO UPDATE
      SET room_name = EXCLUDED.room_name;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_energy_room_comfort_schedule()
  FROM PUBLIC, anon, authenticated;

-- Backfill rooms previously hidden only by their category without touching the
-- device rows or their last-seen metadata.
INSERT INTO public.energy_optimisation_comfort_schedules (
  customer_id, home_id, room_key, room_name
)
SELECT DISTINCT ON (device.home_id, device.mapping_summary ->> 'room_key')
  device.customer_id,
  device.home_id,
  device.mapping_summary ->> 'room_key',
  device.mapping_summary ->> 'room_name'
FROM public.energy_optimisation_devices AS device
WHERE device.retired_at IS NULL
  AND device.planning_role_override = 'controllable'
  AND device.control_type_override = 'setpoint'
  AND device.mapping_status = 'ready'
  AND device.mapped_control_type = 'setpoint'
  AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
  AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
  AND device.mapping_summary ->> 'room_key' <> ''
  AND device.mapping_summary ->> 'room_name' <> ''
ORDER BY device.home_id, device.mapping_summary ->> 'room_key', device.last_seen_at DESC
ON CONFLICT (home_id, room_key) DO UPDATE
  SET room_name = EXCLUDED.room_name;

CREATE OR REPLACE FUNCTION public.set_energy_room_comfort_schedule(
  p_home_id uuid,
  p_room_key text,
  p_weekday_modes jsonb,
  p_weekend_modes jsonb,
  p_off_temperature_c numeric,
  p_low_temperature_c numeric,
  p_high_temperature_c numeric
)
RETURNS public.energy_optimisation_comfort_schedules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.energy_optimisation_comfort_schedules;
BEGIN
  IF public.energy_comfort_modes_valid(p_weekday_modes) IS NOT TRUE
    OR public.energy_comfort_modes_valid(p_weekend_modes) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'A comfort day must contain 96 valid quarter-hour modes';
  END IF;
  IF p_off_temperature_c NOT BETWEEN 5 AND 30
    OR p_low_temperature_c NOT BETWEEN 5 AND 30
    OR p_high_temperature_c NOT BETWEEN 5 AND 30
    OR p_off_temperature_c > p_low_temperature_c
    OR p_low_temperature_c > p_high_temperature_c
  THEN
    RAISE EXCEPTION 'Comfort temperatures must be ordered values from 5 to 30 C';
  END IF;

  UPDATE public.energy_optimisation_comfort_schedules AS schedule
  SET
    weekday_modes = p_weekday_modes,
    weekend_modes = p_weekend_modes,
    off_temperature_c = p_off_temperature_c,
    low_temperature_c = p_low_temperature_c,
    high_temperature_c = p_high_temperature_c,
    source = 'portal',
    updated_at = now()
  WHERE schedule.home_id = p_home_id
    AND schedule.room_key = p_room_key
    AND auth.uid() IS NOT NULL
    AND public.can_access_energy_billing_customer(schedule.customer_id)
    AND EXISTS (
      SELECT 1
      FROM public.energy_optimisation_devices AS device
      WHERE device.home_id = schedule.home_id
        AND device.retired_at IS NULL
        AND device.planning_role_override = 'controllable'
        AND device.control_type_override = 'setpoint'
        AND device.mapping_status = 'ready'
        AND device.mapped_control_type = 'setpoint'
        AND device.mapping_summary ->> 'room_key' = schedule.room_key
    )
  RETURNING schedule.* INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Room not found or access denied';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_energy_room_comfort_schedule(
  uuid, text, jsonb, jsonb, numeric, numeric, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_energy_room_comfort_schedule(
  uuid, text, jsonb, jsonb, numeric, numeric, numeric
) TO authenticated;
