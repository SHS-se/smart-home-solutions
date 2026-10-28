import type { ComparisonCapture } from './browser.ts';
import type { ModelComparison } from './model-comparison.ts';

export const ROI_PRICING_POLICY = 'energy-and-fixed-fees-v1' as const;
export interface ModeledCost {
  energySek: number;
  supplierFixedSek: number;
  gridFixedSek: number;
  totalSek: number;
}
export interface ModeledCosts {
  policy: typeof ROI_PRICING_POLICY;
  baseline: ModeledCost;
  scheduler: ModeledCost;
  savingSek: number;
}

const money = new Intl.NumberFormat('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const roundedSek = (amount: number) => Number(money.format(amount));

/** All report arithmetic uses the monthly amounts the customer can see. */
export function monthlyBillAmounts(modeled: Pick<ModelComparison, 'baselineBill' | 'schedulerBill'>) {
  const costs = modeledCosts(modeled);
  const withoutSek = roundedSek(costs.baseline.totalSek), withSek = roundedSek(costs.scheduler.totalSek);
  return { withoutSek, withSek, savingSek: roundedSek(withoutSek - withSek) };
}

/** Simulation receipts retain dated tariff evidence and stable pool identities.
 * Payable ROI model costs exclude demand charges; Actual remains invoice evidence. */
export function modeledCosts(modeled: Pick<ModelComparison, 'baselineBill' | 'schedulerBill'>): ModeledCosts {
  const cost = (bill: ModelComparison['baselineBill']): ModeledCost => {
    const { supplierFixedSek, gridFixedSek, gridPeakSek, totalSek } = bill;
    if (![supplierFixedSek, gridFixedSek, gridPeakSek, totalSek].every(Number.isFinite)) throw new Error('Invalid modeled bill evidence');
    return { supplierFixedSek, gridFixedSek, energySek: totalSek - supplierFixedSek - gridFixedSek - gridPeakSek,
      totalSek: totalSek - gridPeakSek };
  };
  const baseline = cost(modeled.baselineBill), scheduler = cost(modeled.schedulerBill);
  return { policy: ROI_PRICING_POLICY, baseline, scheduler, savingSek: baseline.totalSek - scheduler.totalSek };
}

export function cumulativeModeledCost(cost: ModeledCost, cumulativeEnergySek: readonly (number | null)[]): (number | null)[] {
  const fixedSek = cost.supplierFixedSek + cost.gridFixedSek;
  return cumulativeEnergySek.map((energy, i) => energy === null ? null : energy + fixedSek * (i + 1) / cumulativeEnergySek.length);
}

/** Downloads present the same model costs as the portal, naming raw tariff evidence separately. */
export function roiComparisonExport(capture: ComparisonCapture) {
  const costs = modeledCosts(capture.modeled);
  return { ...capture, pricingPolicy: costs.policy,
    modeled: { ...capture.modeled, baselineBill: costs.baseline, schedulerBill: costs.scheduler },
    tariffEvidence: { baselineBill: capture.modeled.baselineBill, schedulerBill: capture.modeled.schedulerBill } };
}
