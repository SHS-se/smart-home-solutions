-- Delete retired scorer settings once. Runtime validation rejects unknown rules;
-- it must not silently retain an ignored-policy compatibility path.
UPDATE public.energy_planner_rule_policy
SET criteria = criteria - ARRAY[
  'solar_spill', 'idle_battery', 'dear_buy', 'dearest_buy', 'estimated_buy',
  'unplugged_charge', 'ev_short_gap', 'pool_buffer', 'pool_restart',
  'cheap_buy', 'cheapest_buy', 'dear_load', 'dearest_load',
  'base_load_dear_import', 'base_load_dearest_import', 'missed_cheap_quarter',
  'arbitrage_no_export', 'arbitrage_not_full', 'ev_from_home_battery',
  'large_load_overlap', 'pool_short_gap', 'early_grid_charge'
], updated_at = now()
WHERE id = true;

DO $$
BEGIN
  IF to_regclass('public.bench_rules') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE public.bench_rules SET criteria = criteria - ARRAY[
        'solar_spill', 'idle_battery', 'dear_buy', 'dearest_buy', 'estimated_buy',
        'unplugged_charge', 'ev_short_gap', 'pool_buffer', 'pool_restart',
        'cheap_buy', 'cheapest_buy', 'dear_load', 'dearest_load',
        'base_load_dear_import', 'base_load_dearest_import', 'missed_cheap_quarter',
        'arbitrage_no_export', 'arbitrage_not_full', 'ev_from_home_battery',
        'large_load_overlap', 'pool_short_gap', 'early_grid_charge'
      ] WHERE id = true
    $sql$;
  END IF;
END; $$;
