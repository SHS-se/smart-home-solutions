-- Restrict payment details (bankgiro/IBAN/BIC) on business_settings.
--
-- Policy decision: payment details should only be visible when you have a
-- bill to pay. Invoice/quote documents already deliver them through
-- service-role edge functions (token- or login-gated), so the browsable table
-- becomes staff-only and the public marketing pages (contact page, footer)
-- read a view that excludes banking fields.

DROP POLICY IF EXISTS "Anyone can view business_settings" ON public.business_settings;

CREATE POLICY "Staff can view business_settings"
ON public.business_settings
FOR SELECT
TO authenticated
USING (public.is_staff(auth.uid()));

-- Owner-rights view (security_invoker off) intentionally bypasses the table's
-- RLS for exactly these non-sensitive columns.
CREATE OR REPLACE VIEW public.business_settings_public AS
SELECT
  id,
  legal_name,
  org_number,
  vat_number,
  f_skatt_approved,
  address_street,
  address_postcode,
  address_city,
  address_country,
  contact_email,
  support_email,
  contact_phone,
  website,
  payment_terms_days,
  updated_at
FROM public.business_settings;

GRANT SELECT ON public.business_settings_public TO anon, authenticated;
