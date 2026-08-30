-- Give the zone fit a fourth regressor: the sun.
--
-- The model becomes y = a·P + γ·(T_out − T_in) + s·I + g, where I is global
-- horizontal irradiance in W/m². Until now `g` alone had to stand for every
-- watt of heat no heater delivered — appliances, lighting, occupants and
-- sunshine together — and being a constant it could not tell a bright day from
-- a dull one. It therefore under-predicted the bright day and over-predicted
-- the dull one by the same amount, and in a house with real glazing the sun is
-- the largest of the terms it was hiding.
--
-- `solar_mean_w_per_m2` is kept alongside the coefficient so a fitted zone can
-- still be projected when no irradiance forecast is available: evaluated at
-- the mean it reproduces exactly the flat background the three-regressor fit
-- would have published. Losing the forecast then costs accuracy rather than
-- changing what the model means.
--
-- Both columns are nullable, and null is not a defect. A zone fitted on a
-- window without irradiance — an unlocated home, or history older than the
-- provider's reanalysis — keeps the three-regressor model it always had, and
-- the planner reads both shapes through one accessor that neither knows nor
-- cares which it was handed.

ALTER TABLE public.energy_optimisation_zone_models
  ADD COLUMN solar_gain_c_per_h_per_wm2 numeric
    CHECK (solar_gain_c_per_h_per_wm2 IS NULL
      OR solar_gain_c_per_h_per_wm2 >= 0),
  ADD COLUMN solar_mean_w_per_m2 numeric
    CHECK (solar_mean_w_per_m2 IS NULL
      OR solar_mean_w_per_m2 BETWEEN 0 AND 1500);

COMMENT ON COLUMN public.energy_optimisation_zone_models.solar_gain_c_per_h_per_wm2 IS
  'Temperature rise per hour per W/m2 of global horizontal irradiance. Null '
  'on a zone fitted without irradiance. Never negative: sunshine cannot cool '
  'a room, so a negative solution is a correlation and the fit falls back to '
  'three regressors rather than publishing it.';

-- The training accumulator now carries the solar design column as well.
--
-- The signature gains `p_min_samples` so one rule decides the sample set in
-- one place. Moments are only a valid regression if every sum ran over the
-- same rows, so the choice between "restrict to quarters that have irradiance"
-- and "use everything and fit three regressors" has to be made before any sum
-- is taken — not per sum, and never by reading an unrecorded hour as though
-- the sun had not been shining.
DROP FUNCTION IF EXISTS public.get_energy_thermal_training_moments(
  uuid, uuid, timestamptz, timestamptz
);

