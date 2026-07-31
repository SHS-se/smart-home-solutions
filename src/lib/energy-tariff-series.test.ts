/// <reference lib="deno.ns" />

import type { EnergyBillingDocumentForSeries } from './energy-billing-series.ts';
import {
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
