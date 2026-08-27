-- When the pool's current heat pump began serving the pool.
--
-- The fit's training window is a rolling 21 days, which assumes the machine at
-- the end of it is the machine at the start. Replacing a pool heat pump breaks
-- that assumption, and the blend does not fail loudly: the cooling term
-- explains most of the variance unaided, so a window straddling two units
-- clears the R² gate and stores a confident COP for a machine that never
-- existed. Samples before this instant describe different hardware and are
-- excluded from the fit whatever the rolling window would otherwise admit.
--
-- This is a commissioning fact (§9.1, "hard installation"), stated by staff and
-- never inferred: detecting a machine change from its own output is exactly the
-- kind of rule §8 refuses to write. Null means no changeover is on record and
-- the rolling window stands alone, which is every home that has never had one.
--
-- It lives on the fit's own row rather than with the pool's configuration
-- because what it records is the range over which a fit is valid, not a
-- property of the pool. `refitPoolModel` never writes it, so an upsert of a
-- fresh fit leaves it in place.
ALTER TABLE public.energy_optimisation_pool_model
  ADD COLUMN heat_pump_epoch_start timestamptz;

COMMENT ON COLUMN public.energy_optimisation_pool_model.heat_pump_epoch_start IS
  'Commissioning instant of the current pool heat pump. Training samples before '
  'it describe different hardware and are excluded from the fit. Null when no '
  'changeover is on record.';
