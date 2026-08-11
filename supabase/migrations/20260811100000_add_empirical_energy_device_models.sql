-- Empirical, per-device load modelling sourced from the Home Assistant Energy
-- Dashboard. Energy Dashboard devices are home-local observations; global
-- staff-authored device templates continue to live in device_types and
-- device_instances.

CREATE TABLE public.energy_optimisation_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  device_key text NOT NULL CHECK (length(device_key) BETWEEN 1 AND 255),
  statistic_id text NOT NULL CHECK (length(statistic_id) BETWEEN 1 AND 255),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  category text NOT NULL CHECK (category IN (
    'heating', 'hot_water', 'cooling', 'property_energy', 'pool_heating',
    'ev_charging', 'household'
  )),
  suggested_load_type text NOT NULL CHECK (suggested_load_type IN (
    'fixed_full_load', 'variable_full_load', 'duty_cycle', 'inverter'
  )),
  load_type_override text CHECK (load_type_override IN (
    'fixed_full_load', 'variable_full_load', 'duty_cycle', 'inverter'
  )),
  inference jsonb NOT NULL DEFAULT '{}'::jsonb,
  active_power_w numeric CHECK (active_power_w IS NULL OR active_power_w BETWEEN 0 AND 100000),
  profile_sample_count integer NOT NULL DEFAULT 0 CHECK (profile_sample_count >= 0),
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, device_key),
  UNIQUE (id, home_id, customer_id),
  CONSTRAINT energy_optimisation_devices_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);

CREATE INDEX idx_energy_optimisation_devices_home_name
  ON public.energy_optimisation_devices (home_id, name);

CREATE TABLE public.energy_optimisation_device_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.energy_optimisation_devices(id) ON DELETE CASCADE,
  start_ts timestamptz NOT NULL,
  energy_kwh numeric NOT NULL CHECK (energy_kwh BETWEEN 0 AND 100),
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, start_ts),
  CONSTRAINT energy_optimisation_device_slots_device_home_consistent
    FOREIGN KEY (device_id, home_id, customer_id)
    REFERENCES public.energy_optimisation_devices(id, home_id, customer_id)
    ON DELETE CASCADE,
  CONSTRAINT energy_optimisation_device_slots_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id)),
  CONSTRAINT energy_optimisation_device_slot_alignment
    CHECK ((extract(epoch FROM start_ts)::bigint % 900) = 0)
);

CREATE INDEX idx_energy_optimisation_device_slots_home_start
  ON public.energy_optimisation_device_slots (home_id, start_ts DESC);

ALTER TABLE public.energy_optimisation_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_optimisation_device_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own empirical devices"
  ON public.energy_optimisation_devices FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers read own empirical device slots"
  ON public.energy_optimisation_device_slots FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_optimisation_devices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_optimisation_device_slots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_optimisation_devices TO authenticated;
GRANT SELECT ON public.energy_optimisation_device_slots TO authenticated;

-- Customers can change only the local classification override. Staff use the
-- same function when viewing a customer's home. Ingestion remains the sole
-- writer of discovered identity, evidence, ratings and measurements.
CREATE OR REPLACE FUNCTION public.set_energy_device_load_type(
  p_device_id uuid,
  p_load_type text
)
RETURNS public.energy_optimisation_devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.energy_optimisation_devices;
BEGIN
  IF p_load_type IS NOT NULL AND p_load_type NOT IN (
    'fixed_full_load', 'variable_full_load', 'duty_cycle', 'inverter'
  ) THEN
    RAISE EXCEPTION 'Unsupported load type';
  END IF;

  UPDATE public.energy_optimisation_devices device
  SET load_type_override = p_load_type
  WHERE device.id = p_device_id
    AND auth.uid() IS NOT NULL
    AND public.can_access_energy_billing_customer(device.customer_id)
  RETURNING device.* INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Device not found or access denied';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_energy_device_load_type(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_energy_device_load_type(uuid, text)
  TO authenticated;

-- Return one row per quarter rather than one row per device and quarter. This
-- keeps a three-day graph below the API row cap even for a full 100-device
-- Energy Dashboard inventory.
CREATE OR REPLACE FUNCTION public.get_energy_optimisation_device_slots(
  p_customer_id uuid,
  p_home_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  start_ts timestamptz,
  device_energy_kwh jsonb
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
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
    OR p_to - p_from > interval '7 days'
  THEN
    RAISE EXCEPTION 'Device history window must be between zero and seven days';
  END IF;

  RETURN QUERY
  SELECT
    slot.start_ts,
    jsonb_object_agg(slot.device_id::text, slot.energy_kwh ORDER BY slot.device_id)
  FROM public.energy_optimisation_device_slots slot
  WHERE slot.customer_id = p_customer_id
    AND slot.home_id = p_home_id
    AND slot.start_ts >= p_from
    AND slot.start_ts < p_to
  GROUP BY slot.start_ts
  ORDER BY slot.start_ts;
END;
$$;

REVOKE ALL ON FUNCTION public.get_energy_optimisation_device_slots(
  uuid, uuid, timestamptz, timestamptz
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_optimisation_device_slots(
  uuid, uuid, timestamptz, timestamptz
) TO authenticated;

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

  DELETE FROM public.energy_optimisation_plan_runs
  WHERE home_id = p_home_id AND issued_at < now() - interval '30 days';
END;
$$;

REVOKE ALL ON FUNCTION public.prune_energy_optimisation_data(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_energy_optimisation_data(uuid)
  TO service_role;
