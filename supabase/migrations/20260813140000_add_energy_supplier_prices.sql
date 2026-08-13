-- Supplier electricity prices are owned by Smart Home Solutions. A home names
-- its supplier and Swedish bidding area in the questionnaire; the integration
-- never supplies a Home Assistant price entity.

CREATE TABLE public.energy_supplier_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL UNIQUE CHECK (provider_key ~ '^[a-z0-9_]+$'),
  provider_name text NOT NULL,
  currency text NOT NULL DEFAULT 'SEK' CHECK (currency = 'SEK'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.energy_supplier_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.energy_supplier_profiles(id) ON DELETE CASCADE,
  revision text NOT NULL CHECK (revision ~ '^[a-z0-9_.-]+$'),
  valid_from date NOT NULL,
  valid_to date,
  calculation_model text NOT NULL CHECK (calculation_model = 'se_spot_supplier_v1'),
  definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition) = 'object'
    AND definition->>'schema_version' = '1'
    AND jsonb_typeof(definition->'vat_rate') = 'number'
    AND jsonb_typeof(definition->'import') = 'object'
    AND jsonb_typeof(definition->'export') = 'object'
  ),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (profile_id, revision),
  UNIQUE (profile_id, valid_from)
);

CREATE INDEX idx_energy_supplier_versions_profile_validity
  ON public.energy_supplier_versions (profile_id, valid_from, valid_to);

ALTER TABLE public.energy_supplier_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_supplier_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read supplier profiles"
  ON public.energy_supplier_profiles FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff read supplier versions"
  ON public.energy_supplier_versions FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

REVOKE ALL ON public.energy_supplier_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_supplier_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_supplier_profiles TO authenticated;
GRANT SELECT ON public.energy_supplier_versions TO authenticated;

CREATE OR REPLACE FUNCTION public.publish_energy_supplier_version(
  p_profile_id uuid,
  p_revision text,
  p_valid_from date,
  p_definition jsonb,
  p_source_url text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  published_id uuid;
  next_valid_from date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Supplier pricing access denied' USING ERRCODE = '42501';
  END IF;
  IF p_valid_from IS NULL
    OR p_revision IS NULL
    OR p_revision !~ '^[a-z0-9_.-]+$'
    OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object'
    OR p_definition->>'schema_version' IS DISTINCT FROM '1'
    OR jsonb_typeof(p_definition->'vat_rate') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_definition->'import') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_definition->'export') IS DISTINCT FROM 'object'
    OR p_source_url IS NULL
    OR p_source_url !~ '^https://'
    OR NOT EXISTS (
      SELECT 1 FROM public.energy_supplier_profiles WHERE id = p_profile_id
    )
  THEN
    RAISE EXCEPTION 'Invalid supplier pricing version' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('energy_supplier:' || p_profile_id::text)
  );
  IF EXISTS (
    SELECT 1 FROM public.energy_supplier_versions
    WHERE profile_id = p_profile_id
      AND (revision = p_revision OR valid_from = p_valid_from)
  ) THEN
    RAISE EXCEPTION 'Supplier revision or effective date already exists'
      USING ERRCODE = '23505';
  END IF;

  SELECT min(valid_from)
  INTO next_valid_from
  FROM public.energy_supplier_versions
  WHERE profile_id = p_profile_id AND valid_from > p_valid_from;

  UPDATE public.energy_supplier_versions
  SET valid_to = p_valid_from - 1
  WHERE profile_id = p_profile_id
    AND valid_from < p_valid_from
    AND (valid_to IS NULL OR valid_to >= p_valid_from);

  INSERT INTO public.energy_supplier_versions (
    profile_id,
    revision,
    valid_from,
    valid_to,
    calculation_model,
    definition,
    source_url
  ) VALUES (
    p_profile_id,
    p_revision,
    p_valid_from,
    CASE WHEN next_valid_from IS NULL THEN NULL ELSE next_valid_from - 1 END,
    'se_spot_supplier_v1',
    p_definition,
    p_source_url
  )
  RETURNING id INTO published_id;

  RETURN published_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_energy_supplier_version(
  uuid, text, date, jsonb, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_energy_supplier_version(
  uuid, text, date, jsonb, text
) TO authenticated;

INSERT INTO public.energy_supplier_profiles (id, provider_key, provider_name)
VALUES ('6d159c2f-31a1-4dd3-9f93-000000000020', 'tibber', 'Tibber')
ON CONFLICT (provider_key) DO NOTHING;

-- Tibber's variable purchasing cost is effective-dated because it changes
-- over time. The monthly fee is retained for invoice reconciliation, but it is
-- intentionally excluded from marginal per-kWh prices used by optimisation.
INSERT INTO public.energy_supplier_versions (
  id,
  profile_id,
  revision,
  valid_from,
  calculation_model,
  definition,
  source_url
)
VALUES (
  '6d159c2f-31a1-4dd3-9f93-000000000021',
  '6d159c2f-31a1-4dd3-9f93-000000000020',
  'tibber_se_2026-08-13',
  '2026-08-13',
  'se_spot_supplier_v1',
  '{
    "schema_version": 1,
    "vat_rate": 0.25,
    "import": {
      "spot_multiplier": 1,
      "fixed_markup_sek_per_kwh_ex_vat": 0.06,
      "variable_cost_sek_per_kwh_ex_vat": 0.041
    },
    "export": {
      "spot_multiplier": 1,
      "adjustment_sek_per_kwh": 0
    },
    "monthly_fee_sek_in_vat": 49
  }'::jsonb,
  'https://tibber.com/se/sammanfattning-avtalsvillkor'
)
ON CONFLICT (profile_id, revision) DO NOTHING;

