-- Versioned electricity-grid tariffs exchanged with the SHS Home Assistant
-- integration. Tariff versions are immutable catalogue entries; customer
-- assignments form an effective-dated timeline, and HA returns one calculated
-- grid-cost snapshot per calendar month.

CREATE TABLE public.energy_tariff_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9_]+$'),
  tariff_key text NOT NULL CHECK (tariff_key ~ '^[a-z0-9_]+$'),
  provider_name text NOT NULL,
  display_name text NOT NULL,
  currency text NOT NULL DEFAULT 'SEK' CHECK (currency = 'SEK'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, tariff_key)
);

CREATE TABLE public.energy_tariff_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.energy_tariff_profiles(id) ON DELETE CASCADE,
  revision text NOT NULL CHECK (revision ~ '^[a-z0-9_.-]+$'),
  valid_from date NOT NULL,
  valid_to date,
  calculation_model text NOT NULL CHECK (calculation_model ~ '^[a-z0-9_]+$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (profile_id, revision),
  UNIQUE (profile_id, valid_from)
);

CREATE INDEX idx_energy_tariff_versions_profile_validity
  ON public.energy_tariff_versions (profile_id, valid_from, valid_to);

CREATE OR REPLACE FUNCTION public.is_valid_energy_tariff_configuration(_configuration jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_typeof(_configuration) = 'object'
    AND _configuration->>'connection_type' IN ('three_phase', 'single_phase', 'apartment')
    AND (
      (_configuration->>'connection_type' = 'three_phase'
        AND _configuration->>'fuse_a' IN ('16', '20', '25', '35', '50', '63'))
      OR (_configuration->>'connection_type' = 'single_phase'
        AND _configuration->>'fuse_a' IN ('20', '25', '35'))
      OR (_configuration->>'connection_type' = 'apartment'
        AND _configuration->>'apartment_band' IN ('up_to_29', '30_59', '60_99', '100_plus'))
    )
    AND _configuration->>'grid_area' IN (
      'dalarna_sodra_norrland_edsbyn',
      'stockholm',
      'vastkusten',
      'vastra_svealand_vastergotland'
    )
    AND jsonb_typeof(_configuration->'production_enabled') = 'boolean'
    AND jsonb_typeof(_configuration->'energy_tax_reduced') = 'boolean'
    AND jsonb_typeof(_configuration->'include_vat') = 'boolean'
    AND jsonb_typeof(_configuration->'export_vat_registered') = 'boolean',
    false
  );
$$;

CREATE TABLE public.customer_energy_tariff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.energy_tariff_profiles(id),
  valid_from date NOT NULL,
  valid_to date,
  configuration jsonb NOT NULL
    CHECK (public.is_valid_energy_tariff_configuration(configuration)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (customer_id, valid_from)
);

CREATE INDEX idx_customer_energy_tariff_assignments_customer_validity
  ON public.customer_energy_tariff_assignments (customer_id, valid_from, valid_to);

CREATE TRIGGER customer_energy_tariff_assignments_updated_at
  BEFORE UPDATE ON public.customer_energy_tariff_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

CREATE TABLE public.energy_tariff_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  billing_month date NOT NULL CHECK (extract(day FROM billing_month) = 1),
  coverage_start date NOT NULL,
  coverage_end date NOT NULL,
  is_complete boolean NOT NULL DEFAULT false,
  currency text NOT NULL DEFAULT 'SEK' CHECK (currency = 'SEK'),
  calculation_model text NOT NULL CHECK (calculation_model ~ '^[a-z0-9_]+$'),
  calculation_version integer NOT NULL CHECK (calculation_version > 0),
  tariff_revisions jsonb NOT NULL CHECK (jsonb_typeof(tariff_revisions) = 'array'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  grid_import_kwh numeric NOT NULL CHECK (grid_import_kwh >= 0),
  grid_export_kwh numeric NOT NULL DEFAULT 0 CHECK (grid_export_kwh >= 0),
  peak_demand_kw numeric CHECK (peak_demand_kw >= 0),
  components jsonb NOT NULL CHECK (jsonb_typeof(components) = 'array'),
  total_amount_sek numeric NOT NULL,
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (coverage_start <= coverage_end),
  CHECK (coverage_start >= billing_month),
  CHECK (coverage_end < (billing_month + interval '1 month')::date),
  UNIQUE (customer_id, billing_month)
);

