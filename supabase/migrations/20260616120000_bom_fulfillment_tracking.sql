-- BOM-first fulfillment tracking
-- Links invoice lines to BOM items (quote_lines already carry these), computes quoted/invoiced
-- quantities per BOM item at the premises (bom_group) level, and hard-blocks over-invoicing at
-- finalization to prevent double billing while supporting partial fulfillment.

-- ---------------------------------------------------------------------------
-- A. Link invoice lines back to the BOM item they fulfill (mirror quote_lines)
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS source_bom_id uuid REFERENCES public.boms(id),
  ADD COLUMN IF NOT EXISTS source_bom_item_id uuid,
  ADD COLUMN IF NOT EXISTS source_bom_version integer;

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_source_bom_id
  ON public.invoice_line_items (source_bom_id);

-- Backfill existing invoice lines: attribute each line to its invoice's BOM, matching on sku_id.
UPDATE public.invoice_line_items ili
SET
  source_bom_id = i.bom_id,
  source_bom_version = i.bom_version,
  source_bom_item_id = bi.id
FROM public.invoices i
LEFT JOIN public.bom_items bi
  ON bi.bom_id = i.bom_id
  AND bi.sku_id = (
    SELECT inner_ili.sku_id
    FROM public.invoice_line_items inner_ili
    WHERE inner_ili.id = ili.id
  )
WHERE ili.invoice_id = i.id
  AND i.bom_id IS NOT NULL
  AND ili.source_bom_id IS NULL;

-- ---------------------------------------------------------------------------
-- B. Premises-level fulfillment view, keyed by (bom_group_id, sku_id)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.bom_fulfillment
WITH (security_invoker = on)
AS
WITH latest_targets AS (
  -- Current scope: quantity from the latest revision of each group for each sku.
  SELECT DISTINCT ON (b.bom_group_id, bi.sku_id)
    b.bom_group_id,
    bi.sku_id,
    bi.quantity AS bom_quantity
  FROM public.bom_items bi
  JOIN public.boms b ON b.id = bi.bom_id
  ORDER BY b.bom_group_id, bi.sku_id, b.version DESC
),
invoiced AS (
  -- Finalized only (open/paid). Attribute via the line's source BOM, falling back to the invoice's BOM.
  SELECT
    b.bom_group_id,
    ili.sku_id,
    SUM(ili.quantity) AS invoiced_quantity
  FROM public.invoice_line_items ili
  JOIN public.invoices i ON i.id = ili.invoice_id
  JOIN public.boms b ON b.id = COALESCE(ili.source_bom_id, i.bom_id)
  WHERE ili.sku_id IS NOT NULL
    AND i.status IN ('open', 'paid')
  GROUP BY b.bom_group_id, ili.sku_id
),
quoted AS (
  -- Active (live) quotes only — same status set used by the BOM lock logic.
  SELECT
    b.bom_group_id,
    ql.sku_id,
    SUM(ql.quantity) AS quoted_quantity
  FROM public.quote_lines ql
  JOIN public.quotes q ON q.id = ql.quote_id
  JOIN public.boms b ON b.id = COALESCE(ql.source_bom_id, q.bom_id)
  WHERE ql.sku_id IS NOT NULL
    AND q.status IN ('sent', 'viewed', 'accepted', 'revision_requested')
  GROUP BY b.bom_group_id, ql.sku_id
),
keys AS (
  SELECT bom_group_id, sku_id FROM latest_targets
  UNION
  SELECT bom_group_id, sku_id FROM invoiced
  UNION
  SELECT bom_group_id, sku_id FROM quoted
)
SELECT
  k.bom_group_id,
  k.sku_id,
  COALESCE(lt.bom_quantity, 0) AS bom_quantity,
  COALESCE(q.quoted_quantity, 0) AS quoted_quantity,
  COALESCE(inv.invoiced_quantity, 0) AS invoiced_quantity,
  GREATEST(COALESCE(lt.bom_quantity, 0) - COALESCE(inv.invoiced_quantity, 0), 0) AS remaining_quantity
FROM keys k
LEFT JOIN latest_targets lt ON lt.bom_group_id = k.bom_group_id AND lt.sku_id = k.sku_id
LEFT JOIN invoiced inv ON inv.bom_group_id = k.bom_group_id AND inv.sku_id = k.sku_id
LEFT JOIN quoted q ON q.bom_group_id = k.bom_group_id AND q.sku_id = k.sku_id;

-- ---------------------------------------------------------------------------
-- C. Hard-block over-invoicing inside the atomic finalize routine
-- ---------------------------------------------------------------------------
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
