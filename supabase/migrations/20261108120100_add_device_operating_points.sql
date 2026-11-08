-- Measured operating points: draw per device and heat per kWh, one per
-- combination of the devices' own power settings. The refit recomputes them
-- from the stored quarters every time, so they are its output like the rest of
-- a fit row, not measurements of their own. Planning does not read them yet.

-- The pool's members are learned together, because they change one another's
-- efficiency (a slower circulation pump lowers the heat pump's COP).
ALTER TABLE public.energy_optimisation_pool_model ADD COLUMN operating_points jsonb;
COMMENT ON COLUMN public.energy_optimisation_pool_model.operating_points IS
  'Measured draw and COP per combination of pool device power settings, recomputed by each refit.';

-- Every other variable-power device is learned on its own.
CREATE TABLE public.energy_optimisation_device_operating_points (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  device_key text NOT NULL,
  fitted_at timestamptz,
  operating_points jsonb,
  last_attempted_at timestamptz,
  last_fit_attempt jsonb,
  model_revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (home_id, device_key),
  CONSTRAINT energy_device_operating_points_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);
COMMENT ON TABLE public.energy_optimisation_device_operating_points IS
  'Measured draw and COP per power setting of each variable-power device outside the pool, recomputed by its daily refit.';
ALTER TABLE public.energy_optimisation_device_operating_points ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Energy subscribers read own device operating points"
  ON public.energy_optimisation_device_operating_points FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));
CREATE TRIGGER device_operating_points_revision BEFORE UPDATE ON public.energy_optimisation_device_operating_points
  FOR EACH ROW EXECUTE FUNCTION private.advance_device_model_revision();
