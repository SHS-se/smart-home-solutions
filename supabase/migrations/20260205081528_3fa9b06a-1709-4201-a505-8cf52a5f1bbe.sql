
-- =============================================================================
-- MIGRATION: Contacts as Canonical Identity Records
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1: Rename customers.org_name -> customers.name
-- -----------------------------------------------------------------------------
ALTER TABLE public.customers RENAME COLUMN org_name TO name;

-- -----------------------------------------------------------------------------
-- STEP 2: Add customers.contact_id column with FK
-- -----------------------------------------------------------------------------
ALTER TABLE public.customers 
ADD COLUMN contact_id uuid REFERENCES public.contacts(id) ON DELETE RESTRICT;

-- Create unique index on contact_id (enforces 1:1, allows NULLs)
CREATE UNIQUE INDEX idx_customers_contact_id_unique 
ON public.customers(contact_id) 
WHERE contact_id IS NOT NULL;

-- Performance index for joining
CREATE INDEX idx_customers_contact_id ON public.customers(contact_id);

-- -----------------------------------------------------------------------------
-- STEP 3: Create unique index on normalized email in contacts
-- Only when email is not null and not empty
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX idx_contacts_normalized_email_unique 
ON public.contacts(lower(trim(email))) 
WHERE email IS NOT NULL AND trim(email) != '';

-- -----------------------------------------------------------------------------
-- STEP 4: Dedupe contacts by normalized email (simplified - no duplicates expected)
-- This function can be called manually if duplicates need handling
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dedupe_contacts_by_email()
RETURNS TABLE(duplicates_removed integer, contacts_reassigned integer) 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duplicates_removed integer := 0;
  v_contacts_reassigned integer := 0;
  v_canonical_id uuid;
  v_duplicate_id uuid;
  v_normalized_email text;
  v_row_count integer;
BEGIN
  -- Find all duplicate email groups
  FOR v_normalized_email, v_canonical_id IN
    WITH ranked AS (
      SELECT 
        id,
        lower(trim(email)) as normalized_email,
        ROW_NUMBER() OVER (
          PARTITION BY lower(trim(email))
          ORDER BY 
            (converted_to_customer_id IS NOT NULL) DESC,
            created_at ASC,
            id ASC
        ) as rn
      FROM contacts
      WHERE email IS NOT NULL AND trim(email) != ''
    )
    SELECT normalized_email, id FROM ranked WHERE rn = 1
  LOOP
    -- Find duplicates for this email (non-canonical)
    FOR v_duplicate_id IN
      SELECT id FROM contacts 
      WHERE lower(trim(email)) = v_normalized_email 
        AND id != v_canonical_id
    LOOP
      -- Reassign contact_messages to canonical contact
      UPDATE contact_messages 
      SET contact_id = v_canonical_id 
      WHERE contact_id = v_duplicate_id;
      
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_contacts_reassigned := v_contacts_reassigned + v_row_count;
      
      -- Delete the duplicate contact
      DELETE FROM contacts WHERE id = v_duplicate_id;
      v_duplicates_removed := v_duplicates_removed + 1;
    END LOOP;
  END LOOP;
  
  RETURN QUERY SELECT v_duplicates_removed, v_contacts_reassigned;
END;
$$;

-- Run deduplication (safe and idempotent)
SELECT * FROM dedupe_contacts_by_email();

-- -----------------------------------------------------------------------------
-- STEP 5: Populate customers.contact_id (link customers to canonical contacts)
-- -----------------------------------------------------------------------------
-- Priority 1: Contact with converted_to_customer_id pointing to this customer
UPDATE customers c
SET contact_id = (
  SELECT ct.id FROM contacts ct 
  WHERE ct.converted_to_customer_id = c.id 
  LIMIT 1
)
WHERE c.contact_id IS NULL
  AND EXISTS (
    SELECT 1 FROM contacts ct WHERE ct.converted_to_customer_id = c.id
  );

-- Priority 2: Match by normalized email
UPDATE customers c
SET contact_id = (
  SELECT ct.id FROM contacts ct 
  WHERE lower(trim(ct.email)) = lower(trim(c.billing_email))
    AND ct.converted_to_customer_id IS NULL
  LIMIT 1
)
WHERE c.contact_id IS NULL
  AND c.billing_email IS NOT NULL 
  AND trim(c.billing_email) != ''
  AND EXISTS (
    SELECT 1 FROM contacts ct 
    WHERE lower(trim(ct.email)) = lower(trim(c.billing_email))
      AND ct.converted_to_customer_id IS NULL
  );

-- Priority 3: Create new contact for customers without one
INSERT INTO contacts (name, email, phone, message, converted_to_customer_id, converted_at)
SELECT 
  COALESCE(c.name, 'Unnamed Customer'),
  c.billing_email,
  c.phone,
  'Auto-created from customer migration',
  c.id,
  now()
FROM customers c
WHERE c.contact_id IS NULL
  AND (
    c.billing_email IS NOT NULL AND trim(c.billing_email) != ''
    OR EXISTS (SELECT 1 FROM quotes q WHERE q.customer_id = c.id)
    OR EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id)
    OR EXISTS (SELECT 1 FROM tickets t WHERE t.customer_id = c.id)
  );

-- Link those newly created contacts
UPDATE customers c
SET contact_id = (
  SELECT ct.id FROM contacts ct 
  WHERE ct.converted_to_customer_id = c.id 
  ORDER BY ct.created_at DESC
  LIMIT 1
)
WHERE c.contact_id IS NULL
  AND EXISTS (
    SELECT 1 FROM contacts ct WHERE ct.converted_to_customer_id = c.id
  );

