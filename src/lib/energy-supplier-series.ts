import type { EnergyBillingDocumentForSeries } from './energy-billing-series';
import type { Tables } from '@/integrations/supabase/types';

export type EnergySupplierDailyCostRecord = Tables<'energy_supplier_daily_costs'>;

/** The daily supplier costs a month needs before it is worth charting. */
const MIN_PRICED_HOURS_PER_DAY = 20;

export interface SupplierMonthEstimate {
  monthKey: string;
  periodStart: string;
  periodEnd: string;
  importKwh: number;
  exportKwh: number;
  importCostSek: number;
  exportCreditSek: number;
  totalAmountSek: number;
  days: number;
  fullyPricedDays: number;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Roll Home Assistant's daily supplier costs up per month.
 *
 * Days priced on only part of their hours are dropped: a day valued on six of
 * its hours understates the month, and understating it silently is worse than
 * showing a shorter month.
 */
export function summariseSupplierMonths(
  costs: readonly EnergySupplierDailyCostRecord[],
): SupplierMonthEstimate[] {
  const byMonth = new Map<string, SupplierMonthEstimate>();
  for (const cost of costs) {
    if (cost.priced_hours < MIN_PRICED_HOURS_PER_DAY) continue;
    const monthKey = cost.cost_date.slice(0, 7);
    const month = byMonth.get(monthKey) ?? {
      monthKey,
      periodStart: cost.cost_date,
      periodEnd: cost.cost_date,
      importKwh: 0,
      exportKwh: 0,
      importCostSek: 0,
      exportCreditSek: 0,
      totalAmountSek: 0,
      days: 0,
      fullyPricedDays: 0,
    };
    month.periodStart = month.periodStart < cost.cost_date ? month.periodStart : cost.cost_date;
    month.periodEnd = month.periodEnd > cost.cost_date ? month.periodEnd : cost.cost_date;
    month.importKwh += cost.import_kwh;
    month.exportKwh += cost.export_kwh;
    month.importCostSek += cost.import_cost_sek;
    month.exportCreditSek += cost.export_credit_sek;
    month.days += 1;
    if (cost.priced_hours >= 23) month.fullyPricedDays += 1;
    byMonth.set(monthKey, month);
  }

  return [...byMonth.values()]
    .map((month) => ({
      ...month,
      importKwh: round(month.importKwh, 3),
      exportKwh: round(month.exportKwh, 3),
      importCostSek: round(month.importCostSek, 2),
      exportCreditSek: round(month.exportCreditSek, 2),
      totalAmountSek: round(month.importCostSek - month.exportCreditSek, 2),
    }))
    .sort((left, right) => left.monthKey.localeCompare(right.monthKey));
}

/** Months already covered by an uploaded electricity invoice, which always wins. */
export function supplierMonthsWithoutInvoice(
  importedDocuments: readonly EnergyBillingDocumentForSeries[],
  months: readonly SupplierMonthEstimate[],
): SupplierMonthEstimate[] {
  const invoiced = new Set(
    importedDocuments
      .filter((document) => document.documentKind === 'electricity')
      .flatMap((document) => monthKeysBetween(document.periodStart, document.periodEnd)),
  );
  return months.filter((month) => !invoiced.has(month.monthKey));
}

/** Present a month of Home Assistant supplier cost as an electricity document. */
export function toSupplierSeriesDocuments(
  months: readonly SupplierMonthEstimate[],
): EnergyBillingDocumentForSeries[] {
  return months.map((month) => ({
    id: `supplier-estimate:${month.monthKey}`,
    documentKind: 'electricity',
    periodStart: month.periodStart,
    periodEnd: month.periodEnd,
    consumptionKwh: month.importKwh,
    exportedKwh: month.exportKwh,
    peakDemandKw: null,
    totalAmountSek: month.totalAmountSek,
    lineItems: [
      {
        category: 'spot_energy',
        amountSek: month.importCostSek,
        quantity: month.importKwh,
        periodStart: month.periodStart,
        periodEnd: month.periodEnd,
      },
      ...(month.exportCreditSek === 0 ? [] : [{
        category: 'export_credit' as const,
        amountSek: -month.exportCreditSek,
        quantity: month.exportKwh,
        periodStart: month.periodStart,
        periodEnd: month.periodEnd,
      }]),
    ],
  }));
}

/**
 * Add estimated supplier cost to the billing graph for every month without an
 * uploaded electricity invoice.
 */
export function mergeSupplierEstimates(
  importedDocuments: EnergyBillingDocumentForSeries[],
  costs: readonly EnergySupplierDailyCostRecord[],
): EnergyBillingDocumentForSeries[] {
  const estimates = toSupplierSeriesDocuments(
    supplierMonthsWithoutInvoice(importedDocuments, summariseSupplierMonths(costs)),
  );
  if (estimates.length === 0) return importedDocuments;
  return [...importedDocuments, ...estimates].sort((left, right) => (
    left.periodStart.localeCompare(right.periodStart) || left.id.localeCompare(right.id)
  ));
}

function monthKeysBetween(startValue: string, endValue: string): string[] {
  const start = new Date(`${startValue}T00:00:00Z`);
  const end = new Date(`${endValue}T00:00:00Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) {
    throw new Error('Invalid energy billing period');
  }
  const keys: string[] = [];
  for (
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    cursor <= end;
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  ) {
    keys.push(cursor.toISOString().slice(0, 7));
  }
  return keys;
}
