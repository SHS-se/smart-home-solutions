-- Customer electricity billing history.
-- Parsing remains versioned in the application; this schema stores the
-- normalized, provider-independent result used by charts and gap detection.

CREATE OR REPLACE FUNCTION public.can_access_energy_billing_customer(_customer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND (
      public.is_staff(auth.uid())
      OR EXISTS (
        SELECT 1
        FROM public.customers AS customer
        WHERE customer.id = _customer_id
          AND customer.id = public.get_customer_id_for_user(auth.uid())
          AND customer.subscription_active
          AND (
            customer.subscription_expires_at IS NULL
            OR customer.subscription_expires_at > now()
          )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.can_access_energy_billing_customer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_energy_billing_customer(uuid) TO authenticated;

CREATE TABLE public.energy_billing_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  document_kind text NOT NULL CHECK (document_kind IN ('grid', 'electricity')),
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9_]+$'),
  provider_name text NOT NULL,
  parser_id text NOT NULL CHECK (parser_id ~ '^[a-z0-9_]+$'),
  parser_version integer NOT NULL CHECK (parser_version > 0),
  invoice_number text NOT NULL,
  invoice_date date NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  consumption_kwh numeric NOT NULL CHECK (consumption_kwh >= 0),
  exported_kwh numeric CHECK (exported_kwh >= 0),
  peak_demand_kw numeric CHECK (peak_demand_kw >= 0),
  vat_sek numeric,
  total_amount_sek numeric NOT NULL,
  currency text NOT NULL DEFAULT 'SEK' CHECK (currency = 'SEK'),
  file_path text NOT NULL UNIQUE,
  original_file_name text NOT NULL,
  mime_type text NOT NULL,
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 15728640),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start <= period_end),
  UNIQUE (customer_id, document_sha256),
  UNIQUE (customer_id, document_kind, provider_key, invoice_number)
);

CREATE INDEX idx_energy_billing_documents_customer_period
  ON public.energy_billing_documents (customer_id, period_start, period_end);

CREATE INDEX idx_energy_billing_documents_customer_kind_period
  ON public.energy_billing_documents (customer_id, document_kind, period_start);

ALTER TABLE public.energy_billing_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Subscribers read own energy billing documents"
  ON public.energy_billing_documents
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE TABLE public.energy_billing_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.energy_billing_documents(id) ON DELETE CASCADE,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  category text NOT NULL CHECK (
    category IN (
      'spot_energy',
      'variable_fee',
      'markup',
      'fixed_fee',
      'energy_transfer',
      'peak_demand',
      'energy_tax',
      'export_credit',
      'export_fee',
      'discount',
      'vat',
      'rounding',
      'other'
    )
  ),
  label text NOT NULL,
  amount_sek numeric NOT NULL,
  quantity numeric CHECK (quantity >= 0),
  unit text,
  unit_price_sek numeric,
  period_start date,
  period_end date,
  amount_includes_vat boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (period_start IS NULL AND period_end IS NULL)
    OR (
      period_start IS NOT NULL
      AND period_end IS NOT NULL
      AND period_start <= period_end
    )
  ),
  UNIQUE (document_id, sort_order)
);

CREATE INDEX idx_energy_billing_line_items_document
  ON public.energy_billing_line_items (document_id);

ALTER TABLE public.energy_billing_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Subscribers read own energy billing line items"
  ON public.energy_billing_line_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.energy_billing_documents AS document
      WHERE document.id = energy_billing_line_items.document_id
        AND public.can_access_energy_billing_customer(document.customer_id)
    )
  );

REVOKE INSERT, UPDATE ON public.energy_billing_documents FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.energy_billing_line_items FROM anon, authenticated;
GRANT SELECT ON public.energy_billing_documents TO authenticated;
GRANT SELECT ON public.energy_billing_line_items TO authenticated;

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
  document_path text;
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

  document_path := p_document->>'file_path';
  IF document_path IS NULL OR document_path NOT LIKE (p_customer_id::text || '/%') THEN
    RAISE EXCEPTION 'Energy billing file path does not belong to the customer'
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
    document_path,
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

REVOKE ALL ON FUNCTION public.create_energy_billing_document(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_energy_billing_document(uuid, jsonb, jsonb) TO authenticated;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'energy-billing-documents',
  'energy-billing-documents',
  false,
  15728640,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif'
  ]
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Subscribers upload own energy billing files"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'energy-billing-documents'
    AND EXISTS (
      SELECT 1
      FROM public.customers AS customer
      WHERE customer.id::text = (storage.foldername(name))[1]
        AND public.can_access_energy_billing_customer(customer.id)
    )
  );

CREATE POLICY "Subscribers read own energy billing files"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'energy-billing-documents'
    AND EXISTS (
      SELECT 1
      FROM public.customers AS customer
      WHERE customer.id::text = (storage.foldername(name))[1]
        AND public.can_access_energy_billing_customer(customer.id)
    )
  );

CREATE POLICY "Subscribers delete own energy billing files"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'energy-billing-documents'
    AND EXISTS (
      SELECT 1
      FROM public.customers AS customer
      WHERE customer.id::text = (storage.foldername(name))[1]
        AND public.can_access_energy_billing_customer(customer.id)
    )
  );

COMMENT ON TABLE public.energy_billing_documents IS
  'Normalized grid-operator and electricity-provider invoices for subscriber energy history.';

COMMENT ON FUNCTION public.create_energy_billing_document(uuid, jsonb, jsonb) IS
  'Atomically stores one recognized, client-parsed energy invoice and its normalized charge lines.';
