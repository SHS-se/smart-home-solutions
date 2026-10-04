-- Device-specific transient response; learned pool coefficients remain separate.
ALTER TABLE public.energy_optimisation_pool_model
  ADD COLUMN IF NOT EXISTS heater_response jsonb;
COMMENT ON COLUMN public.energy_optimisation_pool_model.heater_response IS
  'Explicit device response (steady or bergvarme startup electricity/heat curves), configured per home; preserved by thermal-model refits.';

-- Carry executable heater commands into continuity, including zero-draw startup.
CREATE OR REPLACE FUNCTION public.get_energy_replan_state(p_home_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_fixed jsonb;
  v_revision integer;
  v_plan jsonb;
  v_plans jsonb;
  v_priority jsonb;
  v_slots jsonb;
  v_previous jsonb;
BEGIN
  SELECT fixed_plan, fixed_plan_revision, plan
  INTO v_fixed, v_revision, v_plan
  FROM public.energy_optimisation_current WHERE home_id = p_home_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_previous := v_plan;
  IF jsonb_typeof(v_plan) = 'object' THEN
    -- Expand the toasted value once before repeated key lookups.
    v_plan := v_plan || '{}'::jsonb;
    v_previous := public.energy_replan_pick(v_plan, ARRAY['status', 'schema_version', 'plan_id',
      'fixed_plan', 'mode', 'capabilities', 'issued_at', 'valid_until', 'pool']);
    IF v_plan ? 'plans' THEN
      v_plans := v_plan->'plans';
      IF jsonb_typeof(v_plans) = 'object' THEN
        v_plans := public.energy_replan_pick(v_plans, ARRAY['priority']);
        IF v_plans ? 'priority' THEN
          v_priority := v_plans->'priority';
          IF jsonb_typeof(v_priority) = 'object' THEN
            v_slots := v_priority->'slots';
            v_priority := public.energy_replan_pick(v_priority, ARRAY['status', 'dispatched_devices']);
            IF v_slots IS NOT NULL THEN
              IF jsonb_typeof(v_slots) = 'array' THEN
                SELECT COALESCE(jsonb_agg(public.energy_replan_pick(value,
                  ARRAY['start', 'binding', 'pool_w', 'pool_command_w', 'battery_command', 'battery_charge_w', 'battery_discharge_w'])
                  ORDER BY ordinal), '[]'::jsonb)
                INTO v_slots
                FROM jsonb_array_elements(v_slots) WITH ORDINALITY AS slots(value, ordinal);
              END IF;
              v_priority := v_priority || jsonb_build_object('slots', v_slots);
            END IF;
          END IF;
          v_plans := jsonb_build_object('priority', v_priority);
        END IF;
      END IF;
      v_previous := v_previous || jsonb_build_object('plans', v_plans);
    END IF;
  END IF;
  RETURN jsonb_build_object('fixed_plan', v_fixed, 'fixed_plan_revision', v_revision,
    'previous_plan', v_previous);
END;
$$;
