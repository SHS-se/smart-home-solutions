-- A controllable number entity has one website role: variable power. Home
-- Assistant owns whether that entity represents amps, watts or another native
-- number and reports its reviewed bounds in the local mapping.

UPDATE public.energy_optimisation_devices
SET suggested_control_type = 'variable_power'
WHERE suggested_control_type = 'current_limit';

UPDATE public.energy_optimisation_devices
SET control_type_override = 'variable_power'
WHERE control_type_override = 'current_limit';

UPDATE public.energy_optimisation_devices
SET mapped_control_type = 'variable_power'
WHERE mapped_control_type = 'current_limit';

ALTER TABLE public.energy_optimisation_devices
  DROP CONSTRAINT energy_optimisation_devices_suggested_control_type_check,
  DROP CONSTRAINT energy_optimisation_devices_control_type_override_check,
  DROP CONSTRAINT energy_optimisation_devices_mapped_control_type_check,
  ADD CONSTRAINT energy_optimisation_devices_suggested_control_type_check
    CHECK (suggested_control_type IN (
      'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint'
    )),
  ADD CONSTRAINT energy_optimisation_devices_control_type_override_check
    CHECK (control_type_override IN (
      'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint'
    )),
  ADD CONSTRAINT energy_optimisation_devices_mapped_control_type_check
    CHECK (mapped_control_type IN (
      'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint'
    ));

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
  IF p_planning_role = 'base_load' AND p_control_type IS NULL THEN
    NULL;
  ELSIF p_planning_role = 'controllable' AND p_control_type IN (
    'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint'
  ) THEN
    NULL;
  ELSE
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
