-- The pool's fitted heat loss and heat-pump COP.
--
-- ENERGY_OPTIMISATION_ARCHITECTURE.md §8.10 lists both as learned rather than
-- asked for, because neither can honestly be entered: a pool's real loss is
-- dominated by evaporation and cover habits, and a heat pump's COP in place is
-- not its datasheet figure.
--
-- Nullable parameters with a rejection reason beside them, the same shape as
-- energy_optimisation_zone_models. A refused fit is the normal state for months
-- at a time — an unheated August identifies no COP at all — so the row records
-- *why* and the planner falls back to its seeded values rather than treating
-- the absence as an error.

CREATE TABLE public.energy_optimisation_pool_model (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  fitted_at timestamptz NOT NULL DEFAULT now(),
  -- kW per °C of water-to-air difference.
  loss_kw_per_k numeric CHECK (loss_kw_per_k IS NULL
    OR (loss_kw_per_k > 0 AND loss_kw_per_k < 20)),
  -- Heat delivered per kW of electricity, at the reference air temperature.
  rated_cop numeric CHECK (rated_cop IS NULL OR (rated_cop > 1 AND rated_cop < 12)),
  -- Fractional change in COP per °C of air above the reference.
  cop_per_air_c numeric CHECK (cop_per_air_c IS NULL OR abs(cop_per_air_c) <= 0.2),
  -- Everything heating the water that is neither the pump nor the air: sun on
  -- the surface, ground contact. Carried because omitting it pushes the same
  -- energy into the loss coefficient and biases it low.
  background_kw numeric,
  r2 numeric,
  sample_count integer NOT NULL DEFAULT 0,
  heated_sample_count integer NOT NULL DEFAULT 0,
  rejection text,
  CONSTRAINT energy_pool_model_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  -- Either a usable fit or a stated reason, never a silent half-answer.
  CONSTRAINT energy_pool_model_fitted_or_rejected CHECK (
    (rejection IS NOT NULL)
    OR (loss_kw_per_k IS NOT NULL AND rated_cop IS NOT NULL
        AND cop_per_air_c IS NOT NULL)
  )
);

ALTER TABLE public.energy_optimisation_pool_model ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own pool model"
  ON public.energy_optimisation_pool_model FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));
