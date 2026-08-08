/// <reference lib="deno.ns" />

import type { EnergyBillingDocumentForSeries } from './energy-billing-series.ts';
import {
  type EnergySupplierDailyCostRecord,
  mergeSupplierEstimates,
  summariseSupplierMonths,
} from './energy-supplier-series.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function cost(
  costDate: string,
  importKwh: number,
  importCostSek: number,
  pricedHours = 24,
  exportCreditSek = 0,
): EnergySupplierDailyCostRecord {
  return {
    id: `cost-${costDate}`,
    customer_id: 'customer-1',
    cost_date: costDate,
    import_kwh: importKwh,
    import_cost_sek: importCostSek,
    export_kwh: exportCreditSek === 0 ? 0 : 10,
    export_credit_sek: exportCreditSek,
    priced_hours: pricedHours,
    device_token_id: 'token-1',
    created_at: '2026-08-08T00:20:00Z',
    updated_at: '2026-08-08T00:20:00Z',
  };
}

function invoice(
  id: string,
  documentKind: 'grid' | 'electricity',
  periodStart: string,
  periodEnd: string,
): EnergyBillingDocumentForSeries {
  return {
    id,
    documentKind,
    periodStart,
    periodEnd,
    consumptionKwh: 100,
    exportedKwh: null,
    peakDemandKw: null,
    totalAmountSek: 500,
    lineItems: [],
  };
}

Deno.test('daily supplier costs roll up into a month', () => {
  const months = summariseSupplierMonths([
    cost('2026-07-01', 2, 1.2),
    cost('2026-07-02', 3, 2.3),
    cost('2026-08-01', 1, 0.8),
  ]);

  assertEqual(months.length, 2, 'month count');
  assertEqual(months[0].monthKey, '2026-07', 'first month');
  assertEqual(months[0].importKwh, 5, 'import kWh summed');
  assertEqual(months[0].totalAmountSek, 3.5, 'cost summed');
  assertEqual(months[0].days, 2, 'day count');
});

Deno.test('a day priced on only part of its hours is left out', () => {
  const months = summariseSupplierMonths([
    cost('2026-07-01', 2, 1.2),
    cost('2026-07-02', 30, 18, 6),
  ]);

  assertEqual(months[0].days, 1, 'partial day dropped');
  assertEqual(months[0].totalAmountSek, 1.2, 'its cost is not counted either');
});

Deno.test('export credit reduces the month and becomes its own line', () => {
  const months = summariseSupplierMonths([cost('2026-07-01', 2, 10, 24, 4)]);
  assertEqual(months[0].totalAmountSek, 6, 'credit subtracted');

  const merged = mergeSupplierEstimates([], [cost('2026-07-01', 2, 10, 24, 4)]);
  assertEqual(merged.length, 1, 'one estimate document');
  assertEqual(merged[0].lineItems.length, 2, 'spot energy plus export credit');
  assertEqual(merged[0].lineItems[1].amountSek, -4, 'credit is negative');
});

Deno.test('an uploaded electricity invoice suppresses the estimate for its months', () => {
  const merged = mergeSupplierEstimates(
    [invoice('doc-1', 'electricity', '2026-07-01', '2026-07-31')],
    [cost('2026-07-15', 2, 1.2), cost('2026-08-01', 3, 2.4)],
  );

  assertEqual(merged.length, 2, 'invoice plus one estimate');
  assertEqual(
    merged.filter((document) => document.id.startsWith('supplier-estimate')).length,
    1,
    'July estimate dropped',
  );
  assertEqual(
    merged.find((document) => document.id.startsWith('supplier-estimate'))?.periodStart,
    '2026-08-01',
    'August still estimated',
  );
});

Deno.test('a grid invoice does not suppress the supplier estimate', () => {
  const merged = mergeSupplierEstimates(
    [invoice('doc-1', 'grid', '2026-07-01', '2026-07-31')],
    [cost('2026-07-15', 2, 1.2)],
  );

  assertEqual(merged.length, 2, 'the grid invoice covers a different cost');
});
