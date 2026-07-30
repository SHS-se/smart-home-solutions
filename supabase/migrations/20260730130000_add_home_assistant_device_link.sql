-- Home Assistant device link: pairing codes, device tokens, and
-- category-level daily energy readings pushed by the SHS HA integration.
--
-- Pairing flow: portal generates a short-lived code (create-pairing-code),
-- the HA integration exchanges it for a long-lived device token (pair-device),
-- and pushes daily kWh per energiprestanda category (ha-energy-ingest).
-- Only SHA-256 hashes of codes and tokens are stored.

-- ---------------------------------------------------------------------------
-- Pairing codes (single-use, short-lived; service-role access only)
-- ---------------------------------------------------------------------------

CREATE TABLE public.ha_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ha_pairing_codes_customer
  ON public.ha_pairing_codes (customer_id, created_at DESC);

ALTER TABLE public.ha_pairing_codes ENABLE ROW LEVEL SECURITY;

-- No policies: codes are only touched by edge functions with the service role.
REVOKE ALL ON public.ha_pairing_codes FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Device tokens (long-lived, revocable)
-- ---------------------------------------------------------------------------

CREATE TABLE public.ha_device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  device_name text NOT NULL DEFAULT 'Home Assistant'
    CHECK (char_length(device_name) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX idx_ha_device_tokens_customer
  ON public.ha_device_tokens (customer_id, created_at DESC);

ALTER TABLE public.ha_device_tokens ENABLE ROW LEVEL SECURITY;

-- Customers may always see and revoke their own device connections, even when
-- the subscription has lapsed (revocation must never be gated on payment).
CREATE POLICY "Customers read own HA device tokens"
  ON public.ha_device_tokens
  FOR SELECT
  TO authenticated
  USING (
    customer_id = public.get_customer_id_for_user(auth.uid())
    OR public.is_staff(auth.uid())
  );

REVOKE ALL ON public.ha_device_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ha_device_tokens TO authenticated;

-- Revocation via RPC so authenticated users never get UPDATE on the table
-- (prevents tampering with token_hash / customer_id).
CREATE OR REPLACE FUNCTION public.revoke_ha_device_token(p_token_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  revoked boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  UPDATE public.ha_device_tokens
  SET revoked_at = now()
  WHERE id = p_token_id
    AND revoked_at IS NULL
    AND (
      customer_id = public.get_customer_id_for_user(auth.uid())
      OR public.is_staff(auth.uid())
    )
  RETURNING true INTO revoked;

  RETURN COALESCE(revoked, false);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_ha_device_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_ha_device_token(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Category-level daily readings pushed from Home Assistant
-- ---------------------------------------------------------------------------
-- Categories mirror the energiprestanda decomposition (BEN, BFS 2016:12):
-- included posts (heating, hot_water, cooling, property_energy), explicitly
-- excluded loads kept for subtraction/verification (pool_heating, ev_charging,
-- household), and whole-home cross-checks (grid_import, grid_export,
-- solar_production, total_consumption).

CREATE TABLE public.energy_device_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  reading_date date NOT NULL,
  category text NOT NULL CHECK (category IN (
    'heating',
    'hot_water',
    'cooling',
    'property_energy',
    'pool_heating',
    'ev_charging',
    'household',
    'grid_import',
    'grid_export',
    'solar_production',
    'total_consumption'
  )),
  kwh numeric NOT NULL CHECK (kwh >= 0),
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, reading_date, category)
);

CREATE INDEX idx_energy_device_readings_customer_category_date
  ON public.energy_device_readings (customer_id, category, reading_date);

ALTER TABLE public.energy_device_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own device readings"
  ON public.energy_device_readings
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_device_readings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_device_readings TO authenticated;

CREATE TRIGGER energy_device_readings_updated_at
  BEFORE UPDATE ON public.energy_device_readings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();
