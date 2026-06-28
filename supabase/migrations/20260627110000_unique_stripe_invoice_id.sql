-- Harden subscription-invoice idempotency: one SHS invoice per Stripe invoice.
-- The webhook checks-then-inserts on stripe_invoice_id; this unique index makes
-- the DB enforce it so concurrent webhook re-deliveries can't create duplicates.
-- Partial (WHERE NOT NULL) so ordinary invoices without a Stripe link are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_stripe_invoice_id_key
  ON public.invoices (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;
