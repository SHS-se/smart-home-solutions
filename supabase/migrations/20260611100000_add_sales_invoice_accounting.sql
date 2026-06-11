-- Sales/income accounting: link posted sales invoices and customer payments to
-- accounting verifications, with idempotency constraints so the same invoice
-- or payment can never be posted twice.

-- 1. Link table between operational invoices and accounting verifications.
--    One row per posted invoice (ordinary posting or filed-period correction).
CREATE TABLE public.acc_sales_invoice_links (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  verification_id uuid NOT NULL REFERENCES public.acc_verifications(id),
  source_snapshot_json jsonb NOT NULL,
  posted_at timestamp with time zone NOT NULL DEFAULT now(),
  posted_by uuid,
  posting_reason text NOT NULL DEFAULT 'ordinary',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT acc_sales_invoice_links_invoice_id_key UNIQUE (invoice_id),
  CONSTRAINT acc_sales_invoice_links_verification_id_key UNIQUE (verification_id)
);

ALTER TABLE public.acc_sales_invoice_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage sales invoice links"
  ON public.acc_sales_invoice_links
  TO authenticated
  USING (is_staff(auth.uid()))
  WITH CHECK (is_staff(auth.uid()));

-- 2. Restrict acc_verifications.source_type to the known set, now including
--    sales and payment verifications.
ALTER TABLE public.acc_verifications
  ADD CONSTRAINT acc_verifications_source_type_chk
  CHECK (source_type IN ('purchase', 'sales_invoice', 'sales_invoice_correction', 'customer_payment'));

-- 3. Idempotency for payments: the same payment cannot be recorded twice
--    on an invoice. The existing unique (source_type, source_id) partial index
--    on acc_verifications already prevents double-posting a recorded payment
--    (source_id = invoice_payments.id) or a sales invoice (source_id = invoices.id).
ALTER TABLE public.invoice_payments
  ADD CONSTRAINT invoice_payments_unique_payment_key
  UNIQUE (invoice_id, payment_date, amount, method);
