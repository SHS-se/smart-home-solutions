import {
  ENERGY_CHARGE_CATEGORIES,
  type EnergyChargeCategory,
} from './energy-billing-parser';
import type { EnergyBillingDocumentForSeries } from './energy-billing-series';
import { buildEnergyBillingSeries } from './energy-billing-series';
import type { EnergyBillingChangeDocument } from './energy-billing-changes';

const CHARGE_CATEGORIES = new Set<string>(ENERGY_CHARGE_CATEGORIES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface EnergyTariffCalculationForSeries {
  id: string;
  billing_month: string;
  coverage_start: string;
  coverage_end: string;
  grid_import_kwh: number;
  grid_export_kwh: number;
  peak_demand_kw: number | null;
  calculation_version: number;
  components: unknown;
  total_amount_sek: number;
}

interface TariffCalculationComponent {
  category: EnergyChargeCategory;
  label: string;
  amount_sek: number;
  quantity: number | null;
  unit_price_sek: number | null;
  period_start: string;
  period_end: string;
}

export interface EnergyTariffInvoiceComparison {
  monthKey: string;
  invoiceAmountSek: number;
  haEstimateAmountSek: number;
  differenceSek: number;
  differenceRatio: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseComponents(value: unknown): TariffCalculationComponent[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Tariff calculation has no components');
  }

  return value.map((component) => {
    if (!isRecord(component)) throw new Error('Invalid tariff calculation component');
    const category = String(component.category ?? '');
    const label = String(component.label ?? '').trim();
    const amountSek = Number(component.amount_sek);
    const quantity = component.quantity === null ? null : Number(component.quantity);
    const unitPriceSek = component.unit_price_sek === null
      ? null
      : Number(component.unit_price_sek);
    const periodStart = String(component.period_start ?? '');
    const periodEnd = String(component.period_end ?? '');
    if (
      !CHARGE_CATEGORIES.has(category)
      || label.length === 0
      || !Number.isFinite(amountSek)
      || (quantity !== null && !Number.isFinite(quantity))
      || (unitPriceSek !== null && !Number.isFinite(unitPriceSek))
      || !DATE_RE.test(periodStart)
      || !DATE_RE.test(periodEnd)
    ) {
      throw new Error('Invalid tariff calculation component');
    }
    return {
      category: category as EnergyChargeCategory,
      label,
      amount_sek: amountSek,
      quantity,
      unit_price_sek: unitPriceSek,
      period_start: periodStart,
      period_end: periodEnd,
    };
  });
}

export function tariffCalculationsWithoutImportedGridMonths(
  importedDocuments: EnergyBillingDocumentForSeries[],
  calculations: EnergyTariffCalculationForSeries[],
): EnergyTariffCalculationForSeries[] {
  const importedGridMonths = new Set(
    importedDocuments
      .filter((document) => document.documentKind === 'grid')
      .flatMap((document) => monthKeysBetween(document.periodStart, document.periodEnd)),
  );
  return calculations.filter(
    (calculation) => !importedGridMonths.has(calculation.billing_month.slice(0, 7)),
  );
}

export function toEnergyTariffChangeDocuments(
  calculations: EnergyTariffCalculationForSeries[],
): EnergyBillingChangeDocument[] {
  return calculations.map((calculation) => {
    const components = parseComponents(calculation.components);
    const hasPeakDemand = components.some(
      (component) => component.category === 'peak_demand',
    );
    return {
      id: `tariff-calculation:${calculation.id}`,
      document_kind: 'grid',
      provider_key: 'ellevio',
      provider_name: 'Ellevio',
      parser_id: hasPeakDemand ? 'ellevio_peak_demand' : 'ellevio_flat_transfer',
      parser_version: calculation.calculation_version,
      period_start: calculation.coverage_start,
      period_end: calculation.coverage_end,
      lineItems: components.map((component) => ({
        category: component.category,
        label: component.label,
        unit_price_sek: component.unit_price_sek,
        period_start: component.period_start,
      })),
    };
  });
}

export function toEnergyTariffSeriesDocuments(
  calculations: EnergyTariffCalculationForSeries[],
): EnergyBillingDocumentForSeries[] {
  return calculations.map((calculation) => ({
    id: `tariff-calculation:${calculation.id}`,
    documentKind: 'grid',
    periodStart: calculation.coverage_start,
    periodEnd: calculation.coverage_end,
    consumptionKwh: calculation.grid_import_kwh,
    exportedKwh: calculation.grid_export_kwh,
    peakDemandKw: calculation.peak_demand_kw,
    totalAmountSek: calculation.total_amount_sek,
    lineItems: parseComponents(calculation.components).map((component) => ({
      category: component.category,
      amountSek: component.amount_sek,
      quantity: component.quantity,
      periodStart: component.period_start,
      periodEnd: component.period_end,
    })),
  }));
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

/**
 * Add HA-calculated grid costs to the billing graph. An imported grid invoice
 * is authoritative for every month it touches, so its calculated counterpart
 * is omitted instead of double-counted.
 */
export function mergeEnergyBillingAndTariffDocuments(
  importedDocuments: EnergyBillingDocumentForSeries[],
  calculations: EnergyTariffCalculationForSeries[],
): EnergyBillingDocumentForSeries[] {
  const calculatedDocuments = toEnergyTariffSeriesDocuments(
    tariffCalculationsWithoutImportedGridMonths(importedDocuments, calculations),
  );

  return [...importedDocuments, ...calculatedDocuments].sort((a, b) => (
    a.periodStart.localeCompare(b.periodStart) || a.id.localeCompare(b.id)
  ));
}

/** Months where an authoritative grid invoice and the retained HA estimate coexist. */
export function buildEnergyTariffInvoiceComparisons(
  importedDocuments: EnergyBillingDocumentForSeries[],
  calculations: EnergyTariffCalculationForSeries[],
): EnergyTariffInvoiceComparison[] {
  const invoiceSeries = buildEnergyBillingSeries(
    importedDocuments.filter((document) => document.documentKind === 'grid'),
  );
  const estimateSeries = buildEnergyBillingSeries(toEnergyTariffSeriesDocuments(calculations));
  const estimatesByMonth = new Map(
    estimateSeries.map((month) => [month.monthKey, month.gridCostSek]),
  );
  return invoiceSeries.flatMap((month) => {
    const estimate = estimatesByMonth.get(month.monthKey);
    if (typeof month.gridCostSek !== 'number' || typeof estimate !== 'number') return [];
    return [{
      monthKey: month.monthKey,
      invoiceAmountSek: month.gridCostSek,
      haEstimateAmountSek: estimate,
      differenceSek: Math.round((estimate - month.gridCostSek) * 100) / 100,
      differenceRatio: month.gridCostSek === 0
        ? 0
        : (estimate - month.gridCostSek) / month.gridCostSek,
    }];
  });
}

/**
 * A month is only worth cautioning about when it is off by a real share *and* a
 * real amount.
 *
 * A percentage alone is the wrong test. The measured error between a meter and
 * an inverter behaves like a fixed daily offset, so the same absolute drift is
 * a rounding error across a 2 000 kWh winter month and a third of a 35 kWh
 * summer one. Requiring both keeps the warning for months where the money
 * actually moved.
 */
export const TARIFF_DIVERGENCE_RATIO = 0.05;
export const TARIFF_DIVERGENCE_SEK = 100;

export function divergentTariffComparisons(
  comparisons: readonly EnergyTariffInvoiceComparison[],
): EnergyTariffInvoiceComparison[] {
  return comparisons.filter((comparison) => (
    Math.abs(comparison.differenceRatio) > TARIFF_DIVERGENCE_RATIO
    && Math.abs(comparison.differenceSek) > TARIFF_DIVERGENCE_SEK
  ));
}
