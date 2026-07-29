-- Retain normalized energy data, not successfully parsed customer source files.
-- Failed parses are kept separately until they can be reviewed or deleted.

ALTER TABLE public.energy_billing_documents
  ALTER COLUMN file_path DROP NOT NULL;

DROP POLICY IF EXISTS "Subscribers upload own energy billing files"
  ON storage.objects;

REVOKE INSERT, UPDATE, DELETE ON public.energy_billing_documents
  FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_energy_billing_document(
  p_customer_id uuid,
  p_document jsonb,
  p_line_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created_document_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Energy billing access denied'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_document) <> 'object' THEN
    RAISE EXCEPTION 'Energy billing document payload must be an object'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_line_items) <> 'array'
    OR jsonb_array_length(p_line_items) = 0
    OR jsonb_array_length(p_line_items) > 100
  THEN
    RAISE EXCEPTION 'Energy billing line items must contain between 1 and 100 entries'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.energy_billing_documents (
    customer_id,
    document_kind,
    provider_key,
    provider_name,
    parser_id,
    parser_version,
    invoice_number,
    invoice_date,
    period_start,
    period_end,
    consumption_kwh,
    exported_kwh,
    peak_demand_kw,
    vat_sek,
    total_amount_sek,
    currency,
    file_path,
    original_file_name,
    mime_type,
    file_size_bytes,
    document_sha256,
    uploaded_by
  )
  VALUES (
    p_customer_id,
    p_document->>'document_kind',
    p_document->>'provider_key',
    p_document->>'provider_name',
    p_document->>'parser_id',
    (p_document->>'parser_version')::integer,
    p_document->>'invoice_number',
    (p_document->>'invoice_date')::date,
    (p_document->>'period_start')::date,
    (p_document->>'period_end')::date,
    (p_document->>'consumption_kwh')::numeric,
    NULLIF(p_document->>'exported_kwh', '')::numeric,
    NULLIF(p_document->>'peak_demand_kw', '')::numeric,
    NULLIF(p_document->>'vat_sek', '')::numeric,
    (p_document->>'total_amount_sek')::numeric,
    p_document->>'currency',
    NULL,
    p_document->>'original_file_name',
    p_document->>'mime_type',
    (p_document->>'file_size_bytes')::bigint,
    p_document->>'document_sha256',
    auth.uid()
  )
  RETURNING id INTO created_document_id;

  INSERT INTO public.energy_billing_line_items (
    document_id,
    sort_order,
    category,
    label,
    amount_sek,
    quantity,
    unit,
    unit_price_sek,
    period_start,
    period_end,
    amount_includes_vat
  )
  SELECT
    created_document_id,
    item.ordinality::integer - 1,
    item.value->>'category',
    item.value->>'label',
    (item.value->>'amount_sek')::numeric,
    NULLIF(item.value->>'quantity', '')::numeric,
    NULLIF(item.value->>'unit', ''),
    NULLIF(item.value->>'unit_price_sek', '')::numeric,
    NULLIF(item.value->>'period_start', '')::date,
    NULLIF(item.value->>'period_end', '')::date,
    (item.value->>'amount_includes_vat')::boolean
  FROM jsonb_array_elements(p_line_items) WITH ORDINALITY AS item(value, ordinality);

  RETURN created_document_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_energy_billing_document(uuid, jsonb, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_energy_billing_document(uuid, jsonb, jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_energy_billing_document(
  p_customer_id uuid,
  p_document_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stored_file_path text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Energy billing access denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT document.file_path
  INTO stored_file_path
  FROM public.energy_billing_documents AS document
  WHERE document.id = p_document_id
    AND document.customer_id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Energy billing document not found'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.energy_billing_documents
  WHERE id = p_document_id
    AND customer_id = p_customer_id;

  RETURN stored_file_path;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_energy_billing_document(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_energy_billing_document(uuid, uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.clear_energy_billing_file_paths(
  p_customer_id uuid,
  p_document_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cleared_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Energy billing access denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_document_ids IS NULL
    OR cardinality(p_document_ids) = 0
    OR cardinality(p_document_ids) > 500
  THEN
    RAISE EXCEPTION 'Energy billing document ids are invalid'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.energy_billing_documents
  SET file_path = NULL
  WHERE customer_id = p_customer_id
    AND id = ANY (p_document_ids)
    AND file_path IS NOT NULL;

  GET DIAGNOSTICS cleared_count = ROW_COUNT;
  RETURN cleared_count;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_energy_billing_file_paths(uuid, uuid[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_energy_billing_file_paths(uuid, uuid[])
  TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_energy_usage_import(
  p_customer_id uuid,
  p_import_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_reading_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Energy usage access denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer
  INTO deleted_reading_count
  FROM public.energy_usage_readings AS reading
  JOIN public.energy_usage_import_batches AS import_batch
    ON import_batch.id = reading.source_import_id
  WHERE import_batch.id = p_import_id
    AND import_batch.customer_id = p_customer_id;

  IF NOT EXISTS (
    SELECT 1
    FROM public.energy_usage_import_batches
    WHERE id = p_import_id
      AND customer_id = p_customer_id
  ) THEN
    RAISE EXCEPTION 'Energy usage import not found'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.energy_usage_import_batches
  WHERE id = p_import_id
    AND customer_id = p_customer_id;

  RETURN deleted_reading_count;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_energy_usage_import(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_energy_usage_import(uuid, uuid)
  TO authenticated;

CREATE TABLE IF NOT EXISTS public.energy_parse_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  original_file_name text NOT NULL CHECK (
    original_file_name = btrim(original_file_name)
    AND char_length(original_file_name) BETWEEN 1 AND 255
  ),
  file_path text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (
    mime_type IN (
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
      'text/csv',
      'application/vnd.ms-excel',
      'text/plain'
    )
  ),
  file_size_bytes bigint NOT NULL CHECK (
    file_size_bytes > 0
    AND file_size_bytes <= 15728640
  ),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_category text NOT NULL CHECK (file_category IN ('document', 'csv')),
  parser_error text NOT NULL CHECK (
    parser_error = btrim(parser_error)
    AND char_length(parser_error) BETWEEN 1 AND 4000
  ),
  uploaded_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, file_sha256)
);

CREATE INDEX IF NOT EXISTS idx_energy_parse_failures_customer_created
  ON public.energy_parse_failures (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_energy_parse_failures_created
  ON public.energy_parse_failures (created_at, id);

ALTER TABLE public.energy_parse_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Energy subscribers read own parse failures"
  ON public.energy_parse_failures;
CREATE POLICY "Energy subscribers read own parse failures"
  ON public.energy_parse_failures
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_parse_failures FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_parse_failures TO authenticated;

CREATE OR REPLACE FUNCTION public.record_energy_parse_failure(
  p_customer_id uuid,
  p_failure jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created_failure_id uuid;
  failure_path text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Energy parse-failure access denied'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_failure) <> 'object' THEN
    RAISE EXCEPTION 'Energy parse-failure payload must be an object'
      USING ERRCODE = '22023';
  END IF;

  failure_path := p_failure->>'file_path';
  IF failure_path IS NULL OR failure_path NOT LIKE (p_customer_id::text || '/%') THEN
    RAISE EXCEPTION 'Energy parse-failure path does not belong to the customer'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.energy_parse_failures (
    customer_id,
    original_file_name,
    file_path,
    mime_type,
    file_size_bytes,
    file_sha256,
    file_category,
    parser_error,
    uploaded_by
  )
  VALUES (
    p_customer_id,
    btrim(p_failure->>'original_file_name'),
    failure_path,
    p_failure->>'mime_type',
    (p_failure->>'file_size_bytes')::bigint,
    p_failure->>'file_sha256',
    p_failure->>'file_category',
    btrim(p_failure->>'parser_error'),
    auth.uid()
  )
  RETURNING id INTO created_failure_id;

  RETURN created_failure_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_energy_parse_failure(uuid, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_energy_parse_failure(uuid, jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_energy_parse_failure(
  p_customer_id uuid,
  p_failure_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stored_file_path text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Energy parse-failure access denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT failure.file_path
  INTO stored_file_path
  FROM public.energy_parse_failures AS failure
  WHERE failure.id = p_failure_id
    AND failure.customer_id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Energy parse failure not found'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.energy_parse_failures
  WHERE id = p_failure_id
    AND customer_id = p_customer_id;

  RETURN stored_file_path;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_energy_parse_failure(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_energy_parse_failure(uuid, uuid)
  TO authenticated;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'energy-parser-failures',
  'energy-parser-failures',
  false,
  15728640,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'text/csv',
    'application/vnd.ms-excel',
    'text/plain'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Energy subscribers upload own parser failures"
  ON storage.objects;
CREATE POLICY "Energy subscribers upload own parser failures"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'energy-parser-failures'
    AND EXISTS (
      SELECT 1
      FROM public.customers AS customer
      WHERE customer.id::text = (storage.foldername(name))[1]
        AND public.can_access_energy_billing_customer(customer.id)
    )
  );

DROP POLICY IF EXISTS "Energy subscribers read own parser failures"
  ON storage.objects;
CREATE POLICY "Energy subscribers read own parser failures"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'energy-parser-failures'
    AND EXISTS (
      SELECT 1
      FROM public.customers AS customer
      WHERE customer.id::text = (storage.foldername(name))[1]
        AND public.can_access_energy_billing_customer(customer.id)
    )
  );

DROP POLICY IF EXISTS "Energy subscribers delete own parser failures"
  ON storage.objects;
CREATE POLICY "Energy subscribers delete own parser failures"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'energy-parser-failures'
    AND EXISTS (
      SELECT 1
      FROM public.customers AS customer
      WHERE customer.id::text = (storage.foldername(name))[1]
        AND public.can_access_energy_billing_customer(customer.id)
    )
  );

COMMENT ON TABLE public.energy_parse_failures IS
  'Source files retained only when an energy import cannot be parsed, pending parser review or deletion.';

COMMENT ON FUNCTION public.delete_energy_usage_import(uuid, uuid) IS
  'Deletes one immutable daily-energy import; earlier overlapping imports become current again.';
