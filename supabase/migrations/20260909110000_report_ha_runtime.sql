-- Acceptance is historical. This leased report describes current HA readiness.
ALTER TABLE public.energy_optimisation_current
  ADD COLUMN ha_runtime jsonb,
  ADD COLUMN ha_runtime_received_at timestamptz;

CREATE FUNCTION public.report_energy_runtime(p_home_id uuid, p_runtime jsonb)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH reported AS (
  UPDATE public.energy_optimisation_current
  SET ha_runtime = p_runtime, ha_runtime_received_at = clock_timestamp()
  WHERE home_id = p_home_id
    AND (ha_runtime IS NULL OR
      (ha_runtime->>'observed_at')::timestamptz < (p_runtime->>'observed_at')::timestamptz)
  RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM reported);
$$;
REVOKE ALL ON FUNCTION public.report_energy_runtime(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_energy_runtime(uuid, jsonb) TO service_role;
