
-- Fix SECURITY DEFINER view issue by using security_invoker
DROP VIEW IF EXISTS public.customers_with_identity;

CREATE VIEW public.customers_with_identity 
WITH (security_invoker = on)
AS
SELECT 
  c.*,
  ct.name as contact_name,
  ct.email as contact_email,
  ct.phone as contact_phone
FROM customers c
LEFT JOIN contacts ct ON c.contact_id = ct.id;
