-- Accepted instructions retain their equipment contract, independently of live store readings.
CREATE OR REPLACE FUNCTION private.energy_command_reference(p_plan jsonb,p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT jsonb_build_object('plan_id',p_plan->'plan_id',
    'pool_planning_basis',COALESCE(p_plan->'pool'->'planning_basis',
      CASE WHEN jsonb_typeof(p_plan->'retained_pool_stop_temperature_c')='number' THEN '"empirical"'::jsonb END),
    'pool_stop_temperature_c',COALESCE(NULLIF(p_plan->'pool'->'stop_temperature_c','null'::jsonb),p_plan->'retained_pool_stop_temperature_c'),
    'ev_charger',COALESCE((SELECT (service->'control')-'type'
      FROM jsonb_array_elements(COALESCE(p_plan->'services','[]'::jsonb)) AS services(service)
      WHERE service->>'device'='ev' AND service->'control'->>'type'='discrete_current' LIMIT 1),p_plan->'retained_ev_charger'),
    'operating_scope',p_snapshot->'operating_scope','execution_availability',p_snapshot->'execution_availability',
    'hot_water_permissions',p_plan->'hot_water_permissions',
    'battery_contract',CASE WHEN p_plan->'battery_execution'->>'id' IS NOT NULL THEN jsonb_build_object(
      'id',p_plan->'battery_execution'->'id','scope_revision',p_plan->'battery_execution'->'scope_revision',
      'generation',p_plan->'battery_execution'->'generation') ELSE NULL END,
    'slots',COALESCE(jsonb_agg(jsonb_build_object(
      'start',value->'start','pool_w',value->'pool_w','pool_command_w',value->'pool_command_w','pool_permitted',value->'pool_permitted',
      'device_loads_w',value->'device_loads_w','room_heating_w',value->'room_heating_w',
      'ev_target_current_a',value->'ev_target_current_a','ev_min_current_a',value->'ev_min_current_a','ev_max_current_a',value->'ev_max_current_a',
      'boiler_battery_allowed',value->'boiler_battery_allowed','boiler_permitted',value->'boiler_permitted','boiler_expected_w',value->'boiler_expected_w',
      'battery_instruction',value->'battery_instruction','battery_command',value->'battery_command','device_commands',value->'device_commands') ORDER BY ordinal),'[]'::jsonb))
    FROM jsonb_array_elements(COALESCE(p_plan->'plans'->'priority'->'slots','[]'::jsonb)) WITH ORDINALITY AS slots(value,ordinal);
$$;
