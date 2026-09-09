-- A home has one replaceable fixed schedule; all mutation and generation races
-- are serialized on its existing operational row.
ALTER TABLE public.energy_optimisation_current
  ADD COLUMN fixed_plan jsonb,
  ADD COLUMN fixed_plan_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN fixed_plan_generation_revision integer NOT NULL DEFAULT 0;

CREATE FUNCTION public.set_fixed_energy_plan(p_home_id uuid, p_expected_revision integer, p_expected_snapshot_id uuid, p_fixed_plan jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE r public.energy_optimisation_current%ROWTYPE; request_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO r FROM public.energy_optimisation_current WHERE home_id = p_home_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No plan for this home'; END IF;
  IF r.fixed_plan_revision <> p_expected_revision OR
     (p_fixed_plan IS NOT NULL AND r.snapshot_id IS DISTINCT FROM p_expected_snapshot_id) THEN
    RAISE EXCEPTION 'The plan changed. Reload before submitting.';
  END IF;
  IF p_fixed_plan IS NOT NULL AND (p_fixed_plan->>'starts_at')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'The start boundary passed. Submit again for the next quarter.';
  END IF;
  UPDATE public.energy_optimisation_current SET
    fixed_plan = p_fixed_plan, fixed_plan_revision = fixed_plan_revision + 1,
    replan_request_id = request_id, replan_requested_at = now(), replan_error = NULL
  WHERE home_id = p_home_id;
  RETURN request_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_fixed_energy_plan(uuid, integer, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_fixed_energy_plan(uuid, integer, uuid, jsonb) TO service_role;

CREATE FUNCTION public.guard_fixed_energy_plan_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.plan IS DISTINCT FROM OLD.plan AND
     NEW.fixed_plan_generation_revision <> OLD.fixed_plan_revision THEN
    RAISE EXCEPTION 'Fixed plan changed during generation. Request fresh measurements.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_fixed_energy_plan_generation BEFORE UPDATE ON public.energy_optimisation_current
FOR EACH ROW EXECUTE FUNCTION public.guard_fixed_energy_plan_generation();
