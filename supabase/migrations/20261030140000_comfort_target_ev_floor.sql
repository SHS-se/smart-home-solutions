-- The car's comfort input is now a safety floor. The top of its range is the
-- car's own charge limit, reported with every snapshot, so ev_target_soc is no
-- longer read for planning.
ALTER TABLE public.energy_optimisation_comfort_targets
  ADD COLUMN ev_floor_soc numeric NOT NULL DEFAULT 30 CHECK (ev_floor_soc BETWEEN 0 AND 100);
