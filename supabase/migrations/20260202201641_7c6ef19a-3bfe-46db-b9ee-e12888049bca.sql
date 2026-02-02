-- Fix the security definer view warning by recreating with explicit security invoker
DROP VIEW IF EXISTS public.quote_computed_totals;

CREATE VIEW public.quote_computed_totals
WITH (security_invoker = on)
AS
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