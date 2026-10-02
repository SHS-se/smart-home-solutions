-- What the pool's water temperature was measured to do, by the temperature it
-- was at: how fast the unheated reading fell, and what a kWh into the heater
-- added to it.
--
-- One loss coefficient and one COP say a pool cools in proportion to how much
-- warmer it is than the air and that a kWh always buys the same heat. Phil's
-- does neither below about 29 °C: over 20 to 27 September 2026 it cooled at
-- 0.04 °C/h above 29 °C and 0.015 °C/h just below it, and a heater kWh raised
-- it 0.07 to 0.10 °C above 29 °C and 0.03 °C below. The planner had no way to
-- know either, so it expected to pay for heat the pool did not lose and to be
-- given heat the pool did not show.
--
-- Kept as measured, one entry per quarter-degree bin
-- ({at_c, idle_c_per_h, idle_hours, heat_c_per_kwh, heated_kwh}), refitted with
-- the rest of the pool model. Empty until a refit has run.
ALTER TABLE public.energy_optimisation_pool_model
  ADD COLUMN response jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(response) = 'array');

COMMENT ON COLUMN public.energy_optimisation_pool_model.response IS
  'Measured water-temperature response per 0.25 °C bin: idle cooling rate and '
  'warming per heater kWh. Preferred by the planner over the loss coefficient '
  'and the COP wherever a bin measured it.';

-- The standing fits were made from reads cut off at one page of rows, which
-- made heated quarters look idle and refused the loss fit. Make every home's
-- next plan refit instead of waiting out the interval.
UPDATE public.energy_optimisation_pool_model SET fitted_at = 'epoch';