CREATE INDEX idx_energy_tariff_calculations_customer_month
  ON public.energy_tariff_calculations (customer_id, billing_month);

CREATE TRIGGER energy_tariff_calculations_updated_at
  BEFORE UPDATE ON public.energy_tariff_calculations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

ALTER TABLE public.energy_tariff_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_tariff_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_energy_tariff_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_tariff_calculations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read tariff profiles"
  ON public.energy_tariff_profiles
  FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff read tariff versions"
  ON public.energy_tariff_versions
  FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff read tariff assignments"
  ON public.customer_energy_tariff_assignments
  FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Energy subscribers read own tariff calculations"
  ON public.energy_tariff_calculations
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_tariff_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_tariff_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.customer_energy_tariff_assignments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_tariff_calculations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_tariff_profiles TO authenticated;
GRANT SELECT ON public.energy_tariff_versions TO authenticated;
GRANT SELECT ON public.customer_energy_tariff_assignments TO authenticated;
GRANT SELECT ON public.energy_tariff_calculations TO authenticated;

CREATE OR REPLACE FUNCTION public.set_customer_energy_tariff_assignment(
  p_customer_id uuid,
  p_profile_id uuid,
  p_valid_from date,
  p_configuration jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  assignment_id uuid;
  next_valid_from date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Tariff assignment access denied' USING ERRCODE = '42501';
  END IF;

  IF p_valid_from IS NULL
    OR NOT public.is_valid_energy_tariff_configuration(p_configuration)
    OR NOT EXISTS (SELECT 1 FROM public.energy_tariff_profiles WHERE id = p_profile_id)
  THEN
    RAISE EXCEPTION 'Invalid tariff assignment' USING ERRCODE = '22023';
  END IF;

  SELECT min(valid_from)
  INTO next_valid_from
  FROM public.customer_energy_tariff_assignments
  WHERE customer_id = p_customer_id
    AND valid_from > p_valid_from;

  UPDATE public.customer_energy_tariff_assignments
  SET valid_to = p_valid_from - 1
  WHERE customer_id = p_customer_id
    AND valid_from < p_valid_from
    AND (valid_to IS NULL OR valid_to >= p_valid_from);

  INSERT INTO public.customer_energy_tariff_assignments (
    customer_id,
    profile_id,
    valid_from,
    valid_to,
    configuration
  )
  VALUES (
    p_customer_id,
    p_profile_id,
    p_valid_from,
    CASE WHEN next_valid_from IS NULL THEN NULL ELSE next_valid_from - 1 END,
    p_configuration
  )
  ON CONFLICT (customer_id, valid_from)
  DO UPDATE SET
    profile_id = EXCLUDED.profile_id,
    valid_to = EXCLUDED.valid_to,
    configuration = EXCLUDED.configuration
  RETURNING id INTO assignment_id;

  RETURN assignment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_customer_energy_tariff_assignment(uuid, uuid, date, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_customer_energy_tariff_assignment(uuid, uuid, date, jsonb)
  TO authenticated;

-- -------------------------------------------------------------------------
-- Ellevio household/small-business catalogue. Monetary rates in definitions
-- exclude VAT; the calculator adds VAT according to the customer assignment.
-- -------------------------------------------------------------------------

INSERT INTO public.energy_tariff_profiles (
  id,
  provider_key,
  tariff_key,
  provider_name,
  display_name,
  currency
)
VALUES (
  '6d159c2f-31a1-4dd3-9f93-000000000001',
  'ellevio',
  'small_connection',
  'Ellevio',
  'Ellevio low-voltage grid tariff',
  'SEK'
)
ON CONFLICT (provider_key, tariff_key) DO NOTHING;

INSERT INTO public.energy_tariff_versions (
  id,
  profile_id,
  revision,
  valid_from,
  valid_to,
  calculation_model,
  definition,
  source_url
)
VALUES
(
  '6d159c2f-31a1-4dd3-9f93-000000002025',
  '6d159c2f-31a1-4dd3-9f93-000000000001',
  'ellevio-2025-01-01',
  '2025-01-01',
  '2025-12-31',
  'se_grid_v1',
  $json$
  {
    "schema_version": 1,
    "vat_rate": 0.25,
    "energy_tax": {"ore_per_kwh_ex_vat": 43.9, "reduction_ore_per_kwh": 9.6},
    "plans": {
      "three_phase": {
        "selector": "fuse_a",
        "fixed_monthly_sek_ex_vat": {"16": 292, "20": 292, "25": 292, "35": 732, "50": 1120, "63": 1608},
        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 5.0},
        "demand": {"rate_sek_per_kw_ex_vat": 65, "top_n": 3, "distinct_local_days": true, "night_start_hour": 22, "night_end_hour": 6, "night_factor": 0.5}
      },
      "single_phase": {
        "selector": "fuse_a",
        "fixed_monthly_sek_ex_vat": {"20": 104, "25": 292, "35": 292},
        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 5.0},
        "demand": {"rate_sek_per_kw_ex_vat": 65, "top_n": 3, "distinct_local_days": true, "night_start_hour": 22, "night_end_hour": 6, "night_factor": 0.5}
      },
      "apartment": {
        "selector": "apartment_band",
        "fixed_monthly_sek_ex_vat": {"up_to_29": 88, "30_59": 88, "60_99": 88, "100_plus": 88},
        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 20.8}
      }
    },
    "export_credit": {
      "schedule": "swedish_winter_weekday_06_22_v1",
      "ore_per_kwh_ex_vat_by_area": {
        "dalarna_sodra_norrland_edsbyn": {"high": 7.8, "low": 6.8},
        "stockholm": {"high": 5.2, "low": 4.1},
        "vastkusten": {"high": 7.1, "low": 6.0},
        "vastra_svealand_vastergotland": {"high": 7.8, "low": 6.8}
      }
    },
    "sources": [
      "https://www.ellevio.se/abonnemang/tidigare-priser-och-abonnemang/",
      "https://www.ellevio.se/globalassets/content/priserabonnemang-pdf/tidigare-priser-2025/lokalnat/prislista_mikro_16-25a_250101.pdf"
    ]
  }
  $json$::jsonb,
  'https://www.ellevio.se/abonnemang/tidigare-priser-och-abonnemang/'
),
(
  '6d159c2f-31a1-4dd3-9f93-000000002026',
  '6d159c2f-31a1-4dd3-9f93-000000000001',
  'ellevio-2026-01-01',
  '2026-01-01',
  '2026-05-31',
  'se_grid_v1',
  $json$
  {
    "schema_version": 1,
    "vat_rate": 0.25,
    "energy_tax": {"ore_per_kwh_ex_vat": 36.0, "reduction_ore_per_kwh": 9.6},
    "plans": {
      "three_phase": {
        "selector": "fuse_a",
        "fixed_monthly_sek_ex_vat": {"16": 316, "20": 316, "25": 316, "35": 792, "50": 1212, "63": 1740},
        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 5.6},
        "demand": {"rate_sek_per_kw_ex_vat": 65, "top_n": 3, "distinct_local_days": true, "night_start_hour": 22, "night_end_hour": 6, "night_factor": 0.5}
      },
      "single_phase": {
        "selector": "fuse_a",
        "fixed_monthly_sek_ex_vat": {"20": 116, "25": 316, "35": 316},
        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 5.6},
        "demand": {"rate_sek_per_kw_ex_vat": 65, "top_n": 3, "distinct_local_days": true, "night_start_hour": 22, "night_end_hour": 6, "night_factor": 0.5}
      },
      "apartment": {
        "selector": "apartment_band",
        "fixed_monthly_sek_ex_vat": {"up_to_29": 96, "30_59": 88, "60_99": 80, "100_plus": 72},
        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 20.8}
      }
    },
    "export_credit": {
      "schedule": "swedish_winter_weekday_06_22_v1",
      "ore_per_kwh_ex_vat_by_area": {
        "dalarna_sodra_norrland_edsbyn": {"high": 4.1, "low": 3.2},
        "stockholm": {"high": 4.4, "low": 3.3},
        "vastkusten": {"high": 6.3, "low": 5.1},
        "vastra_svealand_vastergotland": {"high": 6.9, "low": 5.9}
      }
    },
    "sources": [
      "https://www.ellevio.se/globalassets/content/priserabonnemang-pdf/2026/effekt/effekt-16-63a_260101.pdf",
      "https://www.ellevio.se/abonnemang/abonnemang-mikroproduktion/"
    ]
  }
  $json$::jsonb,
  'https://www.ellevio.se/globalassets/content/priserabonnemang-pdf/2026/effekt/effekt-16-63a_260101.pdf'
),
(
  '6d159c2f-31a1-4dd3-9f93-000000062026',
  '6d159c2f-31a1-4dd3-9f93-000000000001',
  'ellevio-2026-06-01',
  '2026-06-01',
  NULL,
  'se_grid_v1',
  $json$
  {
    "schema_version": 1,
    "vat_rate": 0.25,
    "energy_tax": {"ore_per_kwh_ex_vat": 36.0, "reduction_ore_per_kwh": 9.6},
    "plans": {
      "three_phase": {
        "selector": "fuse_a",
        "fixed_monthly_sek_ex_vat": {"16": 360, "20": 472, "25": 592, "35": 904, "50": 1384, "63": 1984},
        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 20.8}
      },
      "single_phase": {
        "selector": "fuse_a",
        "fixed_monthly_sek_ex_vat": {"20": 136, "25": 360, "35": 360},
        "transfer": {
          "mode": "flat_by_selector",
          "ore_per_kwh_ex_vat": {"20": 40.0, "25": 20.8, "35": 20.8}
        }
      },
      "apartment": {
        "selector": "apartment_band",
        "fixed_monthly_sek_ex_vat": {"up_to_29": 96, "30_59": 88, "60_99": 80, "100_plus": 72},
        "transfer": {"mode": "flat", "ore_per_kwh_ex_vat": 20.8}
      }
    },
    "export_credit": {
      "schedule": "swedish_winter_weekday_06_22_v1",
      "ore_per_kwh_ex_vat_by_area": {
        "dalarna_sodra_norrland_edsbyn": {"high": 4.1, "low": 3.2},
        "stockholm": {"high": 4.4, "low": 3.3},
        "vastkusten": {"high": 6.3, "low": 5.1},
        "vastra_svealand_vastergotland": {"high": 6.9, "low": 5.9}
      }
    },
    "sources": [
      "https://www.ellevio.se/globalassets/content/priserabonnemang-pdf/2026/sakring/sakringsabonnemang-16-63a_260601.pdf",
      "https://www.ellevio.se/abonnemang/abonnemang-mikroproduktion/"
    ]
  }
  $json$::jsonb,
  'https://www.ellevio.se/globalassets/content/priserabonnemang-pdf/2026/sakring/sakringsabonnemang-16-63a_260601.pdf'
)
ON CONFLICT (profile_id, revision) DO NOTHING;

COMMENT ON TABLE public.energy_tariff_versions IS
  'Immutable, effective-dated machine-readable tariff definitions delivered to paired Home Assistant devices.';
COMMENT ON TABLE public.customer_energy_tariff_assignments IS
  'Effective-dated tariff profile and installation parameters selected for each customer.';
COMMENT ON TABLE public.energy_tariff_calculations IS
  'Monthly component-level grid-cost calculations returned by paired Home Assistant devices.';
