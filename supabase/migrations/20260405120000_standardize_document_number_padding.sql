-- Standardize quote and invoice numbering to 6 numeric digits after the prefix.

CREATE OR REPLACE FUNCTION public.generate_next_quote_number()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_next int;
  v_prefix text;
  v_env text;
BEGIN
  v_env := current_setting('app.environment', true);
  IF v_env = 'live' THEN
    v_prefix := 'Q-';
  ELSE
    v_prefix := 'TQ-';
  END IF;

  UPDATE public.document_sequences
    SET next_value = next_value + 1
    WHERE key = 'quote'
    RETURNING next_value - 1 INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Quote sequence not found in document_sequences';
  END IF;

  RETURN v_prefix || LPAD(v_next::text, 6, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.allocate_invoice_number()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_next int;
  v_prefix text;
  v_env text;
  v_seq int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number_alloc'));

  v_env := current_setting('app.environment', true);
  IF v_env = 'live' THEN
    v_prefix := 'IN-';
  ELSE
    v_prefix := 'TIN-';
  END IF;

  SELECT COALESCE(MAX(
    CASE
      WHEN invoice_number ~ ('^' || v_prefix || '\d+$')
      THEN CAST(SUBSTRING(invoice_number FROM LENGTH(v_prefix) + 1) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO v_next
  FROM public.invoices
  WHERE invoice_number LIKE v_prefix || '%';

  UPDATE public.document_sequences
    SET next_value = GREATEST(next_value, v_next) + 1
    WHERE key = 'invoice'
    RETURNING next_value - 1 INTO v_seq;

  IF v_seq IS NOT NULL AND v_seq > v_next THEN
    v_next := v_seq;
  END IF;

  RETURN v_prefix || LPAD(v_next::text, 6, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_local_invoice(
  p_invoice_id uuid,
  p_app_env text,
  p_created_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_invoice public.invoices%ROWTYPE;
  v_invoice_number text;
  v_now timestamptz := now();
  v_due_date date;
  v_subtotal numeric(12,2) := 0;
  v_tax numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
BEGIN
  IF p_app_env NOT IN ('test', 'live') THEN
    RAISE EXCEPTION 'APP_ENV must be test or live, got %', p_app_env;
  END IF;

  SELECT *
  INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Can only finalize draft invoices';
  END IF;

  v_due_date := COALESCE(v_invoice.due_date, (CURRENT_DATE + INTERVAL '30 days')::date);

  PERFORM public.set_app_environment(p_app_env);
  v_invoice_number := public.allocate_invoice_number();

  SELECT subtotal, tax, total
  INTO v_subtotal, v_tax, v_total
  FROM public.invoice_computed_totals
  WHERE invoice_id = p_invoice_id;

  v_subtotal := COALESCE(v_subtotal, 0);
  v_tax := COALESCE(v_tax, 0);
  v_total := COALESCE(v_total, 0);

  UPDATE public.invoices
  SET
    invoice_number = v_invoice_number,
    status = 'open',
    due_date = v_due_date,
    finalized_at = v_now,
    issued_at = v_now,
    updated_at = v_now
  WHERE id = p_invoice_id;

  INSERT INTO public.invoice_events (
    invoice_id,
    event_type,
    metadata,
    created_by
  ) VALUES (
    p_invoice_id,
    'invoice_finalized',
    jsonb_build_object('invoice_number', v_invoice_number),
    p_created_by
  );

  IF v_invoice.quote_id IS NOT NULL THEN
    UPDATE public.quotes
    SET
      invoice_status = 'open',
      invoice_number = v_invoice_number,
      invoice_due_date = v_due_date,
      invoice_subtotal = v_subtotal,
      invoice_vat = v_tax,
      invoice_total = v_total
    WHERE id = v_invoice.quote_id;

    INSERT INTO public.billing_events (
      quote_id,
      event_type,
      metadata,
      created_by
    ) VALUES (
      v_invoice.quote_id,
      'invoice_finalized',
      jsonb_build_object(
        'invoice_id', p_invoice_id,
        'invoice_number', v_invoice_number
      ),
      p_created_by
    );
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', p_invoice_id,
    'invoice_number', v_invoice_number,
    'status', 'open',
    'quote_id', v_invoice.quote_id,
    'bom_id', v_invoice.bom_id,
    'due_date', v_due_date
  );
END;
$$;

UPDATE public.quotes
SET quote_number = CASE
  WHEN quote_number LIKE 'Q-%' THEN 'Q-' || LPAD(SUBSTRING(quote_number FROM 3), 6, '0')
  WHEN quote_number LIKE 'TQ-%' THEN 'TQ-' || LPAD(SUBSTRING(quote_number FROM 4), 6, '0')
  ELSE quote_number
END
WHERE quote_number ~ '^(Q|TQ)-\d+$';

UPDATE public.invoices
SET invoice_number = CASE
  WHEN invoice_number LIKE 'IN-%' THEN 'IN-' || LPAD(SUBSTRING(invoice_number FROM 4), 6, '0')
  WHEN invoice_number LIKE 'TIN-%' THEN 'TIN-' || LPAD(SUBSTRING(invoice_number FROM 5), 6, '0')
  ELSE invoice_number
END
WHERE invoice_number ~ '^(IN|TIN)-\d+$';

UPDATE public.quotes
SET invoice_number = CASE
  WHEN invoice_number LIKE 'IN-%' THEN 'IN-' || LPAD(SUBSTRING(invoice_number FROM 4), 6, '0')
  WHEN invoice_number LIKE 'TIN-%' THEN 'TIN-' || LPAD(SUBSTRING(invoice_number FROM 5), 6, '0')
  ELSE invoice_number
END
WHERE invoice_number ~ '^(IN|TIN)-\d+$';

UPDATE public.billing_events
SET metadata = jsonb_set(
  metadata,
  '{quote_number}',
  to_jsonb(
    CASE
      WHEN metadata->>'quote_number' LIKE 'Q-%' THEN 'Q-' || LPAD(SUBSTRING(metadata->>'quote_number' FROM 3), 6, '0')
      WHEN metadata->>'quote_number' LIKE 'TQ-%' THEN 'TQ-' || LPAD(SUBSTRING(metadata->>'quote_number' FROM 4), 6, '0')
      ELSE metadata->>'quote_number'
    END
  )
)
WHERE metadata ? 'quote_number'
  AND metadata->>'quote_number' ~ '^(Q|TQ)-\d+$';

UPDATE public.billing_events
SET metadata = jsonb_set(
  metadata,
  '{invoice_number}',
  to_jsonb(
    CASE
      WHEN metadata->>'invoice_number' LIKE 'IN-%' THEN 'IN-' || LPAD(SUBSTRING(metadata->>'invoice_number' FROM 4), 6, '0')
      WHEN metadata->>'invoice_number' LIKE 'TIN-%' THEN 'TIN-' || LPAD(SUBSTRING(metadata->>'invoice_number' FROM 5), 6, '0')
      ELSE metadata->>'invoice_number'
    END
  )
)
WHERE metadata ? 'invoice_number'
  AND metadata->>'invoice_number' ~ '^(IN|TIN)-\d+$';

UPDATE public.invoice_events
SET metadata = jsonb_set(
  metadata,
  '{invoice_number}',
  to_jsonb(
    CASE
      WHEN metadata->>'invoice_number' LIKE 'IN-%' THEN 'IN-' || LPAD(SUBSTRING(metadata->>'invoice_number' FROM 4), 6, '0')
      WHEN metadata->>'invoice_number' LIKE 'TIN-%' THEN 'TIN-' || LPAD(SUBSTRING(metadata->>'invoice_number' FROM 5), 6, '0')
      ELSE metadata->>'invoice_number'
    END
  )
)
WHERE metadata ? 'invoice_number'
  AND metadata->>'invoice_number' ~ '^(IN|TIN)-\d+$';
