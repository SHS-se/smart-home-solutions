-- No backfill of intent: inferred roles are not customer decisions.
ALTER TABLE public.energy_optimisation_devices ADD COLUMN planning_choice_at timestamptz;
CREATE TABLE public.energy_optimisation_home_planning (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  battery_present boolean NOT NULL DEFAULT false,
  battery_included boolean NOT NULL DEFAULT true,
  battery_choice_at timestamptz
);
ALTER TABLE public.energy_optimisation_home_planning ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read accessible home planning" ON public.energy_optimisation_home_planning
  FOR SELECT TO authenticated USING (public.can_access_energy_billing_customer(customer_id));
GRANT SELECT ON public.energy_optimisation_home_planning TO authenticated;
GRANT ALL ON public.energy_optimisation_home_planning TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.energy_optimisation_home_planning FROM authenticated, anon;
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
    control_type_override = p_control_type,
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

CREATE FUNCTION public.set_energy_battery_planning(p_home_id uuid, p_included boolean)
RETURNS public.energy_optimisation_home_planning
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result public.energy_optimisation_home_planning;
BEGIN
  IF p_included IS NULL THEN RAISE EXCEPTION 'Choose whether to include the battery'; END IF;
  UPDATE public.energy_optimisation_home_planning AS settings
    SET battery_included = p_included, battery_choice_at = now()
    WHERE settings.home_id = p_home_id AND settings.battery_present
      AND auth.uid() IS NOT NULL
      AND public.can_access_energy_billing_customer(settings.customer_id)
    RETURNING settings.* INTO result;
  IF result.home_id IS NULL THEN RAISE EXCEPTION 'Battery not found or access denied'; END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.set_energy_battery_planning(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_energy_battery_planning(uuid, boolean) TO authenticated;
