-- Portal polling reads three days of device energy and a month of room keys.
-- The existing home/time indexes still visit thousands of heap pages for the
-- selected columns and customer check. Cover those exact reads in the index.
CREATE INDEX idx_energy_device_slots_portal
  ON public.energy_optimisation_device_slots (home_id, start_ts, device_id)
  INCLUDE (customer_id, energy_kwh);
CREATE INDEX idx_energy_thermal_slots_portal
  ON public.energy_optimisation_thermal_slots (home_id, start_ts)
  INCLUDE (customer_id, room_key);
DROP INDEX public.idx_energy_optimisation_device_slots_home_start;
DROP INDEX public.idx_energy_optimisation_thermal_home_start;

-- Build continuity JSON from the leaves upward. Selecting the full plans and
-- slots into each intermediate object only to overwrite them copied megabytes
-- and spilled to temporary files. Keep the canonical row and project on read.
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
      'fixed_plan', 'mode', 'capabilities', 'issued_at', 'valid_until']);
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
                  ARRAY['start', 'binding', 'pool_w', 'battery_command', 'battery_charge_w', 'battery_discharge_w'])
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
