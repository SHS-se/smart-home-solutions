-- The pool's heat loss, fitted on its own from the stretches nothing heated it.
--
-- `loss_kw_per_k` comes out of the joint loss-and-COP regression, which refuses
-- until the heat pump has run across a spread of air temperatures. That can
-- take a season, and meanwhile the planner used its seeded 0.35 kW/K for a pool
-- whose unheated nights measured 0.07–0.16 kW/K. Believing the pool leaks
-- several times faster than it does made early heat look wasted, so the
-- planner stopped a running pool and deferred its heat to the end of the
-- horizon.
--
-- The idle fit needs only idle nights, so it is written beside the joint fit
-- rather than into it: the two can succeed and refuse independently, and the
-- planner prefers the idle loss whenever it has one.
ALTER TABLE public.energy_optimisation_pool_model
  ADD COLUMN idle_loss_kw_per_k numeric
    CHECK (idle_loss_kw_per_k IS NULL OR (idle_loss_kw_per_k > 0 AND idle_loss_kw_per_k < 20)),
  ADD COLUMN idle_loss_hours numeric NOT NULL DEFAULT 0,
  ADD COLUMN idle_loss_run_count integer NOT NULL DEFAULT 0,
  ADD COLUMN idle_loss_rejection text,
  ADD CONSTRAINT energy_pool_model_idle_loss_fitted_or_rejected
    CHECK (idle_loss_kw_per_k IS NULL OR idle_loss_rejection IS NULL);

COMMENT ON COLUMN public.energy_optimisation_pool_model.idle_loss_kw_per_k IS
  'Net heat loss in kW per K of water-to-air difference, from settled unheated '
  'stretches. Preferred by the planner over the joint fit''s loss_kw_per_k.';
