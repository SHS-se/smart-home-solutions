-- ===========================================================================
-- Auto-create VAT periods (quarters) up to the current quarter.
-- Mirrors acc_ensure_current_periods() for monthly accounting periods.
--
-- Swedish kvartalsmoms filing deadlines (per Skatteverket):
--   Q1 (Jan-Mar): 12 May
--   Q2 (Apr-Jun): 17 August          (pushed from 12, summer vacation)
--   Q3 (Jul-Sep): 12 November
--   Q4 (Oct-Dec): 17 February (next year, pushed from 12 due to holidays)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.acc_vat_filing_deadline(p_year integer, p_quarter integer)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_quarter
    WHEN 1 THEN make_date(p_year,     5, 12)
    WHEN 2 THEN make_date(p_year,     8, 17)
    WHEN 3 THEN make_date(p_year,    11, 12)
    WHEN 4 THEN make_date(p_year + 1, 2, 17)
  END;
$$;

-- Ensure every quarter from Q1 of the current year up to and including the
-- quarter that contains today has an acc_vat_periods row. Idempotent.
CREATE OR REPLACE FUNCTION public.acc_ensure_current_vat_periods()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur_year    integer := extract(year  FROM current_date)::integer;
  cur_month   integer := extract(month FROM current_date)::integer;
  cur_quarter integer := ((cur_month - 1) / 3) + 1;
BEGIN
  INSERT INTO public.acc_vat_periods (year, quarter, status, deadline)
  SELECT cur_year, q, 'open', public.acc_vat_filing_deadline(cur_year, q)
  FROM generate_series(1, cur_quarter) AS q
  ON CONFLICT (year, quarter) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acc_vat_filing_deadline(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acc_ensure_current_vat_periods() TO authenticated;
