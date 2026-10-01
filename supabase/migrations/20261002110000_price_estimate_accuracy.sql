-- What each plan estimated electricity would cost on days the market had not
-- yet published, kept so the estimate can be checked against the prices once
-- they are. Staff only: this is for watching the estimator, not for customers.
--
-- One row per home, per local day the estimate was made on, per local day it
-- is for. Every plan of the day overwrites it until the market publishes that
-- day, so the row holds the last estimate made before the real prices existed.

CREATE TABLE IF NOT EXISTS public.energy_price_estimate_days (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  issued_on date NOT NULL,
  target_day date NOT NULL,
  timezone text NOT NULL,
  -- Import SEK/kWh per quarter of the local day (0 = 00:00), null where the
  -- quarter was outside the plan or already published.
  quarters jsonb NOT NULL CHECK (jsonb_typeof(quarters) = 'array' AND jsonb_array_length(quarters) = 96),
  -- What set the day's level: 'wind', 'recent_norm' or 'published'.
  basis text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (home_id, issued_on, target_day),
  CHECK (target_day >= issued_on)
);

ALTER TABLE public.energy_price_estimate_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_price_estimate_days FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.energy_price_estimate_days TO service_role;

-- Each estimate beside what the day then cost, for the last p_days days.
-- Rows whose day is not fully published yet have no actual and no error.
CREATE OR REPLACE FUNCTION public.get_price_estimate_accuracy(p_days integer DEFAULT 60)
RETURNS TABLE (
  home_id uuid,
  issued_on date,
  target_day date,
  lead_days integer,
  basis text,
  quarters integer,
  estimated_sek_per_kwh numeric,
  actual_sek_per_kwh numeric,
  quarter_mae_sek_per_kwh numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Price estimate accuracy is staff-only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH estimates AS (
    SELECT e.home_id, e.issued_on, e.target_day, e.basis, e.timezone,
           (q.ordinality - 1)::integer AS quarter, (q.value #>> '{}')::numeric AS estimated
    FROM public.energy_price_estimate_days AS e
    CROSS JOIN LATERAL jsonb_array_elements(e.quarters) WITH ORDINALITY AS q(value, ordinality)
    WHERE e.target_day >= current_date - GREATEST(1, LEAST(p_days, 365))
      AND jsonb_typeof(q.value) = 'number'
  ),
  actuals AS (
    SELECT p.home_id,
           (p.start_ts AT TIME ZONE t.timezone)::date AS local_day,
           (extract(hour FROM p.start_ts AT TIME ZONE t.timezone) * 4
             + floor(extract(minute FROM p.start_ts AT TIME ZONE t.timezone) / 15))::integer AS quarter,
           avg(p.import_price_sek_per_kwh)::numeric AS actual
    FROM public.energy_optimisation_price_slots AS p
    JOIN (SELECT DISTINCT d.home_id, d.timezone FROM public.energy_price_estimate_days AS d) AS t
      ON t.home_id = p.home_id
    WHERE p.start_ts >= (current_date - GREATEST(1, LEAST(p_days, 365)) - 1)::timestamptz
      AND p.import_price_sek_per_kwh IS NOT NULL
    GROUP BY 1, 2, 3
  )
  SELECT e.home_id, e.issued_on, e.target_day, (e.target_day - e.issued_on)::integer, e.basis,
         count(*)::integer,
         round(avg(e.estimated), 4),
         -- Only once every estimated quarter has a real price beside it.
         CASE WHEN count(a.actual) = count(*) THEN round(avg(a.actual), 4) END,
         CASE WHEN count(a.actual) = count(*) THEN round(avg(abs(e.estimated - a.actual)), 4) END
  FROM estimates AS e
  LEFT JOIN actuals AS a
    ON a.home_id = e.home_id AND a.local_day = e.target_day AND a.quarter = e.quarter
  GROUP BY e.home_id, e.issued_on, e.target_day, e.basis
  ORDER BY e.target_day DESC, e.issued_on DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_price_estimate_accuracy(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_price_estimate_accuracy(integer) TO authenticated;
