-- Function that ensures the current and next calendar month have an acc_period row.
-- Idempotent: uses ON CONFLICT DO NOTHING so calling it multiple times is safe.
-- Called from the frontend each time the Fiscal Years & Periods page loads.
CREATE OR REPLACE FUNCTION public.acc_ensure_current_periods()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today        date    := current_date;
  cur_year     integer := extract(year  FROM today)::integer;
  cur_month    integer := extract(month FROM today)::integer;
  next_year    integer;
  next_month   integer;
BEGIN
  -- Next month (wraps December → January of the following year)
  IF cur_month = 12 THEN
    next_year  := cur_year + 1;
    next_month := 1;
  ELSE
    next_year  := cur_year;
    next_month := cur_month + 1;
  END IF;

  INSERT INTO public.acc_periods (year, month, status)
  VALUES
    (cur_year,  cur_month,  'open'),
    (next_year, next_month, 'open')
  ON CONFLICT (year, month) DO NOTHING;
END;
$$;

-- Grant execute to authenticated users (RLS on acc_periods still applies for writes,
-- but the SECURITY DEFINER context bypasses it for this insert-only operation).
GRANT EXECUTE ON FUNCTION public.acc_ensure_current_periods() TO authenticated;
