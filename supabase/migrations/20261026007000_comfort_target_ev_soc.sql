-- The car's comfort target is a battery state of charge, not a range. The
-- planner still plans in kilometres: the ingest converts this percentage with
-- the car's capacity and consumption from the home's snapshot. ev_target_km is
-- no longer read for planning.
ALTER TABLE public.energy_optimisation_comfort_targets
  ADD COLUMN ev_target_soc numeric NOT NULL DEFAULT 80 CHECK (ev_target_soc BETWEEN 0 AND 100);
