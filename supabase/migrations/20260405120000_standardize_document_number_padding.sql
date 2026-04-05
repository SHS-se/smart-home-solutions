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

CREATE TEMP TABLE quote_number_migration_map (
  quote_id uuid PRIMARY KEY,
  new_quote_number text NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO quote_number_migration_map (quote_id, new_quote_number)
WITH quote_rows AS (
  SELECT
    q.id,
    q.created_at,
    CASE
      WHEN q.quote_number LIKE 'Q-%' THEN 'Q-'
      ELSE 'TQ-'
    END AS prefix,
    CASE
      WHEN q.quote_number LIKE 'Q-%' THEN SUBSTRING(q.quote_number FROM 3)::integer
      ELSE SUBSTRING(q.quote_number FROM 4)::integer
    END AS numeric_value
  FROM public.quotes q
  WHERE q.quote_number ~ '^(Q|TQ)-\d+$'
),
ranked AS (
  SELECT
    qr.*,
    ROW_NUMBER() OVER (PARTITION BY qr.prefix, qr.numeric_value ORDER BY qr.created_at, qr.id) AS numeric_rank
  FROM quote_rows qr
),
prefix_max AS (
  SELECT
    prefix,
    COALESCE(MAX(numeric_value), 0) AS max_numeric_value
  FROM ranked
  GROUP BY prefix
),
duplicate_overflow AS (
  SELECT
    r.id,
    pm.max_numeric_value
      + ROW_NUMBER() OVER (PARTITION BY r.prefix ORDER BY r.numeric_value, r.created_at, r.id) AS reassigned_numeric
  FROM ranked r
  JOIN prefix_max pm USING (prefix)
  WHERE r.numeric_rank > 1
)
SELECT
  r.id,
  r.prefix || LPAD(COALESCE(d.reassigned_numeric, r.numeric_value)::text, 6, '0')
FROM ranked r
LEFT JOIN duplicate_overflow d ON d.id = r.id;

UPDATE public.quotes q
SET quote_number = '__quote_renumber__' || q.id::text
FROM quote_number_migration_map m
WHERE q.id = m.quote_id;

UPDATE public.quotes q
SET quote_number = m.new_quote_number
FROM quote_number_migration_map m
WHERE q.id = m.quote_id;

CREATE TEMP TABLE invoice_number_migration_map (
  invoice_id uuid PRIMARY KEY,
  new_invoice_number text NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO invoice_number_migration_map (invoice_id, new_invoice_number)
WITH invoice_rows AS (
  SELECT
    i.id,
    i.created_at,
    CASE
      WHEN i.invoice_number LIKE 'IN-%' THEN 'IN-'
      ELSE 'TIN-'
    END AS prefix,
    CASE
      WHEN i.invoice_number LIKE 'IN-%' THEN SUBSTRING(i.invoice_number FROM 4)::integer
      ELSE SUBSTRING(i.invoice_number FROM 5)::integer
    END AS numeric_value
  FROM public.invoices i
  WHERE i.invoice_number ~ '^(IN|TIN)-\d+$'
),
ranked AS (
  SELECT
    ir.*,
    ROW_NUMBER() OVER (PARTITION BY ir.prefix, ir.numeric_value ORDER BY ir.created_at, ir.id) AS numeric_rank
  FROM invoice_rows ir
),
prefix_max AS (
  SELECT
    prefix,
    COALESCE(MAX(numeric_value), 0) AS max_numeric_value
  FROM ranked
  GROUP BY prefix
),
duplicate_overflow AS (
  SELECT
    r.id,
    pm.max_numeric_value
      + ROW_NUMBER() OVER (PARTITION BY r.prefix ORDER BY r.numeric_value, r.created_at, r.id) AS reassigned_numeric
  FROM ranked r
  JOIN prefix_max pm USING (prefix)
  WHERE r.numeric_rank > 1
)
SELECT
  r.id,
  r.prefix || LPAD(COALESCE(d.reassigned_numeric, r.numeric_value)::text, 6, '0')
FROM ranked r
LEFT JOIN duplicate_overflow d ON d.id = r.id;

UPDATE public.invoices i
SET invoice_number = '__invoice_renumber__' || i.id::text
FROM invoice_number_migration_map m
WHERE i.id = m.invoice_id;

UPDATE public.invoices i
SET invoice_number = m.new_invoice_number
FROM invoice_number_migration_map m
WHERE i.id = m.invoice_id;

UPDATE public.quotes q
SET invoice_number = i.invoice_number
FROM public.invoices i
WHERE i.quote_id = q.id
  AND i.invoice_number IS NOT NULL;

UPDATE public.billing_events be
SET metadata = jsonb_set(COALESCE(be.metadata, '{}'::jsonb), '{quote_number}', to_jsonb(q.quote_number))
FROM public.quotes q
WHERE be.quote_id = q.id
  AND be.metadata ? 'quote_number'
  AND q.quote_number IS NOT NULL;

UPDATE public.billing_events be
SET metadata = jsonb_set(COALESCE(be.metadata, '{}'::jsonb), '{invoice_number}', to_jsonb(q.invoice_number))
FROM public.quotes q
WHERE be.quote_id = q.id
  AND be.metadata ? 'invoice_number'
  AND q.invoice_number IS NOT NULL;

UPDATE public.invoice_events ie
SET metadata = jsonb_set(COALESCE(ie.metadata, '{}'::jsonb), '{invoice_number}', to_jsonb(i.invoice_number))
FROM public.invoices i
WHERE ie.invoice_id = i.id
  AND ie.metadata ? 'invoice_number'
  AND i.invoice_number IS NOT NULL;

UPDATE public.document_sequences
SET next_value = GREATEST(
  next_value,
  COALESCE((
    SELECT MAX(
      CASE
        WHEN quote_number LIKE 'Q-%' THEN SUBSTRING(quote_number FROM 3)::integer
        WHEN quote_number LIKE 'TQ-%' THEN SUBSTRING(quote_number FROM 4)::integer
        ELSE NULL
      END
    ) + 1
    FROM public.quotes
    WHERE quote_number ~ '^(Q|TQ)-\d+$'
  ), 1)
)
WHERE key = 'quote';

UPDATE public.document_sequences
SET next_value = GREATEST(
  next_value,
  COALESCE((
    SELECT MAX(
      CASE
        WHEN invoice_number LIKE 'IN-%' THEN SUBSTRING(invoice_number FROM 4)::integer
        WHEN invoice_number LIKE 'TIN-%' THEN SUBSTRING(invoice_number FROM 5)::integer
        ELSE NULL
      END
    ) + 1
    FROM public.invoices
    WHERE invoice_number ~ '^(IN|TIN)-\d+$'
  ), 1)
)
WHERE key = 'invoice';
