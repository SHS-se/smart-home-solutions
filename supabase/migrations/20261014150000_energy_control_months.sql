-- Which months SHS was actually in control of a home, for the savings track
-- record. Every planning run records the operating mode of each device it
-- planned (summary.operating_modes, from 2026-10-14). This totals them per local
-- month, so the browser receives a dozen rows instead of thousands of runs.
CREATE OR REPLACE FUNCTION public.get_energy_control_months(
  p_customer_id uuid, p_home_id uuid, p_from timestamptz, p_to timestamptz, p_time_zone text)
RETURNS TABLE(month_key text, runs integer, controlling jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT coalesce(public.energy_home_matches_customer(p_home_id, p_customer_id), false)
    OR (auth.role() IS DISTINCT FROM 'service_role'
      AND NOT coalesce(public.can_access_energy_billing_customer(p_customer_id), false)) THEN
    RAISE EXCEPTION 'Energy control history access denied';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '400 days'
    OR p_time_zone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_time_zone) THEN
    RAISE EXCEPTION 'Choose a time zone and at most 400 days';
  END IF;
  RETURN QUERY
  WITH recorded AS (
    SELECT to_char(r.issued_at AT TIME ZONE p_time_zone, 'YYYY-MM') AS m, r.summary->'operating_modes' AS modes
    FROM public.energy_optimisation_plan_runs r
    WHERE r.home_id = p_home_id AND r.customer_id = p_customer_id
      AND r.issued_at >= p_from AND r.issued_at < p_to
      AND jsonb_typeof(r.summary->'operating_modes') = 'object'
  ), per_device AS (
    SELECT recorded.m, mode.key AS device, count(*)::integer AS n
    FROM recorded, jsonb_each_text(recorded.modes) AS mode
    WHERE mode.value = 'controlling'
    GROUP BY recorded.m, mode.key
  )
  SELECT recorded.m, count(*)::integer,
    coalesce((SELECT jsonb_object_agg(p.device, p.n) FROM per_device p WHERE p.m = recorded.m), '{}'::jsonb)
  FROM recorded GROUP BY recorded.m ORDER BY recorded.m;
END $$;

REVOKE ALL ON FUNCTION public.get_energy_control_months(uuid, uuid, timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_control_months(uuid, uuid, timestamptz, timestamptz, text) TO authenticated, service_role;
