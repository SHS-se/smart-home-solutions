-- Archive forecasts as they were issued, and stop deleting the measured
-- history the seasonal replay depends on.
--
-- ENERGY_OPTIMISATION_ARCHITECTURE.md §8.11 judges the objective with three
-- runs over the same period: perfect foresight, the forecasts *as they stood at
-- each decision time*, and the measured baseline. The second run was
-- impossible. `energy_optimisation_current` holds one row per home and is
-- overwritten every cycle, and `energy_optimisation_plan_runs` keeps only a
-- compact summary — so every PV, weather and price forecast was discarded
-- within fifteen minutes of being issued. A forecast archive cannot be
-- backfilled: a forecast that was not stored is gone permanently, which is why
-- this starts collecting before the planner that will be judged by it exists.
--
-- One row per issue, holding the whole horizon as jsonb, at most one per hour.
-- Storing each of the 288 slots as its own row at a fifteen-minute replan
-- cadence would write about ten million rows per home per year to answer a
-- question that hourly issue resolution answers just as well.

CREATE TABLE public.energy_optimisation_forecast_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL,
  issued_hour timestamptz NOT NULL,
  horizon_start timestamptz NOT NULL,
  slot_minutes integer NOT NULL CHECK (slot_minutes > 0),
  -- Per slot: start, pv_forecast_w, base_load_forecast_w, outdoor_temperature_c
  -- and the all-in prices. Deliberately the forecast inputs only: what the plan
  -- decided is already in energy_optimisation_plan_runs, and mixing the two
  -- would let a replay read a decision back as though it were an input.
  slots jsonb NOT NULL,
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, issued_hour),
  CONSTRAINT energy_forecast_runs_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);

CREATE INDEX idx_energy_forecast_runs_home_issued
  ON public.energy_optimisation_forecast_runs (home_id, issued_at DESC);

ALTER TABLE public.energy_optimisation_forecast_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own forecast archive"
  ON public.energy_optimisation_forecast_runs FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

-- Retention. The old rule deleted measured quarters after 120 days, which
-- silently destroyed exactly the seasonal evidence §8.11 replays: on the day
-- this migration was written, everything before mid-April 2026 had already
-- gone. A product whose claim is year-over-year savings cannot keep four
-- months of history. Measured quarters are cheap — roughly 35k rows per home
-- per year — so they are kept for three years, and the forecast archive for
-- long enough to study forecast error across a full cycle of seasons.
CREATE OR REPLACE FUNCTION public.prune_energy_optimisation_data(p_home_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.energy_optimisation_actual_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '1095 days';

  DELETE FROM public.energy_optimisation_device_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '1095 days';

  DELETE FROM public.energy_optimisation_plan_runs
  WHERE home_id = p_home_id AND issued_at < now() - interval '400 days';

  DELETE FROM public.energy_optimisation_forecast_runs
  WHERE home_id = p_home_id AND issued_at < now() - interval '400 days';
END;
$$;

REVOKE ALL ON FUNCTION public.prune_energy_optimisation_data(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_energy_optimisation_data(uuid)
  TO service_role;
