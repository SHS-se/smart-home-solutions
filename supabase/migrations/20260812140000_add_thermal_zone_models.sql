-- Fitted per-zone thermal models, and the accumulator that feeds them.
--
-- A month of quarter-hour observations across a dozen zones is tens of
-- thousands of rows. Shipping those into an edge function only to reduce them
-- to a handful of sums per zone would dominate the cost of planning, so the
-- accumulation happens here and the function receives one row per zone.

CREATE TABLE public.energy_optimisation_zone_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.energy_optimisation_devices(id) ON DELETE CASCADE,
  fitted_at timestamptz NOT NULL DEFAULT now(),
  training_from timestamptz NOT NULL,
  training_to timestamptz NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count >= 0),
  -- A refused fit is recorded rather than discarded: "this zone cannot be
  -- modelled, and here is why" is the answer the readiness panel needs, and
  -- silence would be indistinguishable from never having tried.
  trained boolean NOT NULL,
  rejection_reason text CHECK (rejection_reason IS NULL OR rejection_reason IN (
    'insufficient_samples', 'insufficient_heating', 'singular', 'poor_fit',
    'non_physical', 'sensor_tracks_outdoor'
  )),
  gain_c_per_wh numeric,
  cooling_constant_per_h numeric,
  background_gain_c_per_h numeric,
  thermal_capacity_wh_per_c numeric,
  heat_loss_w_per_c numeric,
  time_constant_h numeric,
  heating_rate_c_per_h numeric,
  r2 numeric,
  residual_std_c numeric,
  UNIQUE (device_id),
  CONSTRAINT energy_optimisation_zone_model_device_home_consistent
    FOREIGN KEY (device_id, home_id, customer_id)
    REFERENCES public.energy_optimisation_devices(id, home_id, customer_id)
    ON DELETE CASCADE,
  CONSTRAINT energy_optimisation_zone_model_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  -- A trained model must carry its parameters and no reason; a refused one
  -- must carry a reason and no parameters. Neither half-state is storable.
  CONSTRAINT energy_optimisation_zone_model_complete CHECK (
    (trained AND rejection_reason IS NULL
      AND gain_c_per_wh IS NOT NULL
      AND cooling_constant_per_h IS NOT NULL
      AND background_gain_c_per_h IS NOT NULL)
    OR
    (NOT trained AND rejection_reason IS NOT NULL
      AND gain_c_per_wh IS NULL
      AND cooling_constant_per_h IS NULL)
  )
);

CREATE INDEX idx_energy_optimisation_zone_models_home
  ON public.energy_optimisation_zone_models (home_id, fitted_at DESC);

ALTER TABLE public.energy_optimisation_zone_models ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own zone models"
  ON public.energy_optimisation_zone_models FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_optimisation_zone_models FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_optimisation_zone_models TO authenticated;

-- Accumulate the least-squares moments for every zone in one pass.
--
-- The regression is of the observed rate of change on three columns: heat
-- input P (watts), the outdoor difference D = T_out - T_in, and a constant.
-- Heat input comes from the metered per-device energy rather than from
-- actuator duty, because metered energy sees an inverter's modulation.
--
-- Quarters spent cooling are excluded entirely: cooling is out of scope
-- for the model, and including them would drag the heating gain negative.
--
-- Only consecutive quarters contribute. A sample needs the temperature at the
-- start of the *next* quarter, so a gap in the series must break the pair
-- rather than silently span it and report a fifteen-minute change that
-- actually took hours.
CREATE OR REPLACE FUNCTION public.get_energy_thermal_training_moments(
  p_customer_id uuid,
  p_home_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  device_id uuid,
  device_key text,
  active_power_w numeric,
  n bigint,
  n_heated bigint,
  s_pp double precision,
  s_pd double precision,
  s_p double precision,
  s_dd double precision,
  s_d double precision,
  s_py double precision,
  s_dy double precision,
  s_y double precision,
  s_yy double precision,
  s_in double precision,
  s_out double precision,
  s_inin double precision,
  s_outout double precision,
  s_inout double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
    AND (NOT public.can_access_energy_billing_customer(p_customer_id)
      OR NOT public.energy_home_matches_customer(p_home_id, p_customer_id))
  THEN
    RAISE EXCEPTION 'Home not found or access denied';
  END IF;

  RETURN QUERY
  WITH paired AS (
    SELECT
      slot.device_id,
      slot.room_temperature_c AS t_in,
      outdoor.temperature_c AS t_out,
      -- A quarter's metered energy is its mean power over 0.25 h.
      COALESCE(energy.energy_kwh, 0) * 4000.0 AS p_w,
      slot.cooling_duty,
      LEAD(slot.room_temperature_c) OVER w AS t_next,
      LEAD(slot.start_ts) OVER w AS next_start,
      slot.start_ts
    FROM public.energy_optimisation_thermal_slots AS slot
    JOIN public.energy_optimisation_outdoor_slots AS outdoor
      ON outdoor.home_id = slot.home_id
     AND outdoor.start_ts = slot.start_ts
    LEFT JOIN public.energy_optimisation_device_slots AS energy
      ON energy.device_id = slot.device_id
     AND energy.start_ts = slot.start_ts
    WHERE slot.home_id = p_home_id
      AND slot.customer_id = p_customer_id
      AND slot.start_ts >= p_from
      AND slot.start_ts < p_to
    WINDOW w AS (PARTITION BY slot.device_id ORDER BY slot.start_ts)
  ),
  usable AS (
    SELECT
      paired.device_id,
      paired.p_w AS p,
      (paired.t_out - paired.t_in) AS d,
      (paired.t_next - paired.t_in) / 0.25 AS y,
      paired.t_in,
      paired.t_out
    FROM paired
    WHERE paired.t_next IS NOT NULL
      AND paired.next_start = paired.start_ts + interval '15 minutes'
      -- Cooling is not modelled. A quarter where a reversible unit removed
      -- heat cannot inform a heating fit, so it is dropped outright rather
      -- than contributing an inverted sample.
      AND paired.cooling_duty = 0
  )
  SELECT
    usable.device_id,
    device.device_key,
    device.active_power_w,
    COUNT(*) AS n,
    -- Quarters where the zone was genuinely heated. Without enough of
    -- these the heating gain is estimated from almost nothing, which
    -- happens every autumn as the window refills with summer quarters.
    COUNT(*) FILTER (WHERE usable.p > 50) AS n_heated,
    SUM(usable.p * usable.p), SUM(usable.p * usable.d), SUM(usable.p),
    SUM(usable.d * usable.d), SUM(usable.d),
    SUM(usable.p * usable.y), SUM(usable.d * usable.y), SUM(usable.y),
    SUM(usable.y * usable.y),
    SUM(usable.t_in), SUM(usable.t_out),
    SUM(usable.t_in * usable.t_in), SUM(usable.t_out * usable.t_out),
    SUM(usable.t_in * usable.t_out)
  FROM usable
  JOIN public.energy_optimisation_devices AS device
    ON device.id = usable.device_id
  GROUP BY usable.device_id, device.device_key, device.active_power_w;
END;
$$;

REVOKE ALL ON FUNCTION public.get_energy_thermal_training_moments(
  uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_thermal_training_moments(
  uuid, uuid, timestamptz, timestamptz
) TO authenticated, service_role;
