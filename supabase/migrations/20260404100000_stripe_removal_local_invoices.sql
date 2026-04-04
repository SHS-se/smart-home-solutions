-- =====================================================
-- Stripe Removal: Local Invoice & Payment Schema
-- =====================================================
-- Adds fields for local invoice lifecycle, public access tokens,
-- invoice payments table, subscription entitlement, and
-- a gap-free invoice number allocation function.

-- A) Add invoice public-access and lifecycle columns
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS public_token_hash text,
  ADD COLUMN IF NOT EXISTS public_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_public_viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- B) Add customer subscription entitlement columns
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS subscription_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz;

-- C) Create invoice_payments table
CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  payment_date date NOT NULL,
  amount numeric(12,2) NOT NULL,
  method text NOT NULL DEFAULT 'bankgiro',
  reference text,
  note text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice_id ON public.invoice_payments(invoice_id);

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read invoice_payments"
  ON public.invoice_payments FOR SELECT
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can insert invoice_payments"
  ON public.invoice_payments FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update invoice_payments"
  ON public.invoice_payments FOR UPDATE
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete invoice_payments"
  ON public.invoice_payments FOR DELETE
  USING (public.is_staff(auth.uid()));

-- D) Initialize invoice sequence in document_sequences
INSERT INTO public.document_sequences (key, next_value) VALUES ('invoice', 1)
ON CONFLICT (key) DO NOTHING;

-- E) Create allocate_invoice_number() — gap-free, transaction-safe
CREATE OR REPLACE FUNCTION public.allocate_invoice_number()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_next int;
  v_prefix text;
  v_env text;
BEGIN
  -- Serialize access to prevent concurrent allocation
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number_alloc'));

  v_env := current_setting('app.environment', true);
  IF v_env = 'live' THEN
    v_prefix := 'IN-';
  ELSE
    v_prefix := 'TIN-';
  END IF;

  -- Find the highest existing issued number in the active prefix series
  SELECT COALESCE(MAX(
    CASE
      WHEN invoice_number ~ ('^' || v_prefix || '\d+$')
      THEN CAST(SUBSTRING(invoice_number FROM LENGTH(v_prefix) + 1) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO v_next
  FROM public.invoices
  WHERE invoice_number LIKE v_prefix || '%';

  -- Also check the sequence table and use whichever is higher
  DECLARE
    v_seq int;
  BEGIN
    UPDATE public.document_sequences
      SET next_value = GREATEST(next_value, v_next) + 1
      WHERE key = 'invoice'
      RETURNING next_value - 1 INTO v_seq;

    IF v_seq IS NOT NULL AND v_seq > v_next THEN
      v_next := v_seq;
    END IF;
  END;

  RETURN v_prefix || LPAD(v_next::text, 4, '0');
END;
$$;

-- F) Drop the invoice-pdfs storage bucket and its policies
-- (The bucket was created in migration 20260203144743)
DO $$
BEGIN
  -- Remove storage policies first
  DELETE FROM storage.policies WHERE bucket_id = 'invoice-pdfs';
  -- Remove the bucket
  DELETE FROM storage.buckets WHERE id = 'invoice-pdfs';
EXCEPTION WHEN OTHERS THEN
  -- Bucket may not exist in all environments
  NULL;
END;
$$;
