-- Re-price battery wear for a pack the calendar retires, not the cycle count.
--
-- The shipped 0.45 SEK/kWh came from "purchase price divided by warranted
-- lifetime throughput", which is the right formula for a battery consumed by
-- cycling. It is the wrong one for every LFP pack now being installed, because
-- their rated cycle life cannot be reached inside the warranty term.
--
-- Sigen Battery 10.0, the pack this was measured against: 10,000 cycles rated
-- (cell-level, 25 degrees C, 0.5C, to SOH=60%), 100% depth of discharge, ten
-- year warranty with no throughput limit. Exhausting 10,000 cycles by 2036
-- needs about 49.5 kWh a day through the pack. The home's entire non-flexible
-- base load is roughly 16 kWh a day, so even a battery that served all of it
-- every day of the year reaches a third of the rating. Measured across the
-- planner's whole wear range on live capsule `eb2ffa5e`, throughput moves only
-- between 110 and 147 equivalent full cycles a year -- 11% to 15% of the
-- rating either way. The pack will retire on the calendar with the large
-- majority of its cycle life unspent.
--
-- What the figure actually controls is the minimum price spread the battery
-- will accept: it declines any round trip that does not clear
-- `buy / (charge x discharge) + wear / discharge`. At 0.45 that demanded an
-- evening 66% dearer than the night, which left the four dearest quarters of
-- 2026-08-29 on the grid at 2.19-2.21 SEK/kWh. At 0.05 it demands 17%, still
-- comfortably clear of the ~11% pure round-trip efficiency floor -- and that
-- margin is now doing the job it should be doing, which is insuring against
-- price-forecast error beyond the day-ahead window rather than against
-- degradation that will not happen. Worth about 950 SEK a year on a flat
-- summer horizon, more in winter when spreads widen.
--
-- A customer whose pack really is throughput-limited should still carry their
-- own number; this only moves the default and the homes that never changed it.
ALTER TABLE public.energy_optimisation_value_settings
  ALTER COLUMN battery_degradation_sek_per_kwh SET DEFAULT 0.05;

COMMENT ON COLUMN
  public.energy_optimisation_value_settings.battery_degradation_sek_per_kwh IS
  'Wear cost per kWh stored, SEK. Sets the minimum price spread the battery '
  'will trade on. Near zero for a pack whose warranty is bounded by the '
  'calendar and whose rated cycle life is unreachable; purchase price divided '
  'by warranted throughput only where cycling is what retires the pack.';

-- Only the homes still sitting on the old shipped default. A row someone has
-- deliberately set is that household's own figure and is left alone.
UPDATE public.energy_optimisation_value_settings
  SET battery_degradation_sek_per_kwh = 0.05,
      updated_at = now()
  WHERE battery_degradation_sek_per_kwh = 0.45;
