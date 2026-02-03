-- Drop validation triggers (no longer needed since columns are being removed)
DROP TRIGGER IF EXISTS validate_quote_totals_trigger ON public.quotes;
DROP TRIGGER IF EXISTS validate_invoice_totals_trigger ON public.invoices;

-- Drop validation functions
DROP FUNCTION IF EXISTS public.validate_quote_totals();
DROP FUNCTION IF EXISTS public.validate_invoice_totals();

-- Remove deprecated total columns from quotes table
ALTER TABLE public.quotes 
  DROP COLUMN IF EXISTS hardware_total,
  DROP COLUMN IF EXISTS labor_total,
  DROP COLUMN IF EXISTS travel_total,
  DROP COLUMN IF EXISTS subtotal_ex_vat,
  DROP COLUMN IF EXISTS vat_total,
  DROP COLUMN IF EXISTS total_inc_vat;

-- Remove deprecated total columns from invoices table
ALTER TABLE public.invoices 
  DROP COLUMN IF EXISTS subtotal,
  DROP COLUMN IF EXISTS tax,
  DROP COLUMN IF EXISTS total;