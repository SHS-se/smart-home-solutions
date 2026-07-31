/// <reference lib="deno.ns" />

import {
  buildEnergyBillingSeries,
  type EnergyBillingDocumentForSeries,
} from './energy-billing-series.ts';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function document(
  overrides: Partial<EnergyBillingDocumentForSeries> & Pick<EnergyBillingDocumentForSeries, 'id' | 'documentKind' | 'periodStart' | 'periodEnd'>,
): EnergyBillingDocumentForSeries {
  return {
    consumptionKwh: null,
    exportedKwh: null,
    peakDemandKw: null,
    totalAmountSek: 0,
    lineItems: [],
    ...overrides,
  };
}

Deno.test('billing series keeps missing months explicit and does not double-count consumption', () => {
  const documents: EnergyBillingDocumentForSeries[] = [
    document({
      id: 'grid-jan',
      documentKind: 'grid',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      consumptionKwh: 1000,
      totalAmountSek: 1500,
    }),
    document({
      id: 'electricity-jan',
      documentKind: 'electricity',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      consumptionKwh: 1000,
      totalAmountSek: 800,
    }),
    document({
      id: 'grid-mar',
      documentKind: 'grid',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      consumptionKwh: 700,
      totalAmountSek: 1200,
    }),
  ];

  const series = buildEnergyBillingSeries(documents);
  assertEqual(series.length, 3, 'month count');
  assertEqual(series[0].consumptionKwh, 1000, 'grid consumption wins instead of summing');
  assertEqual(series[0].totalCostSek, 2300, 'both cost sources are summed');
  assertEqual(series[1].monthKey, '2026-02', 'gap month');
  assertEqual(series[1].consumptionKwh, null, 'gap consumption');
  assertEqual(series[1].totalCostSek, null, 'gap cost');
  assertEqual(series[1].gridCoverage, 'missing', 'grid gap');
  assertEqual(series[1].electricityCoverage, 'missing', 'electricity gap');
  assertEqual(series[2].electricityCoverage, 'missing', 'source-specific gap');
});

Deno.test('split supplier invoices combine to complete monthly coverage', () => {
  const series = buildEnergyBillingSeries([
    document({
      id: 'grid-june',
      documentKind: 'grid',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      consumptionKwh: 35,
      exportedKwh: 337,
      totalAmountSek: 1144,
    }),
    document({
      id: 'supplier-a',
      documentKind: 'electricity',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-15',
      consumptionKwh: 22,
      exportedKwh: 190,
      totalAmountSek: -82.5,
    }),
    document({
      id: 'supplier-b',
      documentKind: 'electricity',
      periodStart: '2026-06-16',
      periodEnd: '2026-06-30',
      consumptionKwh: 13,
      exportedKwh: 146.58,
      totalAmountSek: -85,
    }),
  ]);

  assertEqual(series.length, 1, 'month count');
  assertEqual(series[0].electricityCoverage, 'complete', 'split coverage');
  assertEqual(series[0].electricityCoverageDays, 30, 'union days');
  assertEqual(series[0].electricityConsumptionKwh, 35, 'supplier consumption sum');
  assertEqual(series[0].consumptionKwh, 35, 'authoritative monthly consumption');
  assertEqual(series[0].exportedKwh, 337, 'grid export wins when equally complete');
  assertEqual(series[0].electricityCostSek, -167.5, 'supplier costs sum');
  assertEqual(series[0].totalCostSek, 976.5, 'combined total');
});

Deno.test('cost breakdown intentionally ignores unclassified invoice rounding', () => {
  const series = buildEnergyBillingSeries([
    document({
      id: 'grid',
      documentKind: 'grid',
      periodStart: '2025-09-01',
      periodEnd: '2025-09-30',
      consumptionKwh: 1323,
      peakDemandKw: 5.35,
      totalAmountSek: 2158,
      lineItems: [
        { category: 'fixed_fee', amountSek: 915, periodStart: null, periodEnd: null },
        { category: 'energy_transfer', amountSek: 82.66, periodStart: null, periodEnd: null },
        { category: 'peak_demand', amountSek: 434.53, periodStart: null, periodEnd: null },
        { category: 'energy_tax', amountSek: 725.82, periodStart: null, periodEnd: null },
      ],
    }),
  ]);

  assertEqual(series[0].gridFixedSek, 915, 'fixed cost');
  assertEqual(series[0].gridTransferSek, 82.66, 'transfer cost');
  assertEqual(series[0].gridPeakSek, 434.53, 'peak cost');
  assertEqual(series[0].energyTaxSek, 725.82, 'energy tax');
  assertEqual(series[0].peakDemandKw, 5.35, 'peak demand');
  assertEqual(
    series[0].gridFixedSek
      + series[0].gridTransferSek
      + series[0].gridPeakSek
      + series[0].energyTaxSek,
    2158.01,
    'visible charges remain their parsed values without a residual category',
  );
});

Deno.test('grid VAT remains separate from electricity supplier fees', () => {
  const series = buildEnergyBillingSeries([
    document({
      id: 'grid-vat',
      documentKind: 'grid',
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      totalAmountSek: 625,
      lineItems: [
        { category: 'fixed_fee', amountSek: 500, periodStart: null, periodEnd: null },
        { category: 'vat', amountSek: 125, periodStart: null, periodEnd: null },
      ],
    }),
  ]);

  assertEqual(series[0].gridVatSek, 125, 'grid VAT');
  assertEqual(series[0].electricityFeesSek, 0, 'electricity fees');
});

Deno.test('partial coverage is retained as partial data rather than zero or missing', () => {
  const series = buildEnergyBillingSeries([
    document({
      id: 'half-month',
      documentKind: 'electricity',
      periodStart: '2026-06-16',
      periodEnd: '2026-06-30',
      consumptionKwh: 13,
      totalAmountSek: -85,
    }),
  ]);

  assertEqual(series[0].electricityCoverage, 'partial', 'partial status');
  assertEqual(series[0].electricityCoverageDays, 15, 'covered days');
  assertEqual(series[0].consumptionKwh, 13, 'partial value retained');
  assert(series[0].totalCostSek !== null, 'partial cost should be visible');
});

Deno.test('multi-month invoices use dated line quantities instead of prorating consumption', () => {
  const series = buildEnergyBillingSeries([
    document({
      id: 'legacy-grid',
      documentKind: 'grid',
      periodStart: '2021-03-13',
      periodEnd: '2021-05-31',
      consumptionKwh: 60,
      totalAmountSek: 90,
      lineItems: [
        {
          category: 'fixed_fee',
          amountSek: 30,
          quantity: 80,
          periodStart: '2021-03-13',
          periodEnd: '2021-05-31',
        },
        {
          category: 'energy_transfer',
          amountSek: 10,
          quantity: 10,
          periodStart: '2021-03-13',
          periodEnd: '2021-03-31',
        },
        {
          category: 'energy_transfer',
          amountSek: 20,
          quantity: 20,
          periodStart: '2021-04-01',
          periodEnd: '2021-04-30',
        },
        {
          category: 'energy_transfer',
          amountSek: 30,
          quantity: 30,
          periodStart: '2021-05-01',
          periodEnd: '2021-05-31',
        },
      ],
    }),
  ]);

  assertEqual(series[0].consumptionKwh, 10, 'March line consumption');
  assertEqual(series[1].consumptionKwh, 20, 'April line consumption');
  assertEqual(series[2].consumptionKwh, 30, 'May line consumption');
  assertEqual(series[0].gridCoverage, 'partial', 'partial first month');
  assertEqual(series[1].gridCoverage, 'complete', 'complete April');
  assertEqual(series[2].gridCoverage, 'complete', 'complete May');
  assertEqual(
    Math.round(
      series.reduce((sum, month) => sum + (month.gridCostSek ?? 0), 0) * 100,
    ) / 100,
    90.01,
    'line-allocated cost total',
  );
});
