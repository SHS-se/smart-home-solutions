
-- =============================================================
-- Problem 2 Fix: Invoice Linkage and Stripe Reconciliation
-- =============================================================

-- Step 1: Add UNIQUE constraint on quotes.stripe_quote_id
-- (allows NULL values, enforces uniqueness for non-null)
CREATE UNIQUE INDEX IF NOT EXISTS quotes_stripe_quote_id_unique 
ON public.quotes (stripe_quote_id) 
WHERE stripe_quote_id IS NOT NULL;

-- Step 2: Add issued_at column to invoices for explicit lifecycle tracking
ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ NULL;

-- Step 3: Migrate data from ambiguous 'date' column to 'issued_at'
-- The 'date' column represents the invoice issue date
UPDATE public.invoices 
SET issued_at = date::timestamptz 
WHERE date IS NOT NULL AND issued_at IS NULL;

-- Step 4: Drop the ambiguous 'date' column
ALTER TABLE public.invoices DROP COLUMN IF EXISTS date;

-- Step 5: Ensure we have an index for Stripe reconciliation queries
CREATE INDEX IF NOT EXISTS idx_quotes_stripe_quote_id 
ON public.quotes (stripe_quote_id) 
WHERE stripe_quote_id IS NOT NULL;

-- Step 6: Add index on invoices.status for lifecycle queries
CREATE INDEX IF NOT EXISTS idx_invoices_status 
ON public.invoices (status);

-- Step 7: Add composite index for common billing queries
CREATE INDEX IF NOT EXISTS idx_invoices_customer_status 
ON public.invoices (customer_id, status);

-- =============================================================
-- Final Schema State for ERD:
-- - invoices.quote_id (nullable FK) → quotes.id ✓
-- - invoices.stripe_invoice_id (unique) ✓
-- - quotes.stripe_quote_id (unique) ✓
-- - Invoice lifecycle: created_at, issued_at, finalized_at, 
--   due_date, paid_at, voided_at (all explicit)
-- =============================================================
