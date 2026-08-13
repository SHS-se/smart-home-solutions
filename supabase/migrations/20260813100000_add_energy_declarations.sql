-- Official Boverket energideklarationer, parsed from a customer upload.
--
-- Why store these: a certificate is the only authoritative statement about a
-- customer's building we can get without a year of measurement. It supplies a
-- surveyed Atemp, a certified class, a normal-year energy figure, and
-- Boverket's own "similar buildings" reference — which is the only external
-- check available on the archetype priors in src/lib/energy-archetypes.ts.
--
-- Only the structured result is kept. The PDF is not retained, matching the
-- existing behaviour of the energy-data upload for invoices.
--
-- Customer-scoped for now, deliberately consistent with the rest of energy
-- history (see ENERGY_OPTIMISATION_ARCHITECTURE.md §12). home_id is nullable
-- and present so multi-home does not need a second migration to backfill.

CREATE TABLE public.energy_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  home_id uuid REFERENCES public.homes(id) ON DELETE CASCADE,

  -- Boverket's Energideklarations-ID. Not unique across customers by
  -- assumption: a building can change hands and both owners may hold it.
  declaration_id text CHECK (declaration_id ~ '^[0-9]{1,20}$'),
  issued_on date,
  valid_until date,

  -- As printed, on whatever weighting factor was in force at issue.
  primary_energy_kwh_m2 numeric NOT NULL CHECK (primary_energy_kwh_m2 > 0),
  energy_class text NOT NULL CHECK (energy_class IN ('A','B','C','D','E','F','G')),
  new_build_requirement_kwh_m2 numeric CHECK (new_build_requirement_kwh_m2 > 0),
  -- Referensvärde 2. The validation anchor for our priors.
  similar_buildings_kwh_m2 numeric CHECK (similar_buildings_kwh_m2 > 0),
  specific_energy_kwh_m2 numeric CHECK (specific_energy_kwh_m2 > 0),

  -- Surveyed, excluding warm garage. Authoritative over boarea + biarea.
  atemp_m2 numeric CHECK (atemp_m2 > 0 AND atemp_m2 <= 10000),
  year_built integer CHECK (year_built BETWEEN 1600 AND 2200),
  heating_system text,
  municipality text,
  ventilation_type text,

  building_energy_kwh_per_year numeric CHECK (building_energy_kwh_per_year >= 0),
  primary_energy_kwh_per_year numeric CHECK (primary_energy_kwh_per_year >= 0),

  -- The electricity weighting factor the certificate itself implies
  -- (primary / building energy). 1.6 before BBR 29, 1.8 from 2020-09-01.
  -- Stored rather than derived so a restatement stays reproducible even if the
  -- two energy figures are absent from a summary-only certificate.
  weighting_factor numeric CHECK (weighting_factor BETWEEN 1 AND 3),

  -- Measured energy by Boverket post number (1-19), kWh over the period.
  posts_kwh jsonb NOT NULL DEFAULT '{}'::jsonb,
  measurement_period_start date,
  measurement_period_end date,

  parser_version integer NOT NULL DEFAULT 1 CHECK (parser_version > 0),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  original_file_name text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (
    measurement_period_start IS NULL
    OR measurement_period_end IS NULL
    OR measurement_period_start <= measurement_period_end
  ),
  CHECK (valid_until IS NULL OR issued_on IS NULL OR issued_on <= valid_until),
  UNIQUE (customer_id, document_sha256)
);

CREATE INDEX idx_energy_declarations_customer_issued
  ON public.energy_declarations (customer_id, issued_on DESC);

ALTER TABLE public.energy_declarations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Subscribers read own energy declarations"
  ON public.energy_declarations
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Subscribers delete own energy declarations"
  ON public.energy_declarations
  FOR DELETE
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_declarations FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.energy_declarations TO authenticated;

CREATE TRIGGER energy_declarations_updated_at
  BEFORE UPDATE ON public.energy_declarations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

-- Writes go through a definer function, matching create_energy_billing_document.
-- Direct INSERT stays revoked so a client cannot invent a certificate for
-- another customer or fabricate an energy class.
CREATE OR REPLACE FUNCTION public.create_energy_declaration(
  p_customer_id uuid,
  p_declaration jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Not authorised for this customer' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.energy_declarations (
    customer_id, home_id, declaration_id, issued_on, valid_until,
    primary_energy_kwh_m2, energy_class, new_build_requirement_kwh_m2,
    similar_buildings_kwh_m2, specific_energy_kwh_m2, atemp_m2, year_built,
    heating_system, municipality, ventilation_type,
    building_energy_kwh_per_year, primary_energy_kwh_per_year, weighting_factor,
    posts_kwh, measurement_period_start, measurement_period_end,
    parser_version, document_sha256, original_file_name, uploaded_by
  )
  VALUES (
    p_customer_id,
    NULLIF(p_declaration->>'home_id', '')::uuid,
    NULLIF(p_declaration->>'declaration_id', ''),
    NULLIF(p_declaration->>'issued_on', '')::date,
    NULLIF(p_declaration->>'valid_until', '')::date,
    (p_declaration->>'primary_energy_kwh_m2')::numeric,
    p_declaration->>'energy_class',
    NULLIF(p_declaration->>'new_build_requirement_kwh_m2', '')::numeric,
    NULLIF(p_declaration->>'similar_buildings_kwh_m2', '')::numeric,
    NULLIF(p_declaration->>'specific_energy_kwh_m2', '')::numeric,
    NULLIF(p_declaration->>'atemp_m2', '')::numeric,
    NULLIF(p_declaration->>'year_built', '')::integer,
    NULLIF(p_declaration->>'heating_system', ''),
    NULLIF(p_declaration->>'municipality', ''),
    NULLIF(p_declaration->>'ventilation_type', ''),
    NULLIF(p_declaration->>'building_energy_kwh_per_year', '')::numeric,
    NULLIF(p_declaration->>'primary_energy_kwh_per_year', '')::numeric,
    NULLIF(p_declaration->>'weighting_factor', '')::numeric,
    COALESCE(p_declaration->'posts_kwh', '{}'::jsonb),
    NULLIF(p_declaration->>'measurement_period_start', '')::date,
    NULLIF(p_declaration->>'measurement_period_end', '')::date,
    COALESCE(NULLIF(p_declaration->>'parser_version', '')::integer, 1),
    p_declaration->>'document_sha256',
    p_declaration->>'original_file_name',
    auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_energy_declaration(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_energy_declaration(uuid, jsonb) TO authenticated;

COMMENT ON TABLE public.energy_declarations IS
  'Parsed Boverket energideklarationer. The source PDF is not retained. '
  'primary_energy_kwh_m2 is as printed; restate with weighting_factor before '
  'comparing against a figure calculated today (BBR 29 raised 1.6 to 1.8 on '
  '2020-09-01).';
