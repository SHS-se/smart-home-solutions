-- Home-scoped, bounded-volume energy optimisation exchange.
--
-- Home Assistant keeps raw/high-frequency recorder samples. The portal stores
-- one row per completed 15-minute slot (120-day rolling retention), one current
-- 72-hour plan per home, and compact hourly run summaries (30-day retention).

CREATE OR REPLACE FUNCTION public.energy_home_matches_customer(
  p_home_id uuid,
  p_customer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.homes
    WHERE id = p_home_id AND customer_id = p_customer_id
  );
$$;

REVOKE ALL ON FUNCTION public.energy_home_matches_customer(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.energy_home_matches_customer(uuid, uuid) TO service_role;

-- Every active integration credential is bound to exactly one home.
ALTER TABLE public.ha_pairing_codes ADD COLUMN home_id uuid REFERENCES public.homes(id) ON DELETE CASCADE;
ALTER TABLE public.ha_device_tokens ADD COLUMN home_id uuid REFERENCES public.homes(id) ON DELETE CASCADE;

UPDATE public.ha_pairing_codes code
SET home_id = customer.primary_home_id
FROM public.customers customer
WHERE customer.id = code.customer_id AND code.home_id IS NULL;

UPDATE public.ha_device_tokens token
SET home_id = customer.primary_home_id
FROM public.customers customer
WHERE customer.id = token.customer_id AND token.home_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ha_pairing_codes WHERE home_id IS NULL)
     OR EXISTS (SELECT 1 FROM public.ha_device_tokens WHERE home_id IS NULL) THEN
    RAISE EXCEPTION
      'Every existing Home Assistant credential needs a customer primary home before this migration';
  END IF;
END;
$$;

ALTER TABLE public.ha_pairing_codes ALTER COLUMN home_id SET NOT NULL;
ALTER TABLE public.ha_device_tokens ALTER COLUMN home_id SET NOT NULL;

ALTER TABLE public.ha_pairing_codes
  ADD CONSTRAINT ha_pairing_codes_home_customer_consistent
  CHECK (public.energy_home_matches_customer(home_id, customer_id));
ALTER TABLE public.ha_device_tokens
  ADD CONSTRAINT ha_device_tokens_home_customer_consistent
  CHECK (public.energy_home_matches_customer(home_id, customer_id));

CREATE INDEX idx_ha_device_tokens_home
  ON public.ha_device_tokens (home_id, created_at DESC);

-- A single completed quarter-hour per home. Device/category values are nullable
-- because an unmapped or unavailable source is unknown, never zero.
CREATE TABLE public.energy_optimisation_actual_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  start_ts timestamptz NOT NULL,
  total_load_kwh numeric,
  solar_production_kwh numeric,
  grid_import_kwh numeric,
  grid_export_kwh numeric,
  pool_heating_kwh numeric,
  hot_water_kwh numeric,
  ev_charging_kwh numeric,
  battery_charge_kwh numeric,
  battery_discharge_kwh numeric,
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, start_ts),
  CONSTRAINT energy_optimisation_actual_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CONSTRAINT energy_optimisation_actual_slot_alignment
    CHECK ((extract(epoch FROM start_ts)::bigint % 900) = 0),
  CONSTRAINT energy_optimisation_actual_non_negative CHECK (
    (total_load_kwh IS NULL OR total_load_kwh BETWEEN 0 AND 100) AND
    (solar_production_kwh IS NULL OR solar_production_kwh BETWEEN 0 AND 100) AND
    (grid_import_kwh IS NULL OR grid_import_kwh BETWEEN 0 AND 100) AND
    (grid_export_kwh IS NULL OR grid_export_kwh BETWEEN 0 AND 100) AND
    (pool_heating_kwh IS NULL OR pool_heating_kwh BETWEEN 0 AND 100) AND
    (hot_water_kwh IS NULL OR hot_water_kwh BETWEEN 0 AND 100) AND
    (ev_charging_kwh IS NULL OR ev_charging_kwh BETWEEN 0 AND 100) AND
    (battery_charge_kwh IS NULL OR battery_charge_kwh BETWEEN 0 AND 100) AND
    (battery_discharge_kwh IS NULL OR battery_discharge_kwh BETWEEN 0 AND 100)
  )
);

CREATE INDEX idx_energy_optimisation_actual_home_start
  ON public.energy_optimisation_actual_slots (home_id, start_ts DESC);

-- The large 72-hour arrays are overwritten, not appended. This bounds the
-- storage cost independently of how often a home replans.
CREATE TABLE public.energy_optimisation_current (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  binding_until timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'incomplete', 'infeasible')),
  model_version text NOT NULL,
  snapshot jsonb NOT NULL,
  plan jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT energy_optimisation_current_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);

-- Small audit/reliability history: summaries and diagnostics only, never the
-- quarter-hour arrays or raw Home Assistant samples.
CREATE TABLE public.energy_optimisation_plan_runs (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'incomplete', 'infeasible')),
  model_version text NOT NULL,
  summary jsonb NOT NULL,
  validation_errors text[] NOT NULL DEFAULT '{}',
  UNIQUE (home_id, snapshot_id),
  CONSTRAINT energy_optimisation_runs_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);

CREATE INDEX idx_energy_optimisation_runs_home_issued
  ON public.energy_optimisation_plan_runs (home_id, issued_at DESC);

ALTER TABLE public.energy_optimisation_actual_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_optimisation_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_optimisation_plan_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own optimisation actuals"
  ON public.energy_optimisation_actual_slots FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers read own current optimisation"
  ON public.energy_optimisation_current FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers read own optimisation runs"
  ON public.energy_optimisation_plan_runs FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_optimisation_actual_slots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_optimisation_current FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_optimisation_plan_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_optimisation_actual_slots TO authenticated;
GRANT SELECT ON public.energy_optimisation_current TO authenticated;
GRANT SELECT ON public.energy_optimisation_plan_runs TO authenticated;

-- Called by the service-role ingestion function after a successful upsert.
-- Keeping pruning server-side makes retention independent of integration
-- uptime and prevents an accidental high-frequency sender growing forever.
CREATE OR REPLACE FUNCTION public.prune_energy_optimisation_data(p_home_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.energy_optimisation_actual_slots
  WHERE home_id = p_home_id AND start_ts < now() - interval '120 days';

  DELETE FROM public.energy_optimisation_plan_runs
  WHERE home_id = p_home_id AND issued_at < now() - interval '30 days';
END;
$$;

REVOKE ALL ON FUNCTION public.prune_energy_optimisation_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_energy_optimisation_data(uuid) TO service_role;
