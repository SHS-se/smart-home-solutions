-- Project the canonical row at read time: no duplicated continuity state to
-- synchronize with plan writers. Eligibility and time selection remain in TS.
CREATE FUNCTION public.energy_replan_pick(p_object jsonb, p_keys text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN jsonb_typeof(p_object) = 'object' THEN
    COALESCE((SELECT jsonb_object_agg(key, value)
      FROM jsonb_each(p_object) WHERE key = ANY(p_keys)), '{}'::jsonb)
    ELSE p_object END;
$$;
REVOKE ALL ON FUNCTION public.energy_replan_pick(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.energy_replan_pick(jsonb, text[]) TO service_role;

CREATE FUNCTION public.get_energy_replan_state(p_home_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'fixed_plan', fixed_plan,
    'fixed_plan_revision', fixed_plan_revision,
    'previous_plan', CASE WHEN jsonb_typeof(plan) = 'object' THEN
      public.energy_replan_pick(plan, ARRAY['status', 'schema_version', 'plan_id',
        'fixed_plan', 'mode', 'capabilities', 'issued_at', 'valid_until', 'plans'])
      || CASE WHEN jsonb_typeof(plan->'plans') = 'object' THEN
        jsonb_build_object('plans', public.energy_replan_pick(plan->'plans', ARRAY['priority'])
          || CASE WHEN jsonb_typeof(plan#>'{plans,priority}') = 'object' THEN
            jsonb_build_object('priority',
              public.energy_replan_pick(plan#>'{plans,priority}', ARRAY['status', 'dispatched_devices', 'slots'])
              || CASE WHEN jsonb_typeof(plan#>'{plans,priority,slots}') = 'array' THEN
                jsonb_build_object('slots', COALESCE((
                  SELECT jsonb_agg(public.energy_replan_pick(value,
                    ARRAY['start', 'binding', 'pool_w', 'battery_command', 'battery_charge_w', 'battery_discharge_w'])
                    ORDER BY ordinal)
                  FROM jsonb_array_elements(plan#>'{plans,priority,slots}') WITH ORDINALITY AS slots(value, ordinal)
                ), '[]'::jsonb))
                ELSE '{}'::jsonb END)
            ELSE '{}'::jsonb END)
        ELSE '{}'::jsonb END
      ELSE plan END
  ) FROM public.energy_optimisation_current WHERE home_id = p_home_id;
$$;
REVOKE ALL ON FUNCTION public.get_energy_replan_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_replan_state(uuid) TO service_role;
