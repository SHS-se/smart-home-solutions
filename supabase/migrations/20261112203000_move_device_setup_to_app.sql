-- Keep the existing effective columns for the planner and model history.
ALTER TABLE public.energy_optimisation_devices
  ADD COLUMN app_setup jsonb,
  DROP CONSTRAINT energy_optimisation_devices_planning_override_consistent,
  ADD CONSTRAINT energy_optimisation_devices_planning_override_consistent
    CHECK (planning_role_override = 'base_load' OR control_type_override IS NOT NULL OR app_setup IS NOT NULL);

CREATE FUNCTION public.sync_energy_app_device_setup() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.app_setup IS NOT NULL THEN
    IF NEW.app_setup IS NULL THEN
      -- Inventory from an older app still reports observations and mappings.
      NEW.app_setup := OLD.app_setup;
    ELSIF (NEW.app_setup->>'revision')::bigint < (OLD.app_setup->>'revision')::bigint
       OR ((NEW.app_setup->>'revision')::bigint = (OLD.app_setup->>'revision')::bigint
           AND NEW.app_setup IS DISTINCT FROM OLD.app_setup) THEN
      -- A replay must preserve the choices and their matching mapping report.
      RETURN OLD;
    END IF;
  END IF;
  IF NEW.app_setup IS NOT NULL THEN
    NEW.control_type_override := NEW.app_setup->>'control_type';
    NEW.load_type_override := NEW.app_setup->>'load_type';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_energy_app_device_setup() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER sync_energy_app_device_setup
  BEFORE INSERT OR UPDATE OF app_setup ON public.energy_optimisation_devices
  FOR EACH ROW EXECUTE FUNCTION public.sync_energy_app_device_setup();

-- Website writes can still choose participation and retain the synced method.
CREATE FUNCTION public.set_energy_device_participation(p_device_id uuid, p_planning_role text)
RETURNS public.energy_optimisation_devices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result public.energy_optimisation_devices;
BEGIN
  IF p_planning_role IS NULL OR p_planning_role NOT IN ('base_load', 'controllable') THEN
    RAISE EXCEPTION 'Unsupported planning role';
  END IF;
  UPDATE public.energy_optimisation_devices device
  SET planning_role_override = p_planning_role, planning_choice_at = now()
  WHERE device.id = p_device_id
    AND auth.uid() IS NOT NULL
    AND public.can_access_energy_billing_customer(device.customer_id)
    AND (p_planning_role = 'base_load' OR device.control_type_override IS NOT NULL)
  RETURNING device.* INTO result;
  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Could not change planning participation. Choose a control method in the SHS app first.';
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.set_energy_device_participation(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_energy_device_participation(uuid, text) TO authenticated;

DROP FUNCTION public.set_energy_device_planning(uuid, text, text);
DROP FUNCTION public.set_energy_device_load_type(uuid, text);
