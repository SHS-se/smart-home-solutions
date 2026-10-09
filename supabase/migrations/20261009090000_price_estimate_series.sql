-- The price estimates quarter by quarter, beside the real prices of the same
-- days, so the staff accuracy view can draw an estimate against what the market
-- then published. It replaces get_price_estimate_accuracy, which returned only
-- each day's means: the view now works every figure out from the quarters it
-- draws, so its table and its chart cannot disagree.
--
-- `estimates`: one row per home, local day estimated on and local day estimated
-- for, with the 96 estimated quarters (null where published or outside the plan).
-- `actuals`: the published import price per home and local day, 96 quarters,
-- null where the market has not published. It covers the days estimates were
-- made on as well, so the view can show what was known at the time.

DROP FUNCTION IF EXISTS public.get_price_estimate_accuracy(integer);

CREATE OR REPLACE FUNCTION public.get_price_estimate_series(p_days integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from date := current_date - GREATEST(1, LEAST(p_days, 365));
  v_estimates jsonb;
  v_actuals jsonb;
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Price estimate accuracy is staff-only' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'home_id', e.home_id, 'home_name', h.name, 'issued_on', e.issued_on, 'issued_at', e.issued_at,
      'target_day', e.target_day, 'basis', e.basis, 'timezone', e.timezone, 'quarters', e.quarters
    ) ORDER BY e.home_id, e.issued_on, e.target_day), '[]'::jsonb)
  INTO v_estimates
  FROM public.energy_price_estimate_days AS e
  JOIN public.homes AS h ON h.id = e.home_id
  WHERE e.target_day >= v_from;

  WITH spans AS (
    SELECT e.home_id, min(e.timezone) AS timezone, min(e.issued_on) AS first_day, max(e.target_day) AS last_day
    FROM public.energy_price_estimate_days AS e
    WHERE e.target_day >= v_from
    GROUP BY e.home_id
  ),
  slots AS (
    SELECT p.home_id,
           (p.start_ts AT TIME ZONE s.timezone)::date AS local_day,
           (extract(hour FROM p.start_ts AT TIME ZONE s.timezone) * 4
             + floor(extract(minute FROM p.start_ts AT TIME ZONE s.timezone) / 15))::integer AS quarter,
           avg(p.import_price_sek_per_kwh)::numeric AS price
    FROM public.energy_optimisation_price_slots AS p
    JOIN spans AS s ON s.home_id = p.home_id
    WHERE p.start_ts >= (s.first_day - 1)::timestamptz
      AND p.start_ts < (s.last_day + 2)::timestamptz
      AND p.import_price_sek_per_kwh IS NOT NULL
    GROUP BY 1, 2, 3
  ),
  days AS (
    SELECT k.home_id, k.local_day, jsonb_agg(round(s.price, 4) ORDER BY g.quarter) AS quarters
    FROM (SELECT DISTINCT d.home_id, d.local_day FROM slots AS d) AS k
    JOIN spans AS sp ON sp.home_id = k.home_id AND k.local_day BETWEEN sp.first_day AND sp.last_day
    CROSS JOIN generate_series(0, 95) AS g(quarter)
    LEFT JOIN slots AS s ON s.home_id = k.home_id AND s.local_day = k.local_day AND s.quarter = g.quarter
    GROUP BY k.home_id, k.local_day
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('home_id', d.home_id, 'day', d.local_day, 'quarters', d.quarters)
    ORDER BY d.home_id, d.local_day), '[]'::jsonb)
  INTO v_actuals
  FROM days AS d;

  RETURN jsonb_build_object('estimates', v_estimates, 'actuals', v_actuals);
END;
$$;

REVOKE ALL ON FUNCTION public.get_price_estimate_series(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_price_estimate_series(integer) TO authenticated;
