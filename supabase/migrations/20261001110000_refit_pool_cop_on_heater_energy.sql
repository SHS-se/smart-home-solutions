-- The pool's COP was fitted on pump + heater energy and applied to both. The
-- pump only circulates water, so the planner now applies the COP to the
-- heater's power and the fit reads the heater's energy alone. A COP fitted on
-- the old basis would be applied twice over; clear it, and the next plan
-- refits. The idle-loss fit does not depend on the heater and is kept.
UPDATE public.energy_optimisation_pool_model
  SET rated_cop = NULL, cop_per_air_c = NULL, loss_kw_per_k = NULL
  WHERE rated_cop IS NOT NULL;
