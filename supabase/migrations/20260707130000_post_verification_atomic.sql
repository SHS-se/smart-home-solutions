-- Atomic posting entry point for accounting verifications.
--
-- Until now the clients posted in three separate statements (verification →
-- journal lines → sales link / purchase update) with the verification number
-- allocated by a read-max query. A failure between statements left an orphaned
-- verification with a consumed number, and two concurrent posts could race on
-- the same number. This function does the whole posting in one transaction and
-- serializes number allocation per month with an advisory lock.
--
-- SECURITY INVOKER on purpose: the caller's RLS policies (staff-only writes on
-- acc_* tables) still apply to every insert.

CREATE OR REPLACE FUNCTION public.post_verification_atomic(
  p_verification_date date,
  p_description text,
  p_period_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_invoice_link jsonb DEFAULT NULL,  -- {invoice_id, source_snapshot_json, posting_reason}
  p_purchase_id uuid DEFAULT NULL,    -- when posting a purchase: mark it posted
  p_posting_date date DEFAULT NULL    -- purchase posting date (defaults to p_verification_date)
)
RETURNS TABLE (verification_id uuid, verification_number text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_next integer;
  v_number text;
  v_verification_id uuid;
  v_line jsonb;
  v_sort integer := 0;
BEGIN
  IF p_lines IS NULL OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A verification needs at least two journal lines';
  END IF;

  -- Verification numbers are VYYMM-NNN, sequential per month.
  v_prefix := 'V' || to_char(p_verification_date, 'YYMM') || '-';

  -- Serialize allocation per month so concurrent posts cannot pick the same
  -- number. Transaction-scoped: released automatically on commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('acc_verification_number:' || v_prefix));

  SELECT COALESCE(MAX((regexp_match(av.verification_number, '^V\d{4}-(\d{3})$'))[1]::integer), 0) + 1
  INTO v_next
  FROM acc_verifications av
  WHERE av.verification_number LIKE v_prefix || '%';

  IF v_next > 999 THEN
    RAISE EXCEPTION 'Verification number overflow: month % already has 999 verifications', v_prefix;
  END IF;

  v_number := v_prefix || lpad(v_next::text, 3, '0');

  INSERT INTO acc_verifications (
    verification_number, verification_date, description, period_id,
    source_type, source_id, is_posted, posted_at, posted_by, created_by
  ) VALUES (
    v_number, p_verification_date, p_description, p_period_id,
    p_source_type, p_source_id, true, now(), auth.uid(), auth.uid()
  )
  RETURNING id INTO v_verification_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO acc_journal_lines (
      verification_id, account, account_name, description, debit, credit, sort_order,
      original_currency, original_amount, exchange_rate_source, exchange_rate_date,
      exchange_rate, exchange_rate_overridden, converted_amount_sek
    ) VALUES (
      v_verification_id,
      v_line->>'account',
      v_line->>'account_name',
      v_line->>'description',
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      v_sort,
      v_line->>'original_currency',
      (v_line->>'original_amount')::numeric,
      v_line->>'exchange_rate_source',
      (v_line->>'exchange_rate_date')::date,
      (v_line->>'exchange_rate')::numeric,
      COALESCE((v_line->>'exchange_rate_overridden')::boolean, false),
      (v_line->>'converted_amount_sek')::numeric
    );
    v_sort := v_sort + 1;
  END LOOP;

  IF p_invoice_link IS NOT NULL THEN
    INSERT INTO acc_sales_invoice_links (
      invoice_id, verification_id, source_snapshot_json, posted_at, posted_by, posting_reason
    ) VALUES (
      (p_invoice_link->>'invoice_id')::uuid,
      v_verification_id,
      p_invoice_link->'source_snapshot_json',
      now(),
      auth.uid(),
      COALESCE(p_invoice_link->>'posting_reason', 'ordinary')
    );
  END IF;

  IF p_purchase_id IS NOT NULL THEN
    UPDATE acc_purchases
    SET status = 'posted',
        verification_id = v_verification_id,
        posting_date = COALESCE(p_posting_date, p_verification_date),
        updated_at = now()
    WHERE id = p_purchase_id;
  END IF;

  RETURN QUERY SELECT v_verification_id, v_number;
END;
$$;
