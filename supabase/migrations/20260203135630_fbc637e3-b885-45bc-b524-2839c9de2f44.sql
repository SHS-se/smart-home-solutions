-- Fix the validate_quote_totals function - check for NULL record differently
CREATE OR REPLACE FUNCTION public.validate_quote_totals()
RETURNS TRIGGER AS $$
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
      IF v_computed IS NOT NULL THEN
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Fix the validate_invoice_totals function similarly
CREATE OR REPLACE FUNCTION public.validate_invoice_totals()
RETURNS TRIGGER AS $$
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
      IF v_computed IS NOT NULL THEN
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;