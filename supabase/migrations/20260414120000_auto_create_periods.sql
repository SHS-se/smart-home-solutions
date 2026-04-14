-- Function that ensures the current calendar month has an acc_period row.
-- Idempotent: uses ON CONFLICT DO NOTHING so calling it multiple times is safe.
-- Called from the frontend each time the Fiscal Years & Periods page loads.
CREATE OR REPLACE FUNCTION public.acc_ensure_current_periods()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today     date    := current_date;
  cur_year  integer := extract(year  FROM today)::integer;
  cur_month integer := extract(month FROM today)::integer;
BEGIN
  INSERT INTO public.acc_periods (year, month, status)
  VALUES (cur_year, cur_month, 'open')
  ON CONFLICT (year, month) DO NOTHING;
END;
$$;

-- Grant execute to authenticated users (RLS on acc_periods still applies for writes,
-- but the SECURITY DEFINER context bypasses it for this insert-only operation).
GRANT EXECUTE ON FUNCTION public.acc_ensure_current_periods() TO authenticated;
