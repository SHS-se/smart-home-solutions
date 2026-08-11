-- Separate an appliance's electrical load shape from the way the planner may
-- control it. Devices in the base-load role remain learned from Home Assistant
-- history, but only controllable devices are removed from the empirical base
-- profile and published as individual planner series.

ALTER TABLE public.energy_optimisation_devices
  ADD COLUMN suggested_planning_role text NOT NULL DEFAULT 'base_load'
    CHECK (suggested_planning_role IN ('base_load', 'controllable')),
  ADD COLUMN planning_role_override text
    CHECK (planning_role_override IN ('base_load', 'controllable')),
  ADD COLUMN suggested_control_type text
    CHECK (suggested_control_type IN (
      'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint',
      'current_limit'
    )),
  ADD COLUMN control_type_override text
    CHECK (control_type_override IN (
      'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint',
      'current_limit'
    )),
  ADD CONSTRAINT energy_optimisation_devices_suggested_planning_consistent
    CHECK (
      (suggested_planning_role = 'base_load' AND suggested_control_type IS NULL)
      OR
      (suggested_planning_role = 'controllable' AND suggested_control_type IS NOT NULL)
    ),
  ADD CONSTRAINT energy_optimisation_devices_planning_override_consistent
    CHECK (
      CASE
        WHEN planning_role_override IS NULL THEN control_type_override IS NULL
        WHEN planning_role_override = 'base_load' THEN control_type_override IS NULL
        WHEN planning_role_override = 'controllable' THEN control_type_override IS NOT NULL
        ELSE false
      END
    );

CREATE OR REPLACE FUNCTION public.set_energy_device_planning(
  p_device_id uuid,
  p_planning_role text,
  p_control_type text
)
RETURNS public.energy_optimisation_devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.energy_optimisation_devices;
BEGIN
  IF p_planning_role IS NULL AND p_control_type IS NOT NULL THEN
    RAISE EXCEPTION 'Unsupported planning role or control type';
  ELSIF p_planning_role = 'base_load' AND p_control_type IS NOT NULL THEN
    RAISE EXCEPTION 'Unsupported planning role or control type';
  ELSIF p_planning_role = 'controllable' AND (
    p_control_type IS NULL OR p_control_type NOT IN (
      'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint',
      'current_limit'
    )
  ) THEN
    RAISE EXCEPTION 'Unsupported planning role or control type';
  ELSIF p_planning_role IS NOT NULL
    AND p_planning_role NOT IN ('base_load', 'controllable')
  THEN
    RAISE EXCEPTION 'Unsupported planning role or control type';
  END IF;

  UPDATE public.energy_optimisation_devices device
  SET
    planning_role_override = p_planning_role,
    control_type_override = p_control_type
  WHERE device.id = p_device_id
    AND auth.uid() IS NOT NULL
    AND public.can_access_energy_billing_customer(device.customer_id)
  RETURNING device.* INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Device not found or access denied';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_energy_device_planning(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_energy_device_planning(uuid, text, text)
  TO authenticated;
