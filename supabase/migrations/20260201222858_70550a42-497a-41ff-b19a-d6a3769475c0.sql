-- Invoice ↔ Stripe reconciliation cleanup
-- 1. Drop deprecated external_id column (stripe_invoice_id is the canonical Stripe reference)
ALTER TABLE public.invoices DROP COLUMN IF EXISTS external_id;

-- 2. Add UNIQUE constraint on stripe_invoice_id (allows NULL, but non-null values must be unique)
ALTER TABLE public.invoices ADD CONSTRAINT invoices_stripe_invoice_id_unique UNIQUE (stripe_invoice_id);

-- 3. Add index on quote_id for efficient lookups of invoices linked to quotes
CREATE INDEX IF NOT EXISTS idx_invoices_quote_id ON public.invoices(quote_id);

-- 4. Add index on stripe_invoice_id for webhook lookups (unique constraint already creates one, but explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_invoices_stripe_invoice_id ON public.invoices(stripe_invoice_id);

-- 5. Add index on customer_id for customer invoice lists
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON public.invoices(customer_id);