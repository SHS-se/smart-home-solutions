/// <reference lib="deno.ns" />

import type { EnergyBillingDocumentForSeries } from './energy-billing-series.ts';
import {
  buildEnergyTariffInvoiceComparisons,
  divergentTariffComparisons,
  mergeEnergyBillingAndTariffDocuments,
  toEnergyTariffSeriesDocuments,
  toEnergyTariffChangeDocuments,
  type EnergyTariffCalculationForSeries,
} from './energy-tariff-series.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function calculation(
  id: string,
  billingMonth: string,
): EnergyTariffCalculationForSeries {
  const periodEnd = billingMonth === '2026-06-01' ? '2026-06-30' : '2026-07-31';
  return {
    id,
    billing_month: billingMonth,
    coverage_start: billingMonth,
    coverage_end: periodEnd,
    grid_import_kwh: 500,
    grid_export_kwh: 25,
    peak_demand_kw: null,
    calculation_version: 1,
    components: [
      {
        category: 'fixed_fee',
        label: 'Fixed grid fee',
        amount_sek: 450,
        quantity: 1,
        unit_price_sek: 450,
        period_start: billingMonth,
        period_end: periodEnd,
      },
      {
        category: 'energy_transfer',
        label: 'Grid energy transfer',
        amount_sek: 130,
        quantity: 500,
        unit_price_sek: 0.26,
        period_start: billingMonth,
        period_end: periodEnd,
      },
      {
        category: 'vat',
        label: 'VAT',
        amount_sek: 145,
        quantity: null,
        unit_price_sek: 0.25,
        period_start: billingMonth,
        period_end: periodEnd,
      },
    ],
    total_amount_sek: 725,
  };
}

Deno.test('tariff calculations become grid documents with component detail', () => {
  const [document] = toEnergyTariffSeriesDocuments([
    calculation('calculation-june', '2026-06-01'),
  ]);

  assertEqual(document.documentKind, 'grid', 'document kind');
  assertEqual(document.periodEnd, '2026-06-30', 'coverage end');
  assertEqual(document.consumptionKwh, 500, 'import quantity');
  assertEqual(document.exportedKwh, 25, 'export quantity');
  assertEqual(document.lineItems.length, 3, 'component count');
  assertEqual(document.lineItems[1].category, 'energy_transfer', 'component category');

  const [changeDocument] = toEnergyTariffChangeDocuments([
    calculation('calculation-june', '2026-06-01'),
  ]);
  assertEqual(changeDocument.provider_key, 'ellevio', 'change provider');
  assertEqual(changeDocument.parser_id, 'ellevio_flat_transfer', 'change model');
});

Deno.test('authoritative invoices and HA estimates remain available for comparison', () => {
  const invoice: EnergyBillingDocumentForSeries = {
    id: 'invoice-june',
    documentKind: 'grid',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    consumptionKwh: 500,
    exportedKwh: 25,
    peakDemandKw: null,
    totalAmountSek: 700,
    lineItems: [],
  };

  const [comparison] = buildEnergyTariffInvoiceComparisons(
    [invoice],
    [calculation('calculation-june', '2026-06-01')],
  );

  assertEqual(comparison.invoiceAmountSek, 700, 'invoice amount');
  assertEqual(comparison.haEstimateAmountSek, 725, 'HA estimate');
  assertEqual(comparison.differenceSek, 25, 'difference');
});

Deno.test('an imported grid invoice replaces the calculation for every month it touches', () => {
  const imported: EnergyBillingDocumentForSeries = {
    id: 'invoice',
    documentKind: 'grid',
    periodStart: '2026-06-15',
    periodEnd: '2026-07-14',
    consumptionKwh: 600,
    exportedKwh: 0,
    peakDemandKw: null,
    totalAmountSek: 900,
    lineItems: [],
  };

  const merged = mergeEnergyBillingAndTariffDocuments(
    [imported],
    [
      calculation('calculation-june', '2026-06-01'),
      calculation('calculation-july', '2026-07-01'),
    ],
  );

  assertEqual(merged.length, 1, 'document count');
  assertEqual(merged[0].id, 'invoice', 'authoritative document');
});

Deno.test('an electricity invoice does not hide a grid calculation', () => {
  const electricity: EnergyBillingDocumentForSeries = {
    id: 'electricity-invoice',
    documentKind: 'electricity',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    consumptionKwh: 500,
    exportedKwh: 25,
    peakDemandKw: null,
    totalAmountSek: 400,
    lineItems: [],
  };

  const merged = mergeEnergyBillingAndTariffDocuments(
    [electricity],
    [calculation('calculation-june', '2026-06-01')],
  );

  assertEqual(merged.length, 2, 'document count');
  assertEqual(merged[1].documentKind, 'grid', 'calculated grid document');
});

Deno.test('a divergence needs both a real share and a real amount', () => {
  const comparisons = [
    // Summer: a third off, but only 30 kr — the fixed daily offset between an
    // inverter and a meter, not a fault worth warning about.
    { monthKey: '2026-06', invoiceAmountSek: 90, haEstimateAmountSek: 120, differenceSek: 30, differenceRatio: 0.333 },
    // Winter: 400 kr adrift and well past 5 %.
    { monthKey: '2026-01', invoiceAmountSek: 3000, haEstimateAmountSek: 3400, differenceSek: 400, differenceRatio: 0.133 },
    // Large but proportionally tiny.
    { monthKey: '2025-12', invoiceAmountSek: 3000, haEstimateAmountSek: 3120, differenceSek: 120, differenceRatio: 0.04 },
  ];

  const flagged = divergentTariffComparisons(comparisons);

  assertEqual(flagged.length, 1, 'only one month qualifies');
  assertEqual(flagged[0].monthKey, '2026-01', 'the winter month');
});

Deno.test('the comparison carries the ratio the caution thresholds on', () => {
  const invoice: EnergyBillingDocumentForSeries = {
    id: 'invoice-june',
    documentKind: 'grid',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    consumptionKwh: 500,
    exportedKwh: 25,
    peakDemandKw: null,
    totalAmountSek: 700,
    lineItems: [],
  };

  const [comparison] = buildEnergyTariffInvoiceComparisons(
    [invoice],
    [calculation('calculation-june', '2026-06-01')],
  );

  // 725 against 700 is 25 kr, so a shade over 3,5 % — under both thresholds.
  assertEqual(Math.round(comparison.differenceRatio * 10000) / 10000, 0.0357, 'ratio');
  assertEqual(divergentTariffComparisons([comparison]).length, 0, 'not flagged');
});
