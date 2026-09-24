-- Bind the raw HTTP body directly as JSONB. A named parameter makes PostgREST
-- build a second multi-megabyte record with json_to_record before calling us.
-- Both that outer record and a set-returning inner conversion spill to disk.
-- A single unnamed argument and a PL/pgSQL row avoid both materializations.
DROP FUNCTION public.store_energy_optimisation_current(jsonb);
CREATE FUNCTION public.store_energy_optimisation_current(jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE r public.energy_optimisation_current%ROWTYPE;
BEGIN
  r := jsonb_populate_record(NULL::public.energy_optimisation_current, $1);
  INSERT INTO public.energy_optimisation_current (
    fixed_plan_generation_revision,
    replan_error,
    home_id,
    customer_id,
    snapshot_id,
    plan_id,
    generation_request_id,
    plan_schema_version,
    ha_ack_status,
    ha_acknowledged_at,
    ha_integration_version,
    ha_ack_request_id,
    ha_ack_error,
    input_hash,
    captured_at,
    issued_at,
    valid_until,
    binding_until,
    status,
    model_version,
    snapshot,
    plan,
    battery_projection,
    updated_at
  )
  VALUES (
    r.fixed_plan_generation_revision,
    r.replan_error,
    r.home_id,
    r.customer_id,
    r.snapshot_id,
    r.plan_id,
    r.generation_request_id,
    r.plan_schema_version,
    r.ha_ack_status,
    r.ha_acknowledged_at,
    r.ha_integration_version,
    r.ha_ack_request_id,
    r.ha_ack_error,
    r.input_hash,
    r.captured_at,
    r.issued_at,
    r.valid_until,
    r.binding_until,
    r.status,
    r.model_version,
    r.snapshot,
    r.plan,
    r.battery_projection,
    r.updated_at
  )
  ON CONFLICT (home_id) DO UPDATE SET
    fixed_plan_generation_revision = EXCLUDED.fixed_plan_generation_revision,
    replan_error = EXCLUDED.replan_error,
    customer_id = EXCLUDED.customer_id,
    snapshot_id = EXCLUDED.snapshot_id,
    plan_id = EXCLUDED.plan_id,
    generation_request_id = EXCLUDED.generation_request_id,
    plan_schema_version = EXCLUDED.plan_schema_version,
    ha_ack_status = EXCLUDED.ha_ack_status,
    ha_acknowledged_at = EXCLUDED.ha_acknowledged_at,
    ha_integration_version = EXCLUDED.ha_integration_version,
    ha_ack_request_id = EXCLUDED.ha_ack_request_id,
    ha_ack_error = EXCLUDED.ha_ack_error,
    input_hash = EXCLUDED.input_hash,
    captured_at = EXCLUDED.captured_at,
    issued_at = EXCLUDED.issued_at,
    valid_until = EXCLUDED.valid_until,
    binding_until = EXCLUDED.binding_until,
    status = EXCLUDED.status,
    model_version = EXCLUDED.model_version,
    snapshot = EXCLUDED.snapshot,
    plan = EXCLUDED.plan,
    battery_projection = EXCLUDED.battery_projection,
    updated_at = EXCLUDED.updated_at;
END;
$$;
REVOKE ALL ON FUNCTION public.store_energy_optimisation_current(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_energy_optimisation_current(jsonb) TO service_role;

-- Runtime heartbeats and acknowledgements never change the plan. They must not
-- detoast and compare it while holding the home's operational row lock.
CREATE OR REPLACE FUNCTION public.guard_fixed_energy_plan_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.fixed_plan_generation_revision <> OLD.fixed_plan_revision THEN
    IF NEW.plan IS DISTINCT FROM OLD.plan THEN
      RAISE EXCEPTION 'Fixed plan changed during generation. Request fresh measurements.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER guard_fixed_energy_plan_generation ON public.energy_optimisation_current;
CREATE TRIGGER guard_fixed_energy_plan_generation
BEFORE UPDATE OF plan, fixed_plan_generation_revision ON public.energy_optimisation_current
FOR EACH ROW EXECUTE FUNCTION public.guard_fixed_energy_plan_generation();

-- Visit requested keys instead of materializing every diagnostic field.
CREATE OR REPLACE FUNCTION public.energy_replan_pick(p_object jsonb, p_keys text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN jsonb_typeof(p_object) = 'object' THEN
    COALESCE((SELECT jsonb_object_agg(key, p_object->key)
      FROM (SELECT DISTINCT unnest(p_keys) AS key) keys
      WHERE p_object ? key), '{}'::jsonb)
    ELSE p_object END;
$$;
