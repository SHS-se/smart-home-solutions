UPDATE public.acc_purchase_lines AS lines
SET vat_treatment = CASE
  WHEN suppliers.supplier_type = 'eu' THEN 'reverse_charge_eu_services'
  WHEN suppliers.supplier_type = 'non_eu' THEN 'reverse_charge_non_eu_services'
  WHEN suppliers.name = 'Stripe Payments Europe, Limited' THEN 'reverse_charge_eu_services'
  ELSE lines.vat_treatment
END
FROM public.acc_purchases AS purchases
LEFT JOIN public.acc_suppliers AS suppliers
  ON suppliers.id = purchases.supplier_id
WHERE purchases.id = lines.purchase_id
  AND lines.vat_treatment = 'reverse_charge';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.acc_purchase_lines
    WHERE vat_treatment = 'reverse_charge'
  ) THEN
    RAISE EXCEPTION 'Legacy reverse_charge vat_treatment rows remain after normalization';
  END IF;
END $$;

ALTER TABLE public.acc_purchase_lines
  DROP CONSTRAINT IF EXISTS acc_purchase_lines_vat_treatment_check;

ALTER TABLE public.acc_purchase_lines
  ADD CONSTRAINT acc_purchase_lines_vat_treatment_check
  CHECK (
    vat_treatment IN (
      'domestic_deductible',
      'reverse_charge_eu_goods',
      'reverse_charge_eu_services',
      'reverse_charge_non_eu_services',
      'non_deductible',
      'no_vat',
      'needs_review'
    )
  );
