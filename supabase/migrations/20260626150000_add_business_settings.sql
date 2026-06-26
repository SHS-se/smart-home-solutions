-- Business settings: a single-row table holding the company identity, contact
-- details and payment information that previously lived hard-coded in
-- `_shared/invoice-company.ts` (seller block, payee) and the `BANKGIRO_NUMBER`
-- edge-function secret. Making it a table lets staff configure it from the
-- portal and lets every surface (invoice PDF, invoice document view, invoice
-- emails, public contact page/footer) read one source of truth.
--
-- Singleton: enforced with a CHECK (id = 1) so there is always exactly one row.
-- Reads are public (this is the same contact/payment info already printed on
-- the public website and on every invoice); writes are admin-only.

CREATE TABLE IF NOT EXISTS public.business_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Company / legal identity
  legal_name text NOT NULL DEFAULT 'Smart Home Solutions',
  org_number text,
  vat_number text,
  f_skatt_approved boolean NOT NULL DEFAULT true,

  -- Address
  address_street text,
  address_postcode text,
  address_city text,
  address_country text NOT NULL DEFAULT 'Sverige',

  -- Contact
  contact_email text,
  support_email text,
  contact_phone text,
  website text,

  -- Payment
  bankgiro_number text,
  payee_name text,
  iban text,
  bic text,
  bank_name text,
  payment_terms_days integer NOT NULL DEFAULT 30,

  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the single row with the values that were previously hard-coded so every
-- invoice keeps rendering the same company details. Bankgiro is intentionally
-- left NULL — the operator fills it in from the new settings page.
INSERT INTO public.business_settings (
  id, legal_name, org_number, vat_number, f_skatt_approved,
  address_street, address_postcode, address_city, address_country,
  contact_email, support_email, contact_phone, website,
  payee_name, payment_terms_days
)
VALUES (
  1, 'Smart Home Solutions', '790519-7591', 'SE790519759101', true,
  'Porfyrvägen 10', '187 34', 'Täby', 'Sverige',
  'sales@smarthomesolutions.se', 'support@smarthomesolutions.se', '+46 70 287 08 14', 'https://smarthomesolutions.se',
  'Smart Home Solutions', 30
)
ON CONFLICT (id) DO NOTHING;

-- Keep updated_at fresh on every write.
CREATE OR REPLACE FUNCTION public.business_settings_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_settings_updated_at ON public.business_settings;
CREATE TRIGGER business_settings_updated_at
  BEFORE UPDATE ON public.business_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.business_settings_set_updated_at();

ALTER TABLE public.business_settings ENABLE ROW LEVEL SECURITY;

-- Anyone (including anonymous visitors on the public contact page/footer) may
-- read the business details — they are already public-facing.
CREATE POLICY "Anyone can view business_settings"
  ON public.business_settings FOR SELECT
  USING (true);

-- Only admins may change them.
CREATE POLICY "Admins can update business_settings"
  ON public.business_settings FOR UPDATE
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Admins can insert business_settings"
  ON public.business_settings FOR INSERT
  WITH CHECK (public.is_admin(auth.uid()));
