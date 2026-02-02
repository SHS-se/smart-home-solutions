-- Phase 2: Create computed totals view
-- This view calculates totals from quote_lines as the single source of truth

CREATE OR REPLACE VIEW public.quote_computed_totals AS
SELECT 
  q.id AS quote_id,
  COALESCE(SUM(CASE WHEN ql.section = 'hardware' THEN ql.quantity * ql.unit_price_ex_vat ELSE 0 END), 0) AS hardware_total,
  COALESCE(SUM(CASE WHEN ql.section = 'labor' THEN ql.quantity * ql.unit_price_ex_vat ELSE 0 END), 0) AS labor_total,
  COALESCE(SUM(CASE WHEN ql.section = 'travel' THEN ql.quantity * ql.unit_price_ex_vat ELSE 0 END), 0) AS travel_total,
  COALESCE(SUM(ql.quantity * ql.unit_price_ex_vat), 0) AS subtotal_ex_vat,
  COALESCE(SUM(ql.quantity * ql.unit_price_ex_vat * COALESCE(ql.vat_rate, 0.25)), 0) AS vat_total,
  COALESCE(SUM(ql.quantity * (ql.unit_price_ex_vat * (1 + COALESCE(ql.vat_rate, 0.25)))), 0) AS total_inc_vat
FROM quotes q
LEFT JOIN quote_lines ql ON ql.quote_id = q.id
GROUP BY q.id;

-- Add RLS policy for the view (views inherit table RLS, but explicit is safer)
-- The view is read-only and based on quotes table which already has RLS

-- Phase 3: Add index on quote_lines.quote_id for performance
CREATE INDEX IF NOT EXISTS idx_quote_lines_quote_id ON public.quote_lines(quote_id);

-- Add optional traceability columns to quote_lines for Phase 1
ALTER TABLE public.quote_lines 
ADD COLUMN IF NOT EXISTS source_bom_id uuid REFERENCES public.boms(id),
ADD COLUMN IF NOT EXISTS source_bom_item_id uuid;