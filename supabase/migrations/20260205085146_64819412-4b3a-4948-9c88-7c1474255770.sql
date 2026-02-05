-- Drop the repair and check functions that are no longer needed
-- The identity consolidation is complete and the schema now enforces correct patterns

DROP FUNCTION IF EXISTS public.repair_contacts_customers_integrity();
DROP FUNCTION IF EXISTS public.check_contacts_customers_integrity();
DROP FUNCTION IF EXISTS public.dedupe_contacts_by_email();