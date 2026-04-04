-- Reconcile finalize_local_invoice with the current invoices schema.
-- Invoice totals now come from invoice_computed_totals instead of stored columns.

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
  v_prefix text;
  v_next integer;
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

  v_prefix := CASE WHEN p_app_env = 'live' THEN 'IN-' ELSE 'TIN-' END;
  v_due_date := COALESCE(v_invoice.due_date, (CURRENT_DATE + INTERVAL '30 days')::date);

  PERFORM pg_advisory_xact_lock(hashtext('finalize_invoice:' || p_app_env));

  SELECT
    COALESCE(
      MAX(
        CASE
          WHEN invoice_number ~ ('^' || v_prefix || '\d+$')
            THEN CAST(SUBSTRING(invoice_number FROM LENGTH(v_prefix) + 1) AS integer)
          ELSE 0
        END
      ),
      0
    ) + 1
  INTO v_next
  FROM public.invoices
  WHERE invoice_number LIKE v_prefix || '%';

  v_invoice_number := v_prefix || LPAD(v_next::text, 4, '0');

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
