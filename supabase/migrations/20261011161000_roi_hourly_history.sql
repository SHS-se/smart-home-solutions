-- Recovered source facts belong only to ROI; planner/calibration readers keep
-- using measured quarter tables. No generated baseline plans are persisted.
CREATE TABLE public.energy_roi_history_hours (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  start_ts timestamptz NOT NULL,
  actual jsonb NOT NULL,
  device_energy_kwh jsonb NOT NULL,
  pool_c numeric,
  outdoor_c numeric,
  baseline_load_kwh numeric,
  sources jsonb NOT NULL,
  invalid_readings integer NOT NULL DEFAULT 0,
  capture_sha256 text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (home_id, start_ts),
  CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CHECK (extract(epoch FROM start_ts) % 3600 = 0),
  CHECK (jsonb_typeof(actual) = 'object' AND jsonb_typeof(device_energy_kwh) = 'object' AND jsonb_typeof(sources) = 'object'),
  CHECK (baseline_load_kwh IS NULL OR baseline_load_kwh >= 0),
  CHECK (invalid_readings >= 0),
  CHECK (capture_sha256 ~ '^[0-9a-f]{64}$')
);
COMMENT ON TABLE public.energy_roi_history_hours IS
  'HA hourly energy deltas and hourly measurement means, recovered for ROI only. The ROI reader allocates energy evenly within each hour; measured quarters take precedence.';
COMMENT ON COLUMN public.energy_roi_history_hours.baseline_load_kwh IS
  'Independent sum of other device meters when recovered household/device meters cannot supply a consistent residual; never a clipped household residual.';
ALTER TABLE public.energy_roi_history_hours ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Energy subscribers read own ROI hourly history"
  ON public.energy_roi_history_hours FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));
REVOKE ALL ON public.energy_roi_history_hours FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_roi_history_hours TO authenticated;
GRANT ALL ON public.energy_roi_history_hours TO service_role;
