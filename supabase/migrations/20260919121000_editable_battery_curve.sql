-- A battery row is an exact customer override; deleting it selects automatic valuation.
ALTER TABLE public.energy_optimisation_value_curves
  DROP CONSTRAINT energy_optimisation_value_curves_store_key_check;
ALTER TABLE public.energy_optimisation_value_curves
  ADD CONSTRAINT energy_optimisation_value_curves_store_key_check
  CHECK (store_key IN ('pool', 'ev', 'hot_water', 'battery'));
