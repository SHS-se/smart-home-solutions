-- Pool water temperature as a home-level quarter-hour series.
--
-- ENERGY_OPTIMISATION_ARCHITECTURE.md §8.3 makes the pool a store whose state
-- is its water temperature, rather than a load with a median daily budget. Two
-- things need that state: the planner, which asks nothing of an already-warm
-- pool, and the fit that learns the pool's loss coefficient and its heat pump's
-- COP against air temperature.
--
-- A home-level table rather than a column on the thermal slots, because those
-- are keyed per device and the pool is not a room. The other two terms the fit
-- needs are already stored: the pool heater's energy arrives on
-- energy_optimisation_device_slots and air temperature on
-- energy_optimisation_outdoor_slots, both on the same quarter boundaries.

CREATE TABLE public.energy_optimisation_pool_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  start_ts timestamptz NOT NULL,
  water_temperature_c numeric NOT NULL
    CHECK (water_temperature_c BETWEEN -5 AND 60),
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, start_ts),
  CONSTRAINT energy_optimisation_pool_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CONSTRAINT energy_optimisation_pool_slot_alignment
    CHECK ((extract(epoch FROM start_ts)::bigint % 900) = 0)
);

CREATE INDEX idx_energy_optimisation_pool_home_start
  ON public.energy_optimisation_pool_slots (home_id, start_ts DESC);

ALTER TABLE public.energy_optimisation_pool_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own pool observations"
  ON public.energy_optimisation_pool_slots FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

-- Kept as long as the whole-home electrical quarters, and for the same reason:
-- it is the measured record a seasonal replay and a thermal fit both read.
CREATE OR REPLACE FUNCTION public.prune_energy_optimisation_data(p_home_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.energy_optimisation_actual_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '1095 days';

  DELETE FROM public.energy_optimisation_pool_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '1095 days';

  DELETE FROM public.energy_optimisation_device_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '400 days';

  DELETE FROM public.energy_optimisation_plan_runs
  WHERE home_id = p_home_id AND issued_at < now() - interval '400 days';

  DELETE FROM public.energy_optimisation_forecast_runs
  WHERE home_id = p_home_id AND issued_at < now() - interval '400 days';
END;
$$;

REVOKE ALL ON FUNCTION public.prune_energy_optimisation_data(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_energy_optimisation_data(uuid)
  TO service_role;
