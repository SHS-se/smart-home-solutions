-- Status polling needs identifiers and acknowledgement metadata, never the
-- snapshot or executable schedules. SECURITY INVOKER preserves the same RLS
-- checks as the caller's previous direct SELECT from the current-plan table.
CREATE FUNCTION public.get_energy_fixed_plan_status(p_home_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'fixed_plan', CASE WHEN fixed_plan IS NOT NULL AND fixed_plan <> 'null'::jsonb
      THEN jsonb_build_object('id', fixed_plan->'id',
        'starts_at', fixed_plan->'starts_at', 'ends_at', fixed_plan->'ends_at')
      ELSE NULL END,
    'revision', fixed_plan_revision,
    'generated_revision', fixed_plan_generation_revision,
    'generated_fixed_plan_id', plan->'fixed_plan'->'id',
    'ha_ack_status', ha_ack_status,
    'ha_ack_error', ha_ack_error,
    'valid_until', valid_until,
    'error', replan_error,
    'pending', replan_request_id IS DISTINCT FROM replan_completed_request_id
  ) FROM public.energy_optimisation_current WHERE home_id = p_home_id;
$$;
REVOKE ALL ON FUNCTION public.get_energy_fixed_plan_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_fixed_plan_status(uuid) TO authenticated, service_role;

-- The planner previously downloaded every reading from six hours and kept
-- only the first per room. Do that reduction beside the existing index on
-- (home_id, room_key, start_ts DESC), retaining the identical freshness cutoff.
CREATE FUNCTION public.get_energy_latest_room_temperatures(
  p_customer_id uuid, p_home_id uuid, p_from timestamptz
)
RETURNS TABLE(room_key text, room_temperature_c numeric, start_ts timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT DISTINCT ON (slot.room_key)
    slot.room_key, slot.room_temperature_c, slot.start_ts
  FROM public.energy_optimisation_thermal_slots slot
  WHERE slot.customer_id = p_customer_id AND slot.home_id = p_home_id
    AND slot.start_ts >= p_from
  ORDER BY slot.room_key, slot.start_ts DESC;
$$;
REVOKE ALL ON FUNCTION public.get_energy_latest_room_temperatures(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_latest_room_temperatures(uuid, uuid, timestamptz)
  TO service_role;
