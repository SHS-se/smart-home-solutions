-- Repair legacy numbered invoices that were finalized before issued_at was
-- consistently populated, then enforce the invariant for future writes.

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_numbered_requires_issued_at;

UPDATE public.invoices
SET
  issued_at = finalized_at,
  updated_at = now()
WHERE invoice_number IS NOT NULL
  AND issued_at IS NULL
  AND finalized_at IS NOT NULL;

DO $$
DECLARE
  v_missing_count integer;
BEGIN
  SELECT count(*)
  INTO v_missing_count
  FROM public.invoices
  WHERE invoice_number IS NOT NULL
    AND issued_at IS NULL;

  IF v_missing_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce numbered invoice issue-date invariant: % numbered invoices still lack issued_at',
      v_missing_count;
  END IF;
END $$;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_numbered_requires_issued_at
  CHECK (invoice_number IS NULL OR issued_at IS NOT NULL);
