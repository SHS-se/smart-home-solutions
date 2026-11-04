-- Replace the retired pool steps with the versioned continuous comfort rule.
-- Preserve unrelated preferences. Runtime validation continues to reject old keys.
UPDATE public.energy_planner_rule_policy
SET criteria = criteria - ARRAY['pool_low', 'pool_cold', 'pool_hot'], updated_at = now()
WHERE id = true;
DO $$
BEGIN
  IF to_regclass('public.bench_rules') IS NOT NULL THEN
    EXECUTE $sql$UPDATE public.bench_rules
      SET criteria = criteria - ARRAY['pool_low', 'pool_cold', 'pool_hot'] WHERE id = true$sql$;
  END IF;
END; $$;
