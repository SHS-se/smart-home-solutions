-- What the home's base load was forecast to be, beside what it then was, per
-- local day: the evidence the planner levels its base-load forecast to and
-- sizes its demand margin from (_shared/planner/demand-outlook.ts).
--
-- Forecast: the last forecast archived in the 24 hours before the day began
-- (energy_optimisation_forecast_runs), summed over the day's quarters. Actual:
-- measured load less the devices planned on their own (pool, hot water, car),
-- which is what Home Assistant's base-load forecast describes. A day counts
-- only when every quarter of it was both forecast and measured; a day whose
-- device meters add up to more than the house drew is left out.
--
-- Computed here rather than in the edge function so a plan reads a few dozen
-- small rows, not a month of archived forecast series.

CREATE OR REPLACE FUNCTION public.energy_optimisation_demand_days(
  p_home_id uuid,
  p_timezone text,
  p_until timestamptz DEFAULT now(),
  p_days integer DEFAULT 28
)
RETURNS TABLE (day date, forecast_kwh numeric, actual_kwh numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH days AS (
    SELECT d::date AS day,
           d::timestamp AT TIME ZONE p_timezone AS day_start,
           (d + interval '1 day')::timestamp AT TIME ZONE p_timezone AS day_end
    FROM generate_series(
      ((p_until AT TIME ZONE p_timezone)::date - GREATEST(1, LEAST(p_days, 60)))::timestamp,
      ((p_until AT TIME ZONE p_timezone)::date - 1)::timestamp,
      interval '1 day'
    ) AS d
  ),
  actual AS (
    SELECT d.day, count(*) AS quarters,
           sum(a.total_load_kwh - coalesce(a.pool_heating_kwh, 0) - coalesce(a.hot_water_kwh, 0) - coalesce(a.ev_charging_kwh, 0)) AS kwh,
           count(*) FILTER (
             WHERE a.total_load_kwh - coalesce(a.pool_heating_kwh, 0) - coalesce(a.hot_water_kwh, 0) - coalesce(a.ev_charging_kwh, 0) < -0.05
           ) AS negative
    FROM days AS d
    JOIN public.energy_optimisation_actual_slots AS a
      ON a.home_id = p_home_id AND a.start_ts >= d.day_start AND a.start_ts < d.day_end AND a.total_load_kwh IS NOT NULL
    GROUP BY d.day
  ),
  forecast AS (
    SELECT d.day, f.kwh, f.quarters
    FROM days AS d
    CROSS JOIN LATERAL (
      SELECT r.horizon_start, r.series
      FROM public.energy_optimisation_forecast_runs AS r
      WHERE r.home_id = p_home_id AND r.slot_minutes = 15
        AND r.issued_at < d.day_start AND r.issued_at >= d.day_start - interval '24 hours'
      ORDER BY r.issued_at DESC
      LIMIT 1
    ) AS run
    CROSS JOIN LATERAL (
      SELECT sum((q.value #>> '{}')::numeric) / 4000 AS kwh, count(*) AS quarters
      FROM jsonb_array_elements(run.series -> 'base_load_forecast_w') WITH ORDINALITY AS q(value, ordinality)
      WHERE jsonb_typeof(q.value) = 'number'
        AND run.horizon_start + (q.ordinality - 1) * interval '15 minutes' >= d.day_start
        AND run.horizon_start + (q.ordinality - 1) * interval '15 minutes' < d.day_end
    ) AS f
  )
  SELECT d.day, round(f.kwh, 3), round(a.kwh, 3)
  FROM days AS d
  JOIN forecast AS f USING (day)
  JOIN actual AS a USING (day)
  WHERE a.quarters = extract(epoch FROM d.day_end - d.day_start) / 900
    AND f.quarters = a.quarters
    AND a.negative <= 2
    AND f.kwh > 0 AND a.kwh > 0
  ORDER BY d.day;
$$;

REVOKE ALL ON FUNCTION public.energy_optimisation_demand_days(uuid, text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.energy_optimisation_demand_days(uuid, text, timestamptz, integer) TO service_role;
