-- All-in marginal electricity price per quarter, as used by the planner.
--
-- ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7.2. The portal stores measured
-- energy but had no price for a past quarter: the current plan's priced slots
-- only ever cover now → +72 h, and the plan-run archive keeps a summary with no
-- slot array. Recomputing the price in the portal would mean a second
-- implementation of the grid transfer and energy tax, which today exist only in
-- the integration's tariff.py, free to drift from the price that actually spent
-- the customer's money.
--
-- So Home Assistant sends the number it used. Prices live in their own table
-- rather than as columns on energy_optimisation_actual_slots because a price
-- exists for future quarters that have no actuals, and because the actual-slot
-- ingest deliberately refuses anything older than 8 days while a backfill needs
-- a much wider window.
CREATE TABLE public.energy_optimisation_price_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  start_ts timestamptz NOT NULL,
  -- Supplier price plus grid transfer plus energy tax, including VAT. The same
  -- figure the optimisation snapshot carries, so the history tab reconciles
  -- against the plan rather than against a second opinion.
  import_price_sek_per_kwh numeric NOT NULL,
  export_price_sek_per_kwh numeric NOT NULL,
  -- 'integration' is pushed explicitly for a quarter; 'snapshot' is harvested
  -- from a plan push covering that quarter. Both are the integration's own
  -- number, so either may overwrite the other; this only records which arrived
  -- last.
  source text NOT NULL CHECK (source IN ('integration', 'snapshot')),
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, start_ts),
  CONSTRAINT energy_optimisation_price_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CONSTRAINT energy_optimisation_price_slot_alignment
    CHECK ((extract(epoch FROM start_ts)::bigint % 900) = 0),
  -- A negative import price is possible on the Swedish spot market and is not
  -- an error. The bound only refuses figures no tariff could produce.
  CONSTRAINT energy_optimisation_price_plausible CHECK (
    import_price_sek_per_kwh BETWEEN -100 AND 100
    AND export_price_sek_per_kwh BETWEEN -100 AND 100
  )
);

CREATE INDEX idx_energy_optimisation_price_home_start
  ON public.energy_optimisation_price_slots (home_id, start_ts DESC);

ALTER TABLE public.energy_optimisation_price_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own optimisation prices"
  ON public.energy_optimisation_price_slots FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_optimisation_price_slots
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_optimisation_price_slots TO authenticated;

-- Prices are pruned on the same 120-day horizon as the quarters they price, so
-- a history window can never outlive its own cost column.
CREATE OR REPLACE FUNCTION public.prune_energy_optimisation_data(p_home_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.energy_optimisation_actual_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '120 days';

  DELETE FROM public.energy_optimisation_device_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '120 days';

  DELETE FROM public.energy_optimisation_price_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '120 days';

  DELETE FROM public.energy_optimisation_plan_runs
  WHERE home_id = p_home_id AND issued_at < now() - interval '30 days';
END;
$$;

COMMENT ON TABLE public.energy_optimisation_price_slots IS
  'All-in marginal import/export price per quarter, sent by Home Assistant; the only historical price the portal has.';
