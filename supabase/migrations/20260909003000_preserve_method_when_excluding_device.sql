-- Inclusion and the selected method are independent. No existing rows change.
ALTER TABLE public.energy_optimisation_devices
  DROP CONSTRAINT energy_optimisation_devices_planning_override_consistent,
  ADD CONSTRAINT energy_optimisation_devices_planning_override_consistent
    CHECK (planning_role_override = 'base_load' OR control_type_override IS NOT NULL);

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
  IF p_planning_role = 'base_load' AND (p_control_type IS NULL OR p_control_type IN (
    'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint'
  )) THEN
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
    control_type_override = COALESCE(p_control_type, device.control_type_override),
    planning_choice_at = now()
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

