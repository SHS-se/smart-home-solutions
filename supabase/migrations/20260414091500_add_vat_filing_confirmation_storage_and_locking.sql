INSERT INTO storage.buckets (id, name, public)
VALUES ('vat-filing-confirmations', 'vat-filing-confirmations', false)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  public = EXCLUDED.public;

DROP POLICY IF EXISTS "Staff can upload VAT filing confirmations" ON storage.objects;
CREATE POLICY "Staff can upload VAT filing confirmations" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'vat-filing-confirmations'
    AND public.is_staff(auth.uid())
  );

DROP POLICY IF EXISTS "Staff can view VAT filing confirmations" ON storage.objects;
CREATE POLICY "Staff can view VAT filing confirmations" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'vat-filing-confirmations'
    AND public.is_staff(auth.uid())
  );

DROP POLICY IF EXISTS "Staff can delete VAT filing confirmations" ON storage.objects;
CREATE POLICY "Staff can delete VAT filing confirmations" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'vat-filing-confirmations'
    AND public.is_staff(auth.uid())
  );

CREATE OR REPLACE FUNCTION public.acc_lock_periods_after_vat_filing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  quarter_start_month integer;
BEGIN
  IF NEW.filing_confirmed_at IS NOT NULL
     AND NEW.filing_confirmation_path IS NOT NULL
     AND (
       OLD.filing_confirmed_at IS DISTINCT FROM NEW.filing_confirmed_at
       OR OLD.filing_confirmation_path IS DISTINCT FROM NEW.filing_confirmation_path
     ) THEN
    quarter_start_month := ((NEW.quarter - 1) * 3) + 1;

    UPDATE public.acc_periods
    SET
      status = 'locked',
      locked_at = COALESCE(locked_at, NEW.filing_confirmed_at)
    WHERE year = NEW.year
      AND month IN (quarter_start_month, quarter_start_month + 1, quarter_start_month + 2);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS acc_vat_periods_lock_quarter_after_filing ON public.acc_vat_periods;
CREATE TRIGGER acc_vat_periods_lock_quarter_after_filing
AFTER UPDATE OF filing_confirmation_path, filing_confirmed_at ON public.acc_vat_periods
FOR EACH ROW
EXECUTE FUNCTION public.acc_lock_periods_after_vat_filing();

CREATE OR REPLACE FUNCTION public.acc_prevent_reopening_filed_periods()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  period_quarter integer;
BEGIN
  IF OLD.status = 'locked' AND NEW.status <> 'locked' THEN
    period_quarter := ((OLD.month - 1) / 3) + 1;

    IF EXISTS (
      SELECT 1
      FROM public.acc_vat_periods vat_period
      WHERE vat_period.year = OLD.year
        AND vat_period.quarter = period_quarter
        AND vat_period.filing_confirmed_at IS NOT NULL
        AND vat_period.filing_confirmation_path IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Cannot reopen an accounting period after VAT filing confirmation has been uploaded for this quarter';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS acc_periods_prevent_reopen_after_vat_filing ON public.acc_periods;
CREATE TRIGGER acc_periods_prevent_reopen_after_vat_filing
BEFORE UPDATE OF status ON public.acc_periods
FOR EACH ROW
EXECUTE FUNCTION public.acc_prevent_reopening_filed_periods();
