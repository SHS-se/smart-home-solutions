-- A room loses its heat into the house, not straight into the outdoor air.
--
-- Backtested on the reference bathroom (12-20 October 2026, each day fitted
-- only on the days before it), a room model coupled to the measured house
-- temperature, with its heater's heat arriving through a learned delay,
-- predicted the room 12 hours ahead with half the error of the outdoor-coupled
-- model (0.36 vs 0.66 °C). The house temperature comes from the app: the
-- median across Home Assistant areas of each area's median indoor sensor.
--
-- One row per home and quarter, like outdoor temperature, but in its own table:
-- an older quarter re-sent with a room's history carries the house reading
-- without the outdoor one, and outdoor rows cannot exist without temperature.
CREATE TABLE public.energy_optimisation_house_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  start_ts timestamptz NOT NULL,
  temperature_c numeric NOT NULL CHECK (temperature_c BETWEEN -50 AND 80),
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, start_ts),
  CONSTRAINT energy_optimisation_house_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CONSTRAINT energy_optimisation_house_slot_alignment
    CHECK ((extract(epoch FROM start_ts)::bigint % 900) = 0)
);

CREATE INDEX idx_energy_optimisation_house_home_start
  ON public.energy_optimisation_house_slots (home_id, start_ts DESC);

ALTER TABLE public.energy_optimisation_house_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own house slots"
  ON public.energy_optimisation_house_slots FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_optimisation_house_slots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_optimisation_house_slots TO authenticated;

-- The fitted room model gains two learned terms. Both are null on a room fitted
-- without a house temperature, which keeps the outdoor-coupled shape.
--   heat_lag_h: heater heat reaches the room through a first-order delay
--     (a floor slab), chosen per room by 12-hour prediction error.
--   house_coupling_per_h: °C/h per °C the room sits below the house.
-- prediction_error_c is the room's own 12-hour backtest error over its
-- training window, the number that says whether a deadline will be met.
ALTER TABLE public.energy_optimisation_zone_models
  ADD COLUMN heat_lag_h numeric CHECK (heat_lag_h IS NULL OR heat_lag_h BETWEEN 0 AND 24),
  ADD COLUMN house_coupling_per_h numeric CHECK (house_coupling_per_h IS NULL OR house_coupling_per_h >= 0),
  ADD COLUMN prediction_error_c numeric CHECK (prediction_error_c IS NULL OR prediction_error_c >= 0);

-- The fit chooses a heat delay by running the room forward 12 hours, which
-- needs the quarters themselves rather than sums over them. One row per room
-- and quarter, ordered for paging: three weeks of two rooms is ~4k rows.
CREATE OR REPLACE FUNCTION public.get_energy_thermal_training_quarters(
  p_customer_id uuid,
  p_home_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  room_key text,
  room_name text,
  active_power_w double precision,
  start_ts timestamptz,
  room_temperature_c double precision,
  cooling boolean,
  outdoor_temperature_c double precision,
  solar_w_per_m2 double precision,
  house_temperature_c double precision,
  heat_w double precision
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
  )
  SELECT
    slot.room_key,
    room.room_name,
    room.active_power_w::double precision,
    slot.start_ts,
    slot.room_temperature_c::double precision,
    slot.cooling_duty > 0,
    outdoor.temperature_c::double precision,
    outdoor.solar_w_per_m2::double precision,
    house.temperature_c::double precision,
    (COALESCE(energy.energy_kwh, 0) * 4000.0)::double precision
  FROM public.energy_optimisation_thermal_slots AS slot
  JOIN room_devices AS room ON room.room_key = slot.room_key
  LEFT JOIN public.energy_optimisation_outdoor_slots AS outdoor
    ON outdoor.home_id = slot.home_id AND outdoor.start_ts = slot.start_ts
  LEFT JOIN public.energy_optimisation_house_slots AS house
    ON house.home_id = slot.home_id AND house.start_ts = slot.start_ts
  LEFT JOIN room_energy AS energy
    ON energy.room_key = slot.room_key AND energy.start_ts = slot.start_ts
  WHERE slot.home_id = p_home_id
    AND slot.customer_id = p_customer_id
    AND slot.start_ts >= p_from
    AND slot.start_ts < p_to
  ORDER BY slot.room_key, slot.start_ts;
END;
$$;

REVOKE ALL ON FUNCTION public.get_energy_thermal_training_quarters(
  uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_thermal_training_quarters(
  uuid, uuid, timestamptz, timestamptz
) TO authenticated, service_role;

-- The house over the plan horizon: its measured temperature by local quarter
-- of the day over the last week, and the same quarters over the last day.
-- The planner repeats the weekly shape at the last day's level, which keeps
-- the house's own routine (heating off overnight) without anyone setting it.
CREATE OR REPLACE FUNCTION public.get_energy_house_temperature_profile(
  p_customer_id uuid,
  p_home_id uuid,
  p_timezone text,
  p_to timestamptz
)
RETURNS TABLE (
  quarter_of_day integer,
  week_mean_c double precision,
  day_mean_c double precision
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
  SELECT
    (extract(hour FROM house.start_ts AT TIME ZONE p_timezone)::integer * 4 +
      extract(minute FROM house.start_ts AT TIME ZONE p_timezone)::integer / 15) AS quarter,
    avg(house.temperature_c)::double precision,
    (avg(house.temperature_c) FILTER (WHERE house.start_ts >= p_to - interval '1 day'))::double precision
  FROM public.energy_optimisation_house_slots AS house
  WHERE house.home_id = p_home_id
    AND house.customer_id = p_customer_id
    AND house.start_ts >= p_to - interval '7 days'
    AND house.start_ts < p_to
  GROUP BY 1
  ORDER BY 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_energy_house_temperature_profile(
  uuid, uuid, text, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_house_temperature_profile(
  uuid, uuid, text, timestamptz
) TO authenticated, service_role;
