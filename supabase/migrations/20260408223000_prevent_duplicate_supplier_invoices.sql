ALTER TABLE public.acc_purchases
  ADD COLUMN IF NOT EXISTS supplier_invoice_number text;

UPDATE public.acc_purchases
SET supplier_invoice_number = upper(trim(
  regexp_replace(
    coalesce(notes, ''),
    '^(Supplier invoice no:|Leverantörens fakturanr:)\s*',
    '',
    'i'
  )
))
WHERE supplier_invoice_number IS NULL
  AND notes IS NOT NULL
  AND notes ~* '^(Supplier invoice no:|Leverantörens fakturanr:)';

CREATE INDEX IF NOT EXISTS acc_purchases_supplier_invoice_lookup_idx
  ON public.acc_purchases (supplier_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_duplicate_supplier_invoice_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.supplier_id IS NULL OR NEW.supplier_invoice_number IS NULL OR btrim(NEW.supplier_invoice_number) = '' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.acc_purchases p
    WHERE p.supplier_id = NEW.supplier_id
      AND upper(btrim(p.supplier_invoice_number)) = upper(btrim(NEW.supplier_invoice_number))
  ) THEN
    RAISE EXCEPTION 'Duplicate supplier invoice'
      USING ERRCODE = '23505',
            DETAIL = format(
              'Supplier %s already has invoice number %s',
              NEW.supplier_id,
              NEW.supplier_invoice_number
            ),
            HINT = 'Use the existing purchase instead of saving the same supplier invoice again.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_duplicate_supplier_invoice_insert_trg ON public.acc_purchases;
CREATE TRIGGER prevent_duplicate_supplier_invoice_insert_trg
  BEFORE INSERT ON public.acc_purchases
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_duplicate_supplier_invoice_insert();
