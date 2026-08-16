-- Archive forecasts as they were issued, and bound the measured history the
-- seasonal replay depends on.
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
-- Two decisions keep it small enough to run for a fleet.
--
-- **Six-hourly, not hourly.** The numerical weather models behind a PV forecast
-- run four times a day (00/06/12/18Z). Archiving more often than that mostly
-- stores interpolation between the same two model runs, so it costs storage
-- linearly and adds very little independent evidence. Four issues a day still
-- samples every lead from zero to seventy-two hours.
--
-- **Parallel arrays, not per-slot objects.** The slot timestamps are implied by
-- `horizon_start` and `slot_minutes`, and one key per series replaces 288
-- repetitions of it. Together these are roughly a fifteenfold reduction against
-- an hourly archive of per-slot objects, which worked out at about 26 GB a year
-- across a few hundred homes.

CREATE TABLE public.energy_optimisation_forecast_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL,
  -- The 6-hour window this issue represents; one row per window per home.
  issued_bucket timestamptz NOT NULL,
  horizon_start timestamptz NOT NULL,
  slot_minutes integer NOT NULL CHECK (slot_minutes > 0),
  slot_count integer NOT NULL CHECK (slot_count > 0),
  -- Parallel arrays, each `slot_count` long, indexed from `horizon_start`.
  -- Deliberately the forecast inputs only: what the plan decided is already in
  -- energy_optimisation_plan_runs, and mixing the two would let a replay read a
  -- decision back as though it were an input.
  series jsonb NOT NULL,
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, issued_bucket),
  CONSTRAINT energy_forecast_runs_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);

CREATE INDEX idx_energy_forecast_runs_home_issued
  ON public.energy_optimisation_forecast_runs (home_id, issued_at DESC);

ALTER TABLE public.energy_optimisation_forecast_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own forecast archive"
  ON public.energy_optimisation_forecast_runs FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

-- Retention, sized per table rather than uniformly.
--
-- The old rule deleted everything after 120 days, which silently destroyed
-- exactly the seasonal evidence §8.11 replays: on the day this was written,
-- everything before mid-April 2026 had already gone. A product whose claim is
-- year-over-year savings cannot keep four months of history.
--
-- The three tables are not the same size, so they do not get the same rule.
-- Whole-home quarters are about 35k rows per home per year and are the most
-- valuable record there is, so they are kept for three years. Device quarters
-- are the bulky one — one row per device per quarter, so roughly twenty times
-- larger — and are kept for 400 days: a full seasonal cycle plus margin for
-- year-over-year comparison, without growing without bound across a fleet.
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
  WHERE home_id = p_home_id AND start_ts < now() - interval '400 days';

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
