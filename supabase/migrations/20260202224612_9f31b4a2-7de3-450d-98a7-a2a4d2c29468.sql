
-- ============================================
-- PROBLEM 2 CLEANUP: Invoice Linkage & Stripe Reconciliation
-- ============================================

-- 1. Drop duplicate unique constraint on stripe_invoice_id (keep invoices_stripe_invoice_id_key)
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_stripe_invoice_id_unique;
DROP INDEX IF EXISTS public.idx_invoices_stripe_invoice_id;

-- 2. Drop legacy column stripe_quote_id from invoices (it belongs on quotes only)
ALTER TABLE public.invoices DROP COLUMN IF EXISTS stripe_quote_id;

-- 3. Add foreign key constraint on invoices.quote_id -> quotes.id (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'invoices_quote_id_fkey' 
    AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices 
    ADD CONSTRAINT invoices_quote_id_fkey 
    FOREIGN KEY (quote_id) REFERENCES public.quotes(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Add performance indexes (if not exist)
CREATE INDEX IF NOT EXISTS idx_invoices_quote_id ON public.invoices(quote_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON public.invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_status ON public.invoices(customer_id, status);
