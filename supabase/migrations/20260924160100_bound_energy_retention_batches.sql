-- A retention backlog must not become an unbounded transaction on ingestion.
CREATE OR REPLACE FUNCTION public.prune_energy_optimisation_data(p_home_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.energy_optimisation_actual_slots WHERE id IN (
    SELECT id FROM public.energy_optimisation_actual_slots
    WHERE home_id = p_home_id AND start_ts < now() - interval '1095 days'
    ORDER BY start_ts, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM public.energy_optimisation_pool_slots WHERE id IN (
    SELECT id FROM public.energy_optimisation_pool_slots
    WHERE home_id = p_home_id AND start_ts < now() - interval '1095 days'
    ORDER BY start_ts, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM public.energy_optimisation_device_slots WHERE id IN (
    SELECT id FROM public.energy_optimisation_device_slots
    WHERE home_id = p_home_id AND start_ts < now() - interval '400 days'
    ORDER BY start_ts, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM public.energy_optimisation_plan_runs WHERE id IN (
    SELECT id FROM public.energy_optimisation_plan_runs
    WHERE home_id = p_home_id AND issued_at < now() - interval '400 days'
    ORDER BY issued_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM public.energy_optimisation_forecast_runs WHERE id IN (
    SELECT id FROM public.energy_optimisation_forecast_runs
    WHERE home_id = p_home_id AND issued_at < now() - interval '400 days'
    ORDER BY issued_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED
  );
END;
$$;
