import type { SupplierDefinitionV1 } from './energy-supplier-pricing.ts';

/** ROI-only snapshot; never publish these replay terms to the live planner catalogue. */
export const ROI_SUPPLIER_TERMS = {
  provider: 'tibber',
  revision: 'roi_tibber_2026-10-11',
  verifiedOn: '2026-10-11',
  variableCostMonth: '2026-09',
  sourceUrl: 'https://tibber.com/se/sammanfattning-avtalsvillkor',
  definition: {
    schema_version: 1, vat_rate: .25,
    import: { spot_multiplier: 1, fixed_markup_sek_per_kwh_ex_vat: .06, variable_cost_sek_per_kwh_ex_vat: .0352 },
    export: { spot_multiplier: 1, adjustment_sek_per_kwh: 0 },
    monthly_fee_sek_in_vat: 49,
  } satisfies SupplierDefinitionV1,
};

/** One explicitly selected current contract for the entire historical replay. */
export function roiSupplierVersion() {
  return { revision: ROI_SUPPLIER_TERMS.revision, valid_from: '0001-01-01', valid_to: null, definition: ROI_SUPPLIER_TERMS.definition };
}
