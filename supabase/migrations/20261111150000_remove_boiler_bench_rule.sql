UPDATE public.energy_planner_rule_policy
SET criteria = criteria - 'water_opportunities', updated_at = now()
WHERE id = true AND criteria ? 'water_opportunities';

DO $$
BEGIN
  IF to_regclass('public.bench_rules') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE public.bench_rules
      SET criteria = criteria - 'water_opportunities', updated_at = now()
      WHERE id = true AND criteria ? 'water_opportunities'
    $sql$;
  END IF;
END; $$;
