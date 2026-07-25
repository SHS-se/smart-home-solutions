-- Customers could not change their own name/email/phone from Kontouppgifter.
--
-- Those three fields live on public.contacts (customers_with_identity maps
-- con.name -> name, con.email -> billing_email, con.phone -> phone), but the
-- only customer-facing policy on contacts is the SELECT one added in
-- 20260205085722. The portal's UPDATE therefore matched zero rows: PostgREST
-- returns 204 with no error, the UI showed "Sparat!", and the next refetch put
-- the original contact-form values straight back into the inputs.
--
-- A blanket UPDATE policy would also hand customers email_token (used to
-- authenticate email links), the original lead message and the conversion
-- bookkeeping columns, so instead expose a SECURITY DEFINER function that
-- touches only the three identity columns of the contact linked to the calling
-- user's own customer record.

CREATE OR REPLACE FUNCTION public.update_own_contact_details(
  p_name text,
  p_email text,
  p_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_id uuid;
  v_name text := nullif(btrim(p_name), '');
  v_email text := nullif(btrim(p_email), '');
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Name is required';
  END IF;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Email is required';
  END IF;

  -- customers.contact_id is unique (idx_customers_contact_id_unique), so this
  -- resolves to the caller's own contact and nobody else's.
  SELECT c.contact_id
  INTO v_contact_id
  FROM public.customers c
  WHERE c.user_id = auth.uid()
    AND c.contact_id IS NOT NULL;

  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'No contact is linked to the current user';
  END IF;

  UPDATE public.contacts
  SET name = v_name,
      email = v_email,
      phone = nullif(btrim(p_phone), '')
  WHERE id = v_contact_id;
END;
$$;

COMMENT ON FUNCTION public.update_own_contact_details(text, text, text) IS
  'Lets a signed-in customer update name/email/phone on their own linked contact row. Staff update contacts directly via RLS.';

REVOKE ALL ON FUNCTION public.update_own_contact_details(text, text, text) FROM public;
REVOKE ALL ON FUNCTION public.update_own_contact_details(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_own_contact_details(text, text, text) TO authenticated;
