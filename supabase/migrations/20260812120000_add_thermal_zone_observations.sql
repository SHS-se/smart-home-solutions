-- Quarter-hour thermal observations for zone learning.
--
-- The electrical tables answer "how much energy did this device use". A heat
-- loss fit needs the other half: what the room was doing while that energy was
-- spent. Room temperature, the comfort band that governed the quarter, the
-- fraction of the quarter the actuator actually ran, and the outdoor air the
-- zone lost heat to.
--
-- Outdoor temperature lives on its own home-level table rather than repeated
-- on every zone row, because a home has one outdoor temperature per quarter no
-- matter how many zones observe it. Repeating it would multiply the storage by
-- the zone count and make a contradictory value representable.

CREATE TABLE public.energy_optimisation_outdoor_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  start_ts timestamptz NOT NULL,
  temperature_c numeric NOT NULL CHECK (temperature_c BETWEEN -80 AND 80),
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, start_ts),
  CONSTRAINT energy_optimisation_outdoor_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CONSTRAINT energy_optimisation_outdoor_slot_alignment
    CHECK ((extract(epoch FROM start_ts)::bigint % 900) = 0)
);

CREATE INDEX idx_energy_optimisation_outdoor_home_start
  ON public.energy_optimisation_outdoor_slots (home_id, start_ts DESC);

-- One zone, one completed quarter. The comfort band and setpoint are nullable
-- because a zone may be governed by a direct setpoint entity, by a high/low
-- pair, or briefly by neither; room temperature and actuator duty are not,
-- because a row without both teaches the model nothing and would only dilute
-- the fit.
CREATE TABLE public.energy_optimisation_thermal_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.energy_optimisation_devices(id) ON DELETE CASCADE,
  start_ts timestamptz NOT NULL,
  room_temperature_c numeric NOT NULL CHECK (room_temperature_c BETWEEN -50 AND 80),
  actuator_duty numeric NOT NULL CHECK (actuator_duty BETWEEN 0 AND 1),
  -- Cooling is measured but never modelled. A reversible aircon running in
  -- summer puts energy into the meter while the room gets colder, which
  -- would ask the heating fit to explain an impossibility. Recording it
  -- lets those quarters be excluded rather than misread as heating.
  cooling_duty numeric NOT NULL DEFAULT 0 CHECK (cooling_duty BETWEEN 0 AND 1),
  comfort_min_c numeric CHECK (comfort_min_c IS NULL OR comfort_min_c BETWEEN -50 AND 80),
  comfort_max_c numeric CHECK (comfort_max_c IS NULL OR comfort_max_c BETWEEN -50 AND 80),
  setpoint_c numeric CHECK (setpoint_c IS NULL OR setpoint_c BETWEEN -50 AND 80),
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, start_ts),
  CONSTRAINT energy_optimisation_thermal_device_home_consistent
    FOREIGN KEY (device_id, home_id, customer_id)
    REFERENCES public.energy_optimisation_devices(id, home_id, customer_id)
    ON DELETE CASCADE,
  CONSTRAINT energy_optimisation_thermal_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CONSTRAINT energy_optimisation_thermal_slot_alignment
    CHECK ((extract(epoch FROM start_ts)::bigint % 900) = 0),
  CONSTRAINT energy_optimisation_thermal_comfort_band_ordered
    CHECK (
      comfort_min_c IS NULL
      OR comfort_max_c IS NULL
      OR comfort_min_c <= comfort_max_c
    )
);

CREATE INDEX idx_energy_optimisation_thermal_home_start
  ON public.energy_optimisation_thermal_slots (home_id, start_ts DESC);
CREATE INDEX idx_energy_optimisation_thermal_device_start
  ON public.energy_optimisation_thermal_slots (device_id, start_ts DESC);

ALTER TABLE public.energy_optimisation_outdoor_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_optimisation_thermal_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own outdoor slots"
  ON public.energy_optimisation_outdoor_slots FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers read own thermal slots"
  ON public.energy_optimisation_thermal_slots FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_optimisation_outdoor_slots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_optimisation_thermal_slots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_optimisation_outdoor_slots TO authenticated;
GRANT SELECT ON public.energy_optimisation_thermal_slots TO authenticated;

-- One row per quarter rather than one per zone and quarter, matching the
-- device-slot reader. A thirty-day training window across thirteen zones is
-- ~37k device rows but only ~2.9k quarters, which stays under the API row cap.
CREATE OR REPLACE FUNCTION public.get_energy_optimisation_thermal_slots(
  p_customer_id uuid,
  p_home_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  start_ts timestamptz,
  outdoor_temperature_c numeric,
  zone_observations jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL
    OR NOT public.can_access_energy_billing_customer(p_customer_id)
    OR NOT public.energy_home_matches_customer(p_home_id, p_customer_id)
  THEN
    RAISE EXCEPTION 'Home not found or access denied';
  END IF;

  RETURN QUERY
  SELECT
    slot.start_ts,
    outdoor.temperature_c,
    jsonb_object_agg(
      device.device_key,
      jsonb_strip_nulls(jsonb_build_object(
        'room_temperature_c', slot.room_temperature_c,
        'actuator_duty', slot.actuator_duty,
        'cooling_duty', NULLIF(slot.cooling_duty, 0),
        'comfort_min_c', slot.comfort_min_c,
        'comfort_max_c', slot.comfort_max_c,
        'setpoint_c', slot.setpoint_c
      ))
    ) AS zone_observations
  FROM public.energy_optimisation_thermal_slots AS slot
  JOIN public.energy_optimisation_devices AS device
    ON device.id = slot.device_id
  LEFT JOIN public.energy_optimisation_outdoor_slots AS outdoor
    ON outdoor.home_id = slot.home_id
   AND outdoor.start_ts = slot.start_ts
  WHERE slot.home_id = p_home_id
    AND slot.customer_id = p_customer_id
    AND slot.start_ts >= p_from
    AND slot.start_ts < p_to
  GROUP BY slot.start_ts, outdoor.temperature_c
  ORDER BY slot.start_ts;
END;
$$;

REVOKE ALL ON FUNCTION public.get_energy_optimisation_thermal_slots(
  uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_optimisation_thermal_slots(
  uuid, uuid, timestamptz, timestamptz
) TO authenticated;
