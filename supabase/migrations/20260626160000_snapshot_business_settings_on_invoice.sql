-- Freeze the seller's business details onto each invoice when it is finalized.
--
-- business_settings is a single mutable row, but a finalized invoice is a legal
-- record that must never change retroactively. If the bankgiro or address is
-- later edited, already-issued invoices must still show the values that were in
-- effect when they were issued. We therefore snapshot business_settings onto the
-- invoice at finalization (draft -> open) and render finalized invoices from that
-- snapshot; only drafts read the live settings.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS business_snapshot jsonb;

COMMENT ON COLUMN public.invoices.business_snapshot IS
  'Frozen copy of public.business_settings captured at finalization. Source of truth for the seller details printed on this invoice; NULL only for drafts and legacy rows (which fall back to live settings).';

-- Recreate finalize_local_invoice so the draft -> open transition also captures
-- the current business_settings row into business_snapshot. Body is identical to
-- the current definition (20260616120000, with the BOM-fulfillment guard and
-- allocate_invoice_number) aside from the snapshot capture.
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
  v_group_id uuid;
  v_violation record;
  v_business_snapshot jsonb;
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

  -- BOM fulfillment guard (premises/group level, finalized-only): reject finalizing more of any
  -- SKU than the BOM target allows once already-finalized invoices in the same group are counted.
  IF v_invoice.bom_id IS NOT NULL THEN
    SELECT bom_group_id INTO v_group_id FROM public.boms WHERE id = v_invoice.bom_id;

    SELECT this.sku_id, this.this_qty, tgt.target_qty, fin.finalized_elsewhere
    INTO v_violation
    FROM (
      SELECT ili.sku_id, SUM(ili.quantity) AS this_qty
      FROM public.invoice_line_items ili
      WHERE ili.invoice_id = p_invoice_id
        AND ili.line_type = 'hardware'
        AND ili.sku_id IS NOT NULL
      GROUP BY ili.sku_id
    ) this
    JOIN LATERAL (
      -- Latest-revision target qty for this sku in the group. No row => sku not in BOM => not guarded.
      SELECT bi.quantity AS target_qty
      FROM public.bom_items bi
      JOIN public.boms b ON b.id = bi.bom_id
      WHERE b.bom_group_id = v_group_id
        AND bi.sku_id = this.sku_id
      ORDER BY b.version DESC
      LIMIT 1
    ) tgt ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(ili2.quantity), 0) AS finalized_elsewhere
      FROM public.invoice_line_items ili2
      JOIN public.invoices i2 ON i2.id = ili2.invoice_id
      JOIN public.boms b2 ON b2.id = COALESCE(ili2.source_bom_id, i2.bom_id)
      WHERE b2.bom_group_id = v_group_id
        AND ili2.sku_id = this.sku_id
        AND i2.status IN ('open', 'paid')
        AND i2.id <> p_invoice_id
    ) fin ON true
    WHERE this.this_qty + fin.finalized_elsewhere > tgt.target_qty
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION
        'BOM fulfillment exceeded for SKU %: invoicing % unit(s) plus % already invoiced exceeds the BOM target of %',
        v_violation.sku_id, v_violation.this_qty, v_violation.finalized_elsewhere, v_violation.target_qty;
    END IF;
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

  -- Snapshot the seller's business details as they are right now.
  SELECT to_jsonb(b) INTO v_business_snapshot
  FROM public.business_settings b
  WHERE b.id = 1;

  UPDATE public.invoices
  SET
    invoice_number = v_invoice_number,
    status = 'open',
    due_date = v_due_date,
    finalized_at = v_now,
    issued_at = v_now,
    business_snapshot = v_business_snapshot,
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

-- Backfill: freeze every already-issued (non-draft) invoice at the current
-- business_settings values, so future edits to the settings cannot change them.
-- These rows were issued under today's seeded values, so this captures the
-- correct historical state.
UPDATE public.invoices
SET business_snapshot = (SELECT to_jsonb(b) FROM public.business_settings b WHERE b.id = 1)
WHERE status IS DISTINCT FROM 'draft'
  AND business_snapshot IS NULL;
