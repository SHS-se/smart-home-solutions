-- ================================================
-- DATA INTEGRITY: Derived Totals from Line Items
-- ================================================

-- 1. Create invoice_computed_totals view (like quote_computed_totals)
CREATE OR REPLACE VIEW public.invoice_computed_totals
WITH (security_invoker = on)
AS
SELECT 
  i.id AS invoice_id,
  COALESCE(SUM(li.quantity * li.unit_price), 0) AS subtotal,
  COALESCE(SUM(ROUND(li.quantity * li.unit_price * li.tax_rate / 100, 2)), 0) AS tax,
  COALESCE(SUM(li.quantity * li.unit_price), 0) + COALESCE(SUM(ROUND(li.quantity * li.unit_price * li.tax_rate / 100, 2)), 0) AS total
FROM public.invoices i
LEFT JOIN public.invoice_line_items li ON li.invoice_id = i.id
GROUP BY i.id;

-- Add index for efficient computation
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice_id ON public.invoice_line_items(invoice_id);

-- Add comment explaining this is the source of truth
COMMENT ON VIEW public.invoice_computed_totals IS 
'Single source of truth for invoice totals. Aggregates from invoice_line_items in real-time.';

COMMENT ON VIEW public.quote_computed_totals IS 
'Single source of truth for quote totals. Aggregates from quote_lines in real-time. VAT calculated per-line.';

-- 2. Create validation trigger function for quotes
-- This prevents manual updates to totals unless they match computed values
CREATE OR REPLACE FUNCTION public.validate_quote_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_computed RECORD;
BEGIN
  -- Only validate on UPDATE of total columns
  IF TG_OP = 'UPDATE' THEN
    -- Check if any total column is being changed
    IF NEW.hardware_total IS DISTINCT FROM OLD.hardware_total OR
       NEW.labor_total IS DISTINCT FROM OLD.labor_total OR
       NEW.travel_total IS DISTINCT FROM OLD.travel_total OR
       NEW.subtotal_ex_vat IS DISTINCT FROM OLD.subtotal_ex_vat OR
       NEW.vat_total IS DISTINCT FROM OLD.vat_total OR
       NEW.total_inc_vat IS DISTINCT FROM OLD.total_inc_vat
    THEN
      -- Get computed values
      SELECT 
        hardware_total, labor_total, travel_total,
        subtotal_ex_vat, vat_total, total_inc_vat
      INTO v_computed
      FROM public.quote_computed_totals
      WHERE quote_id = NEW.id;
      
      -- Validate: new values must match computed values (with tolerance for rounding)
      IF v_computed.quote_id IS NOT NULL THEN
        IF ABS(COALESCE(NEW.hardware_total, 0) - COALESCE(v_computed.hardware_total, 0)) > 0.01 OR
           ABS(COALESCE(NEW.labor_total, 0) - COALESCE(v_computed.labor_total, 0)) > 0.01 OR
           ABS(COALESCE(NEW.travel_total, 0) - COALESCE(v_computed.travel_total, 0)) > 0.01 OR
           ABS(COALESCE(NEW.subtotal_ex_vat, 0) - COALESCE(v_computed.subtotal_ex_vat, 0)) > 0.01 OR
           ABS(COALESCE(NEW.vat_total, 0) - COALESCE(v_computed.vat_total, 0)) > 0.01 OR
           ABS(COALESCE(NEW.total_inc_vat, 0) - COALESCE(v_computed.total_inc_vat, 0)) > 0.01
        THEN
          RAISE EXCEPTION 'Quote totals must match computed values from quote_lines. Attempted: hw=%, labor=%, travel=%, subtotal=%, vat=%, total=%. Expected: hw=%, labor=%, travel=%, subtotal=%, vat=%, total=%',
            NEW.hardware_total, NEW.labor_total, NEW.travel_total, NEW.subtotal_ex_vat, NEW.vat_total, NEW.total_inc_vat,
            v_computed.hardware_total, v_computed.labor_total, v_computed.travel_total, v_computed.subtotal_ex_vat, v_computed.vat_total, v_computed.total_inc_vat;
        END IF;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- 3. Create validation trigger function for invoices
CREATE OR REPLACE FUNCTION public.validate_invoice_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_computed RECORD;
BEGIN
  -- Only validate on UPDATE of total columns
  IF TG_OP = 'UPDATE' THEN
    -- Check if any total column is being changed
    IF NEW.subtotal IS DISTINCT FROM OLD.subtotal OR
       NEW.tax IS DISTINCT FROM OLD.tax OR
       NEW.total IS DISTINCT FROM OLD.total
    THEN
      -- Get computed values
      SELECT subtotal, tax, total
      INTO v_computed
      FROM public.invoice_computed_totals
      WHERE invoice_id = NEW.id;
      
      -- Validate: new values must match computed values (with tolerance for rounding)
      IF v_computed.invoice_id IS NOT NULL THEN
        IF ABS(COALESCE(NEW.subtotal, 0) - COALESCE(v_computed.subtotal, 0)) > 0.01 OR
           ABS(COALESCE(NEW.tax, 0) - COALESCE(v_computed.tax, 0)) > 0.01 OR
           ABS(COALESCE(NEW.total, 0) - COALESCE(v_computed.total, 0)) > 0.01
        THEN
          RAISE EXCEPTION 'Invoice totals must match computed values from invoice_line_items. Attempted: subtotal=%, tax=%, total=%. Expected: subtotal=%, tax=%, total=%',
            NEW.subtotal, NEW.tax, NEW.total,
            v_computed.subtotal, v_computed.tax, v_computed.total;
        END IF;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- 4. Create the triggers
DROP TRIGGER IF EXISTS validate_quote_totals_trigger ON public.quotes;
CREATE TRIGGER validate_quote_totals_trigger
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_quote_totals();

DROP TRIGGER IF EXISTS validate_invoice_totals_trigger ON public.invoices;
CREATE TRIGGER validate_invoice_totals_trigger
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_invoice_totals();

-- Add comments explaining the triggers
COMMENT ON FUNCTION public.validate_quote_totals() IS 
'Enforces data integrity: quote totals must match computed values from quote_lines';

COMMENT ON FUNCTION public.validate_invoice_totals() IS 
'Enforces data integrity: invoice totals must match computed values from invoice_line_items';