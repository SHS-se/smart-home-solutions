-- Function that ensures every month from January of the current year up to and
-- including the current month has an acc_period row.
-- Idempotent: uses ON CONFLICT DO NOTHING so calling it multiple times is safe.
-- Called from the frontend each time the Fiscal Years & Periods page loads.
CREATE OR REPLACE FUNCTION public.acc_ensure_current_periods()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur_year  integer := extract(year  FROM current_date)::integer;
  cur_month integer := extract(month FROM current_date)::integer;
BEGIN
  INSERT INTO public.acc_periods (year, month, status)
  SELECT cur_year, m, 'open'
  FROM generate_series(1, cur_month) AS m
  ON CONFLICT (year, month) DO NOTHING;
END;
$$;

-- Grant execute to authenticated users (RLS on acc_periods still applies for writes,
-- but the SECURITY DEFINER context bypasses it for this insert-only operation).
GRANT EXECUTE ON FUNCTION public.acc_ensure_current_periods() TO authenticated;
