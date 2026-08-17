-- Replace the owner-rights business_settings_public view with a function.
--
-- The policy decision from 20260707132000 stands: payment details (bankgiro,
-- IBAN, BIC, bank, payee) are staff-only, and the public marketing surfaces
-- read the remaining columns. What has to change is the mechanism. A view
-- without security_invoker reads with the *creator's* rights, so its bypass of
-- the table's RLS is invisible at the call site and follows any grant the view
-- is ever given — which is what Supabase's security_definer_view advisor
-- objects to.
--
-- RLS cannot express this restriction on its own: the split is by column, not
-- by row, and staff and customers share the `authenticated` role, so column
-- grants cannot separate them either. A SECURITY DEFINER function is the
-- remaining option, and it is the better shape for the same privilege: the
-- exposed columns are written out in its body, its search_path is pinned, and
-- EXECUTE is granted explicitly rather than inherited from a view's SELECT.

DROP VIEW IF EXISTS public.business_settings_public;

CREATE OR REPLACE FUNCTION public.get_public_business_settings()
RETURNS TABLE (
  id integer,
  legal_name text,
  org_number text,
  vat_number text,
  f_skatt_approved boolean,
  address_street text,
  address_postcode text,
  address_city text,
  address_country text,
  contact_email text,
  support_email text,
  contact_phone text,
  website text,
  payment_terms_days integer,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    settings.id,
    settings.legal_name,
    settings.org_number,
    settings.vat_number,
    settings.f_skatt_approved,
    settings.address_street,
    settings.address_postcode,
    settings.address_city,
    settings.address_country,
    settings.contact_email,
    settings.support_email,
    settings.contact_phone,
    settings.website,
    settings.payment_terms_days,
    settings.updated_at
  FROM public.business_settings AS settings
  WHERE settings.id = 1;
$$;

COMMENT ON FUNCTION public.get_public_business_settings() IS
  'Company identity and contact details for anonymous and customer surfaces. '
  'Deliberately omits the payment details, which stay staff-only on '
  'public.business_settings and reach payers through the invoice and quote '
  'documents.';

REVOKE ALL ON FUNCTION public.get_public_business_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_business_settings()
  TO anon, authenticated;