INSERT INTO public.home_questions (
  id,
  question_text,
  question_text_en,
  question_type,
  semantic_key,
  sort_order,
  order_index,
  is_active,
  display_on_contact_form,
  allow_other
)
SELECT
  '6d159c2f-31a1-4dd3-9f93-000000000022',
  'Vilket elhandelsbolag har bostaden?',
  'Which electricity supplier does the home use?',
  'single_choice',
  'electricity_supplier',
  ordering.next_order,
  ordering.next_order,
  true,
  false,
  false
FROM (
  SELECT COALESCE(max(order_index), -1) + 1 AS next_order
  FROM public.home_questions
) AS ordering
WHERE NOT EXISTS (
  SELECT 1 FROM public.home_questions WHERE semantic_key = 'electricity_supplier'
);

INSERT INTO public.home_question_options (question_id, value, label_sv, label_en, order_index)
SELECT question.id, 'tibber', 'Tibber', 'Tibber', 0
FROM public.home_questions question
WHERE question.semantic_key = 'electricity_supplier'
ON CONFLICT (question_id, value) DO UPDATE SET
  label_sv = EXCLUDED.label_sv,
  label_en = EXCLUDED.label_en,
  order_index = EXCLUDED.order_index;

INSERT INTO public.home_questions (
  id,
  question_text,
  question_text_en,
  question_type,
  semantic_key,
  sort_order,
  order_index,
  is_active,
  display_on_contact_form,
  allow_other
)
SELECT
  '6d159c2f-31a1-4dd3-9f93-000000000023',
  'Vilket elområde ligger bostaden i?',
  'Which electricity price area is the home in?',
  'single_choice',
  'electricity_price_area',
  ordering.next_order,
  ordering.next_order,
  true,
  false,
  false
FROM (
  SELECT COALESCE(max(order_index), -1) + 1 AS next_order
  FROM public.home_questions
) AS ordering
WHERE NOT EXISTS (
  SELECT 1 FROM public.home_questions WHERE semantic_key = 'electricity_price_area'
);

INSERT INTO public.home_question_options (question_id, value, label_sv, label_en, order_index)
SELECT question.id, option.value, option.value, option.value, option.order_index
FROM public.home_questions question
CROSS JOIN (VALUES ('SE1', 0), ('SE2', 1), ('SE3', 2), ('SE4', 3))
  AS option(value, order_index)
WHERE question.semantic_key = 'electricity_price_area'
ON CONFLICT (question_id, value) DO UPDATE SET
  label_sv = EXCLUDED.label_sv,
  label_en = EXCLUDED.label_en,
  order_index = EXCLUDED.order_index;

COMMENT ON TABLE public.energy_supplier_profiles IS
  'Electricity suppliers whose effective-dated spot-price terms SHS can reproduce.';
COMMENT ON TABLE public.energy_supplier_versions IS
  'Published supplier per-kWh terms used by integration-prices; fixed monthly fees are metadata only.';
