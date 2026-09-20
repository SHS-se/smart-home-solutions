-- The air temperature below which the pool's heat pump cannot run.
--
-- The planner seeded this at 8 °C for every home, which is an assertion that
-- the machine is air-source — and an assertion that fails silently in the one
-- direction that matters. Below a cut-out `poolCop` returns zero, so the pool's
-- value per kWh is zero and no price makes heating schedulable; a store that
-- never bids is indistinguishable from a store that was outbid. A ground-source
-- unit has no cut-out at all, so the seed stopped its pool being planned for
-- most of a Swedish year and reported nothing while doing so.
--
-- Null — the default, and every existing row — means no cut-out is on record,
-- and the planner then applies none. That is the honest reading: the absence of
-- a measurement is not a measurement of zero, and the failure mode of assuming
-- no cut-out (planning heat a cold air-source unit cannot deliver, which shows
-- up immediately as a missed projection) is louder than the failure mode of
-- assuming one.
--
-- Like `heat_pump_epoch_start` this lives on the fit's row but is not written
-- by `refitPoolModel`, so a value recorded here survives every refit. It may
-- arrive from a fit that has evidence for it, or as a commissioning fact
-- (§9.1) stated by staff. It is never inferred from the class of machine.
ALTER TABLE public.energy_optimisation_pool_model
  ADD COLUMN cutout_air_c numeric
    CHECK (cutout_air_c IS NULL OR cutout_air_c BETWEEN -40 AND 30);

COMMENT ON COLUMN public.energy_optimisation_pool_model.cutout_air_c IS
  'Air temperature below which the pool heat pump cannot run. Null means none '
  'is on record and the planner applies no cut-out. Not written by the refit, '
  'so a recorded value survives it.';
