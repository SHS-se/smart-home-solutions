-- Step 1: Before dropping columns, ensure the view still works by recreating it
-- to reference the contacts table instead of the customers columns

-- Drop and recreate the customers_with_identity view to NOT use the columns we're about to drop
DROP VIEW IF EXISTS public.customers_with_identity;

CREATE VIEW public.customers_with_identity
WITH (security_invoker = on)
AS
SELECT 
  c.id,
  c.created_at,
  c.user_id,
  c.is_test,
  c.billing_same_as_site,
  c.contact_id,
  -- Address fields from customers (these stay)
  c.site_street,
  c.site_postcode,
  c.site_city,
  c.billing_street,
  c.billing_postcode,
  c.billing_city,
  -- Identity fields now ONLY from contacts (remove the customer fallbacks)
  con.name AS contact_name,
  con.email AS contact_email,
  con.phone AS contact_phone,
  -- Keep name/billing_email/phone for backward compat during transition (from contacts)
  con.name AS name,
  con.email AS billing_email,
  con.phone AS phone
FROM public.customers c
LEFT JOIN public.contacts con ON c.contact_id = con.id;

-- Add helpful comment
COMMENT ON VIEW public.customers_with_identity IS 'Joins customers with their contact identity (name, email, phone from contacts table)';

-- Step 2: Drop the duplicate columns from customers table
ALTER TABLE public.customers DROP COLUMN IF EXISTS name;
ALTER TABLE public.customers DROP COLUMN IF EXISTS billing_email;
ALTER TABLE public.customers DROP COLUMN IF EXISTS phone;