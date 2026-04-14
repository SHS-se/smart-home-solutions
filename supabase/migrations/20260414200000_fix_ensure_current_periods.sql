-- Fix acc_ensure_current_periods() so it only creates months from January of the
-- current year up to and including the current month. The previous version also
-- created the *next* month, which caused future periods (e.g. May in April) to
-- appear unexpectedly.
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
