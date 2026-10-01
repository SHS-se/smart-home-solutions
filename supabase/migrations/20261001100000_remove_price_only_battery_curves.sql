-- The `price_only` battery curve mode is removed: the battery's curve is the
-- planner's own balanced derivation every plan, unless the home keeps an
-- explicit custom curve. Its search results were a cache for that mode only.
UPDATE public.energy_optimisation_value_curves
  SET generation_mode = 'balanced'
  WHERE generation_mode = 'price_only';

ALTER TABLE public.energy_optimisation_value_curves
  DROP CONSTRAINT IF EXISTS energy_optimisation_value_curves_generation_mode_check;
ALTER TABLE public.energy_optimisation_value_curves
  ADD CONSTRAINT energy_optimisation_value_curves_generation_mode_check
  CHECK (generation_mode IN ('custom', 'balanced'));

DROP TABLE IF EXISTS public.energy_optimisation_battery_cost_curves;
DROP FUNCTION IF EXISTS public.guard_battery_cost_curve_update();
DROP FUNCTION IF EXISTS public.prune_battery_cost_curves();
