-- Undo the control implementation deployed only to test. The original
-- 20260910153000 and 20260910180000 migrations were removed by the branch
-- rollback; their applied history entries in test are repaired separately.
-- Production never received those migrations, so absent objects are expected.
-- Drop only the introduced objects, leaving existing plans and readings intact.
DROP FUNCTION IF EXISTS public.publish_control_optimisation(uuid, bigint, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.compare_exchange_control_agreement(uuid, bigint, jsonb);
DROP TABLE IF EXISTS public.energy_control_agreements;
