-- Per-zone weekly comfort routines. These are household intent, not a learned
-- device statistic: Home Assistant's old Node-RED clocks seed the values once,
-- then the portal owns them without any runtime Node-RED dependency.

CREATE OR REPLACE FUNCTION public.energy_default_comfort_modes()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_agg(
    CASE
      WHEN (quarter_index >= 20 AND quarter_index < 38)
        OR (quarter_index >= 56 AND quarter_index < 86)
      THEN 'high-temp'
      ELSE 'low-temp'
    END
    ORDER BY quarter_index
  )
  FROM generate_series(0, 95) AS quarter_index;
$$;

CREATE OR REPLACE FUNCTION public.energy_comfort_modes_valid(p_modes jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_modes IS NULL OR jsonb_typeof(p_modes) <> 'array' THEN false
    ELSE jsonb_array_length(p_modes) = 96
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(p_modes) AS mode(value)
        WHERE mode.value NOT IN ('off', 'low-temp', 'high-temp')
      )
  END;
$$;

REVOKE ALL ON FUNCTION public.energy_default_comfort_modes()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.energy_comfort_modes_valid(jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE TABLE public.energy_optimisation_comfort_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.energy_optimisation_devices(id) ON DELETE CASCADE,
  weekday_modes jsonb NOT NULL DEFAULT public.energy_default_comfort_modes(),
  weekend_modes jsonb NOT NULL DEFAULT public.energy_default_comfort_modes(),
  off_temperature_c numeric NOT NULL DEFAULT 12,
  low_temperature_c numeric NOT NULL DEFAULT 17,
  high_temperature_c numeric NOT NULL DEFAULT 21,
  source text NOT NULL DEFAULT 'node_red_seed'
    CHECK (source IN ('node_red_seed', 'portal')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id),
  CONSTRAINT energy_optimisation_comfort_schedule_device_home_consistent
    FOREIGN KEY (device_id, home_id, customer_id)
    REFERENCES public.energy_optimisation_devices(id, home_id, customer_id)
    ON DELETE CASCADE,
  CONSTRAINT energy_optimisation_comfort_schedule_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CONSTRAINT energy_optimisation_comfort_schedule_weekday_valid
    CHECK (public.energy_comfort_modes_valid(weekday_modes)),
  CONSTRAINT energy_optimisation_comfort_schedule_weekend_valid
    CHECK (public.energy_comfort_modes_valid(weekend_modes)),
  CONSTRAINT energy_optimisation_comfort_schedule_temperatures_valid CHECK (
    off_temperature_c BETWEEN 5 AND 30
    AND low_temperature_c BETWEEN 5 AND 30
    AND high_temperature_c BETWEEN 5 AND 30
    AND off_temperature_c <= low_temperature_c
    AND low_temperature_c <= high_temperature_c
  )
);

CREATE INDEX idx_energy_optimisation_comfort_schedules_home
  ON public.energy_optimisation_comfort_schedules (home_id, updated_at DESC);

ALTER TABLE public.energy_optimisation_comfort_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own comfort schedules"
  ON public.energy_optimisation_comfort_schedules FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_optimisation_comfort_schedules
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_optimisation_comfort_schedules TO authenticated;

-- A schedule is created exactly when a website request becomes a setpoint
-- zone. ON CONFLICT preserves a routine if the device is temporarily moved
-- back into base load and later re-enabled.
CREATE OR REPLACE FUNCTION public.ensure_energy_zone_comfort_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  seed_low numeric := 17;
  seed_high numeric := 21;
BEGIN
  IF NEW.planning_role_override = 'controllable'
    AND NEW.control_type_override = 'setpoint'
    AND NEW.category = 'heating'
  THEN
    SELECT slot.comfort_min_c, slot.comfort_max_c
    INTO seed_low, seed_high
    FROM public.energy_optimisation_thermal_slots slot
    WHERE slot.device_id = NEW.id
      AND slot.comfort_min_c BETWEEN 5 AND 30
      AND slot.comfort_max_c BETWEEN 5 AND 30
      AND slot.comfort_min_c <= slot.comfort_max_c
    ORDER BY slot.start_ts DESC
    LIMIT 1;
    seed_low := COALESCE(seed_low, 17);
    seed_high := COALESCE(seed_high, 21);

    INSERT INTO public.energy_optimisation_comfort_schedules (
      customer_id, home_id, device_id,
      off_temperature_c, low_temperature_c, high_temperature_c
    ) VALUES (
      NEW.customer_id, NEW.home_id, NEW.id,
      LEAST(12, seed_low), seed_low, seed_high
    )
    ON CONFLICT (device_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_energy_zone_comfort_schedule()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER ensure_energy_zone_comfort_schedule
  AFTER INSERT OR UPDATE OF category, planning_role_override, control_type_override
  ON public.energy_optimisation_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_energy_zone_comfort_schedule();

-- Prime every existing setpoint zone with the clocks already used in Node-RED.
INSERT INTO public.energy_optimisation_comfort_schedules (
  customer_id, home_id, device_id,
  off_temperature_c, low_temperature_c, high_temperature_c
)
SELECT
  device.customer_id,
  device.home_id,
  device.id,
  LEAST(12, COALESCE(observation.comfort_min_c, 17)),
  COALESCE(observation.comfort_min_c, 17),
  COALESCE(observation.comfort_max_c, 21)
FROM public.energy_optimisation_devices device
LEFT JOIN LATERAL (
  SELECT slot.comfort_min_c, slot.comfort_max_c
  FROM public.energy_optimisation_thermal_slots slot
  WHERE slot.device_id = device.id
    AND slot.comfort_min_c BETWEEN 5 AND 30
    AND slot.comfort_max_c BETWEEN 5 AND 30
    AND slot.comfort_min_c <= slot.comfort_max_c
  ORDER BY slot.start_ts DESC
  LIMIT 1
) observation ON true
WHERE device.planning_role_override = 'controllable'
  AND device.control_type_override = 'setpoint'
  AND device.category = 'heating'
ON CONFLICT (device_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_energy_zone_comfort_schedule(
  p_device_id uuid,
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

  UPDATE public.energy_optimisation_comfort_schedules schedule
  SET
    weekday_modes = p_weekday_modes,
    weekend_modes = p_weekend_modes,
    off_temperature_c = p_off_temperature_c,
    low_temperature_c = p_low_temperature_c,
    high_temperature_c = p_high_temperature_c,
    source = 'portal',
    updated_at = now()
  FROM public.energy_optimisation_devices device
  WHERE schedule.device_id = p_device_id
    AND device.id = schedule.device_id
    AND device.planning_role_override = 'controllable'
    AND device.control_type_override = 'setpoint'
    AND device.category = 'heating'
    AND auth.uid() IS NOT NULL
    AND public.can_access_energy_billing_customer(schedule.customer_id)
  RETURNING schedule.* INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Setpoint zone not found or access denied';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_energy_zone_comfort_schedule(
  uuid, jsonb, jsonb, numeric, numeric, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_energy_zone_comfort_schedule(
  uuid, jsonb, jsonb, numeric, numeric, numeric
) TO authenticated;
