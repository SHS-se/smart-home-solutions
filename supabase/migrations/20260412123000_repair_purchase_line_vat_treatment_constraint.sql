UPDATE public.acc_purchase_lines
SET vat_treatment = 'needs_review'
WHERE vat_treatment = 'reverse_charge';

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
