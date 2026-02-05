
-- Fix the integrity check function with proper column aliases
CREATE OR REPLACE FUNCTION public.check_contacts_customers_integrity()
RETURNS TABLE(
  check_name text,
  issue_count integer,
  sample_ids text
) 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    'duplicate_contact_emails'::text AS check_name,
    (SELECT COUNT(*)::integer FROM (
      SELECT lower(trim(c.email)) FROM contacts c
      WHERE c.email IS NOT NULL AND trim(c.email) != ''
      GROUP BY lower(trim(c.email)) HAVING COUNT(*) > 1
    ) sub) AS issue_count,
    (SELECT string_agg(sub.normalized_email, ', ') FROM (
      SELECT lower(trim(c.email)) as normalized_email FROM contacts c
      WHERE c.email IS NOT NULL AND trim(c.email) != ''
      GROUP BY lower(trim(c.email)) HAVING COUNT(*) > 1
      LIMIT 5
    ) sub) AS sample_ids;

  RETURN QUERY
  SELECT 
    'customers_missing_contact_id'::text,
    (SELECT COUNT(*)::integer FROM customers cust WHERE cust.contact_id IS NULL),
    (SELECT string_agg(cust.id::text, ', ') FROM (
      SELECT cust2.id FROM customers cust2 WHERE cust2.contact_id IS NULL LIMIT 5
    ) cust);

  RETURN QUERY
  SELECT 
    'orphaned_contact_ids'::text,
    (SELECT COUNT(*)::integer FROM customers cust 
     WHERE cust.contact_id IS NOT NULL 
       AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = cust.contact_id)),
    (SELECT string_agg(cust.id::text, ', ') FROM (
      SELECT cust2.id FROM customers cust2 
      WHERE cust2.contact_id IS NOT NULL 
        AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = cust2.contact_id)
      LIMIT 5
    ) cust);

  RETURN QUERY
  SELECT 
    'bidirectional_link_mismatch'::text,
    (SELECT COUNT(*)::integer FROM contacts ct
     JOIN customers cust ON ct.converted_to_customer_id = cust.id
     WHERE cust.contact_id IS NULL OR cust.contact_id != ct.id),
    (SELECT string_agg(ct.id::text, ', ') FROM (
      SELECT ct2.id FROM contacts ct2
      JOIN customers cust ON ct2.converted_to_customer_id = cust.id
      WHERE cust.contact_id IS NULL OR cust.contact_id != ct2.id
      LIMIT 5
    ) ct);
END;
$$;
