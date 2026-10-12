-- The retained row doubles as a durable receipt until private source cleanup finishes.
ALTER TABLE public.energy_parse_failures ADD COLUMN retry_imported_at timestamptz;

DROP POLICY "Energy subscribers read own parse failures" ON public.energy_parse_failures;
CREATE POLICY "Energy subscribers read own parse failures" ON public.energy_parse_failures
  FOR SELECT TO authenticated
  USING (retry_imported_at IS NULL AND public.can_access_energy_billing_customer(customer_id));

CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.insert_energy_billing_document(
  p_customer_id uuid,
  p_uploaded_by uuid,
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
  IF jsonb_typeof(p_document) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Energy billing document payload must be an object'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_line_items) IS DISTINCT FROM 'array'
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
    p_uploaded_by
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

REVOKE ALL ON FUNCTION private.insert_energy_billing_document(uuid, uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_energy_billing_document(
  p_customer_id uuid, p_document jsonb, p_line_items jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Energy billing access denied' USING ERRCODE = '42501';
  END IF;
  RETURN private.insert_energy_billing_document(p_customer_id, auth.uid(), p_document, p_line_items);
END;
$$;
REVOKE ALL ON FUNCTION public.create_energy_billing_document(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_energy_billing_document(uuid, jsonb, jsonb) TO authenticated;

-- A NULL payload probes for an exact existing import before downloading the source.
CREATE FUNCTION public.complete_energy_invoice_retry(
  p_failure_id uuid, p_document jsonb DEFAULT NULL, p_line_items jsonb DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  failure public.energy_parse_failures%ROWTYPE;
  document_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Energy invoice retry access denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO failure FROM public.energy_parse_failures WHERE id = p_failure_id FOR UPDATE;
  IF NOT FOUND THEN RETURN true; END IF;
  IF failure.retry_imported_at IS NOT NULL THEN RETURN true; END IF;
  IF failure.file_category <> 'document' OR failure.mime_type <> 'application/pdf' THEN
    RAISE EXCEPTION 'Energy invoice retry requires a retained PDF' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO document_id FROM public.energy_billing_documents
    WHERE customer_id = failure.customer_id AND document_sha256 = failure.file_sha256;
  IF document_id IS NULL THEN
    IF p_document IS NULL THEN RETURN false; END IF;
    BEGIN
      document_id := private.insert_energy_billing_document(
        failure.customer_id, failure.uploaded_by,
        p_document || jsonb_build_object(
          'original_file_name', failure.original_file_name, 'mime_type', failure.mime_type,
          'file_size_bytes', failure.file_size_bytes, 'document_sha256', failure.file_sha256
        ), p_line_items);
    EXCEPTION WHEN unique_violation THEN
      -- Another importer may have committed the same source. Different-byte invoice
      -- number collisions remain failures instead of silently discarding the source.
      SELECT id INTO document_id FROM public.energy_billing_documents
        WHERE customer_id = failure.customer_id AND document_sha256 = failure.file_sha256;
      IF document_id IS NULL THEN RAISE; END IF;
    END;
  END IF;
  UPDATE public.energy_parse_failures SET retry_imported_at = now() WHERE id = failure.id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_energy_invoice_retry(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_energy_invoice_retry(uuid, jsonb, jsonb) TO service_role;

CREATE FUNCTION public.finish_energy_invoice_retry(p_failure_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Energy invoice retry access denied' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.energy_parse_failures WHERE id = p_failure_id AND retry_imported_at IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_energy_invoice_retry(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_energy_invoice_retry(uuid) TO service_role;
