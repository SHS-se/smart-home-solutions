-- Carry the daily permission ledger and exact battery eligibility across replans.
CREATE OR REPLACE FUNCTION public.get_energy_replan_state(p_home_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE c public.energy_optimisation_current%ROWTYPE; reference jsonb;
BEGIN
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=p_home_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF c.plan->>'status'='ready' THEN
    SELECT jsonb_build_object('plan_id',c.plan_id,'hot_water_permissions',c.plan->'hot_water_permissions','slots',COALESCE(jsonb_agg(jsonb_build_object(
      'start',value->'start','pool_w',value->'pool_w','pool_command_w',value->'pool_command_w',
      'ev_target_current_a',value->'ev_target_current_a','ev_min_current_a',value->'ev_min_current_a','ev_max_current_a',value->'ev_max_current_a',
      'boiler_battery_allowed',value->'boiler_battery_allowed','boiler_permitted',value->'boiler_permitted','boiler_expected_w',value->'boiler_expected_w',
      'battery_command',value->'battery_command','device_commands',value->'device_commands') ORDER BY ordinal),'[]'::jsonb))
      INTO reference FROM jsonb_array_elements(c.plan->'plans'->'priority'->'slots') WITH ORDINALITY AS slots(value,ordinal);
  END IF;
  RETURN jsonb_build_object('fixed_plan',c.fixed_plan,'fixed_plan_revision',c.fixed_plan_revision,
    'reference_plan_id',c.plan_id,'published_commands',reference);
END; $$;
