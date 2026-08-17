-- Concave utility curves and the two scalar prices the objective needs.
--
-- ENERGY_OPTIMISATION_ARCHITECTURE.md §8.3 and §8.10. These are the only
-- customer inputs the rewritten objective takes, and they are *values* rather
-- than schedules: what a degree of pool water or a kilometre of range is worth,
-- not when to heat or charge. Everything schedule-shaped the old model asked
-- for — end-of-solar SOC, export floor price, pool daily kWh, EV departure —
-- is derived from these instead of being maintained.
--
-- Rows here are **overrides**, not the source of truth for defaults. The edge
-- ships a default curve per store and uses it whenever a home has no row, so a
-- new installation is immediately plannable and §8.10's "supplied once, never
-- tuned" holds even before anyone opens the editor. That also means deleting a
-- row is a safe reset rather than a way to break planning.
--
-- The house battery is deliberately absent. Its curve is computed from the
-- price and PV forecast every solve (§8.4); storing one would reintroduce the
-- fixed target this whole design exists to remove.

CREATE TABLE public.energy_optimisation_value_curves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  -- 'pool' | 'ev' | 'hot_water'. Room comfort already has its own schedule and
  -- temperatures in energy_optimisation_comfort_schedules; duplicating it here
  -- would give one room two disagreeing statements of the same preference.
  store_key text NOT NULL CHECK (store_key IN ('pool', 'ev', 'hot_water')),
  -- The physical unit the breakpoints are over: 'celsius', 'km',
  -- 'litre_degrees'. Carried so the editor can label an axis without a lookup
  -- table that can drift from the curve it describes.
  unit text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 32),
  -- [{ "at": <state>, "sek_per_unit": <marginal value> }, ...], ascending in
  -- `at` with non-increasing `sek_per_unit`. Concavity is what makes marginal
  -- value well defined and keeps the solve linear, so it is enforced in the
  -- edge before a curve is ever used; a rising curve would let the optimiser
  -- justify filling a store without limit.
  points jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (home_id, store_key),
  CONSTRAINT energy_value_curves_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);

ALTER TABLE public.energy_optimisation_value_curves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own value curves"
  ON public.energy_optimisation_value_curves FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers write own value curves"
  ON public.energy_optimisation_value_curves FOR ALL TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id))
  WITH CHECK (public.can_access_energy_billing_customer(customer_id));

-- The scalar prices that are not curves.
--
-- Battery degradation is the one that stops a cost-minimising solver taking
-- three shallow cycles a day for twenty öre and consuming the warranty. It is
-- computed from the customer's own invoice as purchase price divided by
-- warranted lifetime throughput, which is why it is stored rather than assumed.
CREATE TABLE public.energy_optimisation_value_settings (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  battery_degradation_sek_per_kwh numeric NOT NULL DEFAULT 0.45
    CHECK (battery_degradation_sek_per_kwh >= 0
           AND battery_degradation_sek_per_kwh <= 20),
  -- A plug-in hybrid's shortfall price is not a taste: it is the petrol cost
  -- per kilometre it falls back to. Null for a battery vehicle, whose fallback
  -- is charging later at a worse price rather than burning fuel.
  vehicle_fallback_sek_per_km numeric
    CHECK (vehicle_fallback_sek_per_km IS NULL
           OR (vehicle_fallback_sek_per_km >= 0
               AND vehicle_fallback_sek_per_km <= 100)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT energy_value_settings_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);

ALTER TABLE public.energy_optimisation_value_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own value settings"
  ON public.energy_optimisation_value_settings FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers write own value settings"
  ON public.energy_optimisation_value_settings FOR ALL TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id))
  WITH CHECK (public.can_access_energy_billing_customer(customer_id));