-- -----------------------------------------------------------------------------
-- STEP 6: Overwrite contacts identity fields from customers 
-- -----------------------------------------------------------------------------
UPDATE contacts ct
SET 
  name = COALESCE(NULLIF(trim(c.name), ''), ct.name),
  email = COALESCE(NULLIF(trim(c.billing_email), ''), ct.email),
  phone = COALESCE(NULLIF(trim(c.phone), ''), ct.phone)
FROM customers c
WHERE c.contact_id = ct.id
  AND c.contact_id IS NOT NULL;

-- Update converted_to_customer_id if not already set
UPDATE contacts ct
SET converted_to_customer_id = c.id,
    converted_at = COALESCE(ct.converted_at, now())
FROM customers c
WHERE c.contact_id = ct.id
  AND c.contact_id IS NOT NULL
  AND ct.converted_to_customer_id IS NULL;

-- -----------------------------------------------------------------------------
-- STEP 7: Create backwards-compat view customers_with_identity
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.customers_with_identity AS
SELECT 
  c.*,
  ct.name as contact_name,
  ct.email as contact_email,
  ct.phone as contact_phone
FROM customers c
LEFT JOIN contacts ct ON c.contact_id = ct.id;

-- -----------------------------------------------------------------------------
-- STEP 8: Create data integrity check function
-- -----------------------------------------------------------------------------
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
    'duplicate_contact_emails'::text,
    (SELECT COUNT(*)::integer FROM (
      SELECT lower(trim(email)) FROM contacts 
      WHERE email IS NOT NULL AND trim(email) != ''
      GROUP BY lower(trim(email)) HAVING COUNT(*) > 1
    ) sub),
    (SELECT string_agg(lower(trim(email)), ', ') FROM (
      SELECT lower(trim(email)) FROM contacts 
      WHERE email IS NOT NULL AND trim(email) != ''
      GROUP BY lower(trim(email)) HAVING COUNT(*) > 1
      LIMIT 5
    ) sub);

  RETURN QUERY
  SELECT 
    'customers_missing_contact_id'::text,
    (SELECT COUNT(*)::integer FROM customers WHERE contact_id IS NULL),
    (SELECT string_agg(id::text, ', ') FROM (
      SELECT id FROM customers WHERE contact_id IS NULL LIMIT 5
    ) sub);

  RETURN QUERY
  SELECT 
    'orphaned_contact_ids'::text,
    (SELECT COUNT(*)::integer FROM customers c 
     WHERE c.contact_id IS NOT NULL 
       AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = c.contact_id)),
    (SELECT string_agg(id::text, ', ') FROM (
      SELECT c.id FROM customers c 
      WHERE c.contact_id IS NOT NULL 
        AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = c.contact_id)
      LIMIT 5
    ) sub);

  RETURN QUERY
  SELECT 
    'bidirectional_link_mismatch'::text,
    (SELECT COUNT(*)::integer FROM contacts ct
     JOIN customers c ON ct.converted_to_customer_id = c.id
     WHERE c.contact_id IS NULL OR c.contact_id != ct.id),
    (SELECT string_agg(ct.id::text, ', ') FROM (
      SELECT ct.id FROM contacts ct
      JOIN customers c ON ct.converted_to_customer_id = c.id
      WHERE c.contact_id IS NULL OR c.contact_id != ct.id
      LIMIT 5
    ) sub);
END;
$$;

-- -----------------------------------------------------------------------------
-- STEP 9: Create repair function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.repair_contacts_customers_integrity()
RETURNS TABLE(
  action_taken text,
  rows_affected integer
) 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE customers c
  SET contact_id = (
    SELECT ct.id FROM contacts ct 
    WHERE ct.converted_to_customer_id = c.id 
    LIMIT 1
  )
  WHERE c.contact_id IS NULL
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.converted_to_customer_id = c.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  action_taken := 'linked_via_converted_to_customer_id';
  rows_affected := v_count;
  RETURN NEXT;

  UPDATE customers c
  SET contact_id = (
    SELECT ct.id FROM contacts ct 
    WHERE lower(trim(ct.email)) = lower(trim(c.billing_email))
      AND ct.converted_to_customer_id IS NULL
    LIMIT 1
  )
  WHERE c.contact_id IS NULL
    AND c.billing_email IS NOT NULL AND trim(c.billing_email) != '';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  action_taken := 'linked_via_email_match';
  rows_affected := v_count;
  RETURN NEXT;

  INSERT INTO contacts (name, email, phone, message, converted_to_customer_id, converted_at)
  SELECT 
    COALESCE(c.name, 'Unnamed Customer'),
    c.billing_email,
    c.phone,
    'Auto-created from repair function',
    c.id,
    now()
  FROM customers c
  WHERE c.contact_id IS NULL
    AND c.billing_email IS NOT NULL AND trim(c.billing_email) != '';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  action_taken := 'created_new_contacts';
  rows_affected := v_count;
  RETURN NEXT;

  UPDATE customers c
  SET contact_id = (
    SELECT ct.id FROM contacts ct 
    WHERE ct.converted_to_customer_id = c.id 
    ORDER BY ct.created_at DESC
    LIMIT 1
  )
  WHERE c.contact_id IS NULL
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.converted_to_customer_id = c.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  action_taken := 'linked_newly_created';
  rows_affected := v_count;
  RETURN NEXT;

  UPDATE contacts ct
  SET 
    name = COALESCE(NULLIF(trim(c.name), ''), ct.name),
    email = COALESCE(NULLIF(trim(c.billing_email), ''), ct.email),
    phone = COALESCE(NULLIF(trim(c.phone), ''), ct.phone)
  FROM customers c
  WHERE c.contact_id = ct.id
    AND c.contact_id IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  action_taken := 'synced_identity_to_contacts';
  rows_affected := v_count;
  RETURN NEXT;
END;
$$;
