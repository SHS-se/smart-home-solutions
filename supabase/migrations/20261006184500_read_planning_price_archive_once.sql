-- One complete raw archive read, without REST's per-page result limit or
-- repeated round trips. Selection and ordering match the existing planner read.
CREATE FUNCTION public.read_energy_planning_price_archive(p_home_id uuid, p_from timestamptz)
RETURNS json
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT coalesce(json_agg(prices ORDER BY prices.start_ts), '[]'::json)
  FROM (
    SELECT start_ts, import_price_sek_per_kwh
    FROM public.energy_optimisation_price_slots
    WHERE home_id = p_home_id AND start_ts >= p_from
  ) AS prices;
$$;

REVOKE ALL ON FUNCTION public.read_energy_planning_price_archive(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_energy_planning_price_archive(uuid,timestamptz) TO service_role;
