DELETE FROM public.energy_billing_line_items
WHERE category IN ('rounding', 'other');

ALTER TABLE public.energy_billing_line_items
  DROP CONSTRAINT energy_billing_line_items_category_check;

ALTER TABLE public.energy_billing_line_items
  ADD CONSTRAINT energy_billing_line_items_category_check
  CHECK (
    category IN (
      'spot_energy',
      'variable_fee',
      'markup',
      'fixed_fee',
      'energy_transfer',
      'peak_demand',
      'energy_tax',
      'export_credit',
      'export_fee',
      'discount',
      'vat'
    )
  );