CREATE OR REPLACE FUNCTION public.get_energy_thermal_training_moments(
  p_customer_id uuid,
  p_home_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_min_samples integer DEFAULT 480
)
RETURNS TABLE (
  room_key text,
  room_name text,
  active_power_w numeric,
  n bigint,
  n_heated bigint,
  uses_solar boolean,
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
  s_inout double precision,
  s_pi double precision,
  s_di double precision,
  s_ii double precision,
  s_i double precision,
  s_iy double precision
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
  WITH room_devices AS (
    SELECT
      device.mapping_summary ->> 'room_key' AS room_key,
      max(device.mapping_summary ->> 'room_name') AS room_name,
      sum(COALESCE(device.active_power_w, 0)) AS active_power_w
    FROM public.energy_optimisation_devices AS device
    WHERE device.home_id = p_home_id
      AND device.customer_id = p_customer_id
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override IN ('setpoint', 'switch_schedule')
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = device.control_type_override
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
      AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
    GROUP BY device.mapping_summary ->> 'room_key'
  ),
  room_energy AS (
    SELECT
      device.mapping_summary ->> 'room_key' AS room_key,
      energy.start_ts,
      sum(energy.energy_kwh) AS energy_kwh
    FROM public.energy_optimisation_device_slots AS energy
    JOIN public.energy_optimisation_devices AS device
      ON device.id = energy.device_id
    WHERE energy.home_id = p_home_id
      AND energy.customer_id = p_customer_id
      AND energy.start_ts >= p_from
      AND energy.start_ts < p_to
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override IN ('setpoint', 'switch_schedule')
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = device.control_type_override
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
    GROUP BY device.mapping_summary ->> 'room_key', energy.start_ts
  ),
  paired AS (
    SELECT
      slot.room_key,
      slot.room_temperature_c AS t_in,
      outdoor.temperature_c AS t_out,
      outdoor.solar_w_per_m2 AS irradiance,
      COALESCE(energy.energy_kwh, 0) * 4000.0 AS p_w,
      slot.cooling_duty,
      lead(slot.room_temperature_c) OVER w AS t_next,
      lead(slot.start_ts) OVER w AS next_start,
      slot.start_ts
    FROM public.energy_optimisation_thermal_slots AS slot
    JOIN public.energy_optimisation_outdoor_slots AS outdoor
      ON outdoor.home_id = slot.home_id
     AND outdoor.start_ts = slot.start_ts
    LEFT JOIN room_energy AS energy
      ON energy.room_key = slot.room_key
     AND energy.start_ts = slot.start_ts
    WHERE slot.home_id = p_home_id
      AND slot.customer_id = p_customer_id
      AND slot.start_ts >= p_from
      AND slot.start_ts < p_to
    WINDOW w AS (PARTITION BY slot.room_key ORDER BY slot.start_ts)
  ),
  usable AS (
    SELECT
      paired.room_key,
      paired.p_w AS p,
      (paired.t_out - paired.t_in) AS d,
      (paired.t_next - paired.t_in) / 0.25 AS y,
      paired.t_in,
      paired.t_out,
      paired.irradiance AS i
    FROM paired
    WHERE paired.t_next IS NOT NULL
      AND paired.next_start = paired.start_ts + interval '15 minutes'
      AND paired.cooling_duty = 0
  ),
  -- One decision per room, taken before any sum: is there enough irradiance
  -- to fit on the quarters that have it, or does the room fit on everything
  -- and keep the sun inside its constant?
  coverage AS (
    SELECT
      usable.room_key,
      count(*) AS n_all,
      count(*) FILTER (WHERE usable.i IS NOT NULL) AS n_solar
    FROM usable
    GROUP BY usable.room_key
  ),
  decision AS (
    SELECT
      coverage.room_key,
      (coverage.n_solar >= p_min_samples
        AND coverage.n_solar >= coverage.n_all * 0.8) AS use_solar
    FROM coverage
  ),
  chosen AS (
    SELECT usable.*, decision.use_solar
    FROM usable
    JOIN decision ON decision.room_key = usable.room_key
    WHERE NOT decision.use_solar OR usable.i IS NOT NULL
  )
  SELECT
    chosen.room_key,
    room.room_name,
    room.active_power_w,
    count(*) AS n,
    count(*) FILTER (WHERE chosen.p > 50) AS n_heated,
    bool_or(chosen.use_solar) AS uses_solar,
    sum(chosen.p * chosen.p), sum(chosen.p * chosen.d), sum(chosen.p),
    sum(chosen.d * chosen.d), sum(chosen.d),
    sum(chosen.p * chosen.y), sum(chosen.d * chosen.y), sum(chosen.y),
    sum(chosen.y * chosen.y),
    sum(chosen.t_in), sum(chosen.t_out),
    sum(chosen.t_in * chosen.t_in), sum(chosen.t_out * chosen.t_out),
    sum(chosen.t_in * chosen.t_out),
    -- Zero rather than null when unused, so the four-regressor solve is only
    -- ever reached through `uses_solar` and never through a silent coalesce.
    COALESCE(sum(chosen.p * chosen.i) FILTER (WHERE chosen.use_solar), 0),
    COALESCE(sum(chosen.d * chosen.i) FILTER (WHERE chosen.use_solar), 0),
    COALESCE(sum(chosen.i * chosen.i) FILTER (WHERE chosen.use_solar), 0),
    COALESCE(sum(chosen.i) FILTER (WHERE chosen.use_solar), 0),
    COALESCE(sum(chosen.i * chosen.y) FILTER (WHERE chosen.use_solar), 0)
  FROM chosen
  JOIN room_devices AS room ON room.room_key = chosen.room_key
  GROUP BY chosen.room_key, room.room_name, room.active_power_w;
END;
$$;

REVOKE ALL ON FUNCTION public.get_energy_thermal_training_moments(
  uuid, uuid, timestamptz, timestamptz, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_thermal_training_moments(
  uuid, uuid, timestamptz, timestamptz, integer
) TO authenticated, service_role;
