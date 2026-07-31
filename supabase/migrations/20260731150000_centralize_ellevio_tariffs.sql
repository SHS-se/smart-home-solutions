-- One effective-dated Ellevio catalogue serves every subscribed customer.
-- Customer-specific tariff inputs are derived from the primary-home
-- questionnaire (main_fuse_a and has_solar), never assigned by staff.

CREATE TABLE public.energy_tariff_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  profile_id uuid NOT NULL UNIQUE REFERENCES public.energy_tariff_profiles(id),
  connection_type text NOT NULL DEFAULT 'three_phase' CHECK (connection_type = 'three_phase'),
  grid_area text NOT NULL CHECK (grid_area IN (
    'dalarna_sodra_norrland_edsbyn',
    'stockholm',
    'vastkusten',
    'vastra_svealand_vastergotland'
  )),
  energy_tax_reduced boolean NOT NULL DEFAULT false,
  include_vat boolean NOT NULL DEFAULT true,
  export_vat_registered boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

CREATE TRIGGER energy_tariff_settings_updated_at
  BEFORE UPDATE ON public.energy_tariff_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

ALTER TABLE public.energy_tariff_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read central tariff settings"
  ON public.energy_tariff_settings
  FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

REVOKE ALL ON public.energy_tariff_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_tariff_settings TO authenticated;

INSERT INTO public.energy_tariff_settings (
  id,
  profile_id,
  connection_type,
  grid_area,
  energy_tax_reduced,
  include_vat,
  export_vat_registered
)
VALUES (
  true,
  '6d159c2f-31a1-4dd3-9f93-000000000001',
  'three_phase',
  'stockholm',
  false,
  true,
  false
)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_energy_tariff_settings(
  p_profile_id uuid,
  p_grid_area text,
  p_energy_tax_reduced boolean,
  p_include_vat boolean,
  p_export_vat_registered boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Tariff settings access denied' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.energy_tariff_profiles WHERE id = p_profile_id)
    OR p_grid_area NOT IN (
      'dalarna_sodra_norrland_edsbyn',
      'stockholm',
      'vastkusten',
      'vastra_svealand_vastergotland'
    )
  THEN
    RAISE EXCEPTION 'Invalid tariff settings' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.energy_tariff_settings (
    id,
    profile_id,
    connection_type,
    grid_area,
    energy_tax_reduced,
    include_vat,
    export_vat_registered,
    updated_by
  )
  VALUES (
    true,
    p_profile_id,
    'three_phase',
    p_grid_area,
    p_energy_tax_reduced,
    p_include_vat,
    p_export_vat_registered,
    auth.uid()
  )
  ON CONFLICT (id) DO UPDATE SET
    profile_id = EXCLUDED.profile_id,
    connection_type = 'three_phase',
    grid_area = EXCLUDED.grid_area,
    energy_tax_reduced = EXCLUDED.energy_tax_reduced,
    include_vat = EXCLUDED.include_vat,
    export_vat_registered = EXCLUDED.export_vat_registered,
    updated_by = EXCLUDED.updated_by;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.set_energy_tariff_settings(uuid, text, boolean, boolean, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_energy_tariff_settings(uuid, text, boolean, boolean, boolean)
  TO authenticated;

-- Published versions are immutable. Publishing a new effective date closes
-- the preceding version and stops before any already-scheduled future one.
CREATE OR REPLACE FUNCTION public.publish_energy_tariff_version(
  p_profile_id uuid,
  p_revision text,
  p_valid_from date,
  p_calculation_model text,
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
    RAISE EXCEPTION 'Tariff publishing access denied' USING ERRCODE = '42501';
  END IF;
  IF p_valid_from IS NULL
    OR p_revision IS NULL
    OR p_revision !~ '^[a-z0-9_.-]+$'
    OR p_calculation_model IS DISTINCT FROM 'se_grid_v1'
    OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object'
    OR p_definition->>'schema_version' IS DISTINCT FROM '1'
    OR jsonb_typeof(p_definition->'plans'->'three_phase') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_definition->'energy_tax') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_definition->'vat_rate') IS DISTINCT FROM 'number'
    OR p_source_url IS NULL
    OR p_source_url !~ '^https://'
    OR NOT EXISTS (SELECT 1 FROM public.energy_tariff_profiles WHERE id = p_profile_id)
  THEN
    RAISE EXCEPTION 'Invalid tariff version' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('energy_tariff:' || p_profile_id::text));
  IF EXISTS (
    SELECT 1 FROM public.energy_tariff_versions
    WHERE profile_id = p_profile_id
      AND (revision = p_revision OR valid_from = p_valid_from)
  ) THEN
    RAISE EXCEPTION 'Tariff revision or effective date already exists' USING ERRCODE = '23505';
  END IF;

  SELECT min(valid_from)
  INTO next_valid_from
  FROM public.energy_tariff_versions
  WHERE profile_id = p_profile_id AND valid_from > p_valid_from;

  UPDATE public.energy_tariff_versions
  SET valid_to = p_valid_from - 1
  WHERE profile_id = p_profile_id
    AND valid_from < p_valid_from
    AND (valid_to IS NULL OR valid_to >= p_valid_from);

  INSERT INTO public.energy_tariff_versions (
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
    p_calculation_model,
    p_definition,
    p_source_url
  )
  RETURNING id INTO published_id;

  RETURN published_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_energy_tariff_version(uuid, text, date, text, jsonb, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_energy_tariff_version(uuid, text, date, text, jsonb, text)
  TO authenticated;

-- The old customer assignment surface is intentionally removed: this avoids
-- drift and makes it impossible for staff to configure customers differently.
DROP FUNCTION public.set_customer_energy_tariff_assignment(uuid, uuid, date, jsonb);
DROP TABLE public.customer_energy_tariff_assignments;
DROP FUNCTION public.is_valid_energy_tariff_configuration(jsonb);

-- Main fuse is the only missing per-home tariff fact. The solar answer already
-- exists and is consumed through its has_solar semantic key.
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
  '6d159c2f-31a1-4dd3-9f93-000000000016',
  'Vilken storlek har bostadens huvudsäkring?',
  'What is the home''s main fuse size?',
  'single_choice',
  'main_fuse_a',
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
  SELECT 1 FROM public.home_questions WHERE semantic_key = 'main_fuse_a'
);

INSERT INTO public.home_question_options (question_id, value, label_sv, label_en, order_index)
SELECT question.id, option.value, option.label_sv, option.label_en, option.order_index
FROM public.home_questions question
CROSS JOIN (VALUES
  ('16', '16 A', '16 A', 0),
  ('20', '20 A', '20 A', 1),
  ('25', '25 A', '25 A', 2),
  ('35', '35 A', '35 A', 3),
  ('50', '50 A', '50 A', 4),
  ('63', '63 A', '63 A', 5)
) AS option(value, label_sv, label_en, order_index)
WHERE question.semantic_key = 'main_fuse_a'
ON CONFLICT (question_id, value) DO UPDATE SET
  label_sv = EXCLUDED.label_sv,
  label_en = EXCLUDED.label_en,
  order_index = EXCLUDED.order_index;
