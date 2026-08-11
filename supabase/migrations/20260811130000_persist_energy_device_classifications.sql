-- Automatic inference initializes each device once. From then on there is one
-- persisted load characteristic and one persisted planning/control choice;
-- later ingestion may improve its evidence without silently changing a user's
-- selected classifications.

UPDATE public.energy_optimisation_devices
SET load_type_override = suggested_load_type
WHERE load_type_override IS NULL;

UPDATE public.energy_optimisation_devices
SET
  planning_role_override = suggested_planning_role,
  control_type_override = suggested_control_type
WHERE planning_role_override IS NULL;

ALTER TABLE public.energy_optimisation_devices
  ALTER COLUMN load_type_override SET NOT NULL,
  ALTER COLUMN planning_role_override SET NOT NULL;

ALTER TABLE public.energy_optimisation_devices
  DROP CONSTRAINT energy_optimisation_devices_planning_override_consistent,
  ADD CONSTRAINT energy_optimisation_devices_planning_override_consistent
    CHECK (
      (planning_role_override = 'base_load' AND control_type_override IS NULL)
      OR
      (planning_role_override = 'controllable' AND control_type_override IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION public.initialise_energy_device_classifications()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.load_type_override IS NULL THEN
    NEW.load_type_override := NEW.suggested_load_type;
  END IF;

  IF NEW.planning_role_override IS NULL THEN
    NEW.planning_role_override := NEW.suggested_planning_role;
    NEW.control_type_override := NEW.suggested_control_type;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.initialise_energy_device_classifications()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER initialise_energy_device_classifications
  BEFORE INSERT ON public.energy_optimisation_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.initialise_energy_device_classifications();

CREATE OR REPLACE FUNCTION public.set_energy_device_load_type(
  p_device_id uuid,
  p_load_type text
)
RETURNS public.energy_optimisation_devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.energy_optimisation_devices;
BEGIN
  IF p_load_type IS NULL OR p_load_type NOT IN (
    'fixed_full_load', 'variable_full_load', 'duty_cycle', 'inverter'
  ) THEN
    RAISE EXCEPTION 'Unsupported load type';
  END IF;

  UPDATE public.energy_optimisation_devices device
  SET load_type_override = p_load_type
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

REVOKE ALL ON FUNCTION public.set_energy_device_load_type(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_energy_device_load_type(uuid, text)
  TO authenticated;

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
    'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint',
    'current_limit'
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
