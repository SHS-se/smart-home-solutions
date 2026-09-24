-- Large plans must enter PostgreSQL as JSONB once. The generic PostgREST
-- table upsert converts a multi-megabyte JSON request into many typed columns
-- and can exceed the API statement timeout. Keep the same atomic upsert,
-- constraints and triggers, with an explicit allowlist of publication fields.
CREATE FUNCTION public.store_energy_optimisation_current(p_row jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
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
  SELECT
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
  FROM jsonb_populate_record(NULL::public.energy_optimisation_current, p_row) AS r
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
