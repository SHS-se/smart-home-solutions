-- Marketing email consent per customer.
--
-- Quotes, invoices and other account mail are transactional and always sent;
-- marketing_opt_out only governs marketing mail ("nyheter och erbjudanden").
-- The stable unsubscribe_token lets outgoing emails carry RFC 8058
-- List-Unsubscribe headers and a no-login unsubscribe link, which helps
-- deliverability even on transactional mail.

ALTER TABLE public.customers
  ADD COLUMN marketing_opt_out boolean NOT NULL DEFAULT false,
  ADD COLUMN marketing_opt_out_at timestamptz,
  ADD COLUMN unsubscribe_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex');

-- customers_with_identity selects an explicit column list, so it must be
-- recreated to expose the new columns (previous definition: 20260205084731).
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
  c.site_street,
  c.site_postcode,
  c.site_city,
  c.billing_street,
  c.billing_postcode,
  c.billing_city,
  c.marketing_opt_out,
  c.marketing_opt_out_at,
  c.unsubscribe_token,
  con.name AS contact_name,
  con.email AS contact_email,
  con.phone AS contact_phone,
  con.name AS name,
  con.email AS billing_email,
  con.phone AS phone
FROM public.customers c
LEFT JOIN public.contacts con ON c.contact_id = con.id;

COMMENT ON VIEW public.customers_with_identity IS 'Joins customers with their contact identity (name, email, phone from contacts table)';
