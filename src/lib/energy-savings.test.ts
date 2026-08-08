/// <reference lib="deno.ns" />

import type { EnergyBillingMonth } from './energy-billing-series.ts';
import type { MonthlyEnergyFlow } from './energy-usage-series.ts';
import {
  buildMonthlyEnergySavings,
  summariseEnergySavings,
  variableImportPriceSekPerKwh,
} from './energy-savings.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/**
 * A June bill that splits cleanly: 220 kr of grid charges follow the kWh and
 * 450 kr do not, 260 kr of the supplier's charges follow the kWh and 40 kr do
 * not, VAT is 25% on all of it, and 300 kWh were imported. Every variable
 * charge including its VAT comes to 600 kr, so a kWh costs exactly 2 kr.
 */
function month(overrides: Partial<EnergyBillingMonth> = {}): EnergyBillingMonth {
  return {
    monthKey: '2026-06',
    year: 2026,
    month: 6,
    daysInMonth: 30,
    gridCoverageDays: 30,
    electricityCoverageDays: 30,
    gridCoverage: 'complete',
    electricityCoverage: 'complete',
    consumptionSource: 'grid',
    exportSource: 'grid',
    consumptionKwh: 300,
    exportedKwh: 400,
    gridConsumptionKwh: 300,
    electricityConsumptionKwh: 300,
    gridCostSek: 837.5,
    electricityCostSek: 225,
    totalCostSek: 1062.5,
    peakDemandKw: 5,
    electricityEnergySek: 240,
    electricityFeesSek: 135,
    electricityFixedSek: 40,
    electricityVatSek: 75,
    gridFixedSek: 300,
    gridTransferSek: 90,
    gridPeakSek: 150,
    gridVatSek: 167.5,
    energyTaxSek: 130,
    exportNetSek: -150,
    ...overrides,
  };
}

function flow(overrides: Partial<MonthlyEnergyFlow> = {}): MonthlyEnergyFlow {
  return {
    monthKey: '2026-06',
    gridImportAverageKwh: 15,
    totalConsumptionAverageKwh: 25,
    selfSuppliedAverageKwh: 10,
    gridImportDays: 30,
    totalConsumptionDays: 20,
    pairedDays: 20,
    ...overrides,
  };
}

Deno.test('the avoided price counts only charges that follow the kWh', () => {
  assertEqual(variableImportPriceSekPerKwh(month()), 2, 'variable price');
});

Deno.test('a bill quoted inclusive of VAT prices the same as one that itemises it', () => {
  const inclusive = month({
    gridVatSek: 0,
    gridFixedSek: 375,
    gridTransferSek: 112.5,
    gridPeakSek: 187.5,
    energyTaxSek: 162.5,
    electricityVatSek: 0,
    electricityEnergySek: 300,
    electricityFeesSek: 75,
    electricityFixedSek: 50,
  });

  assertEqual(variableImportPriceSekPerKwh(inclusive), 2, 'VAT-inclusive price');
});

Deno.test('a half-covered supplier invoice is scaled to the whole month before pricing', () => {
  const half = month({
    electricityCoverageDays: 15,
    electricityCoverage: 'partial',
    electricityEnergySek: 120,
    electricityFeesSek: 67.5,
    electricityFixedSek: 20,
    electricityVatSek: 37.5,
  });

  assertEqual(variableImportPriceSekPerKwh(half), 2, 'scaled price');
});

Deno.test('a month missing half its bill is not priced at all', () => {
  assertEqual(
    variableImportPriceSekPerKwh(month({
      electricityCoverageDays: 0,
      electricityCoverage: 'missing',
    })),
    null,
    'unpriceable month',
  );
});

Deno.test('self-consumption is valued at the avoided price and export is added to it', () => {
  const [saving] = buildMonthlyEnergySavings([month()], [flow()]);

  assertEqual(saving.selfConsumedKwh, 200, 'self-consumed energy');
  assertEqual(saving.avoidedRateSekPerKwh, 2, 'avoided price');
  assertEqual(saving.avoidedImportSek, 400, 'avoided purchases');
  assertEqual(saving.exportIncomeSek, 150, 'export income');
  assertEqual(saving.savingSek, 550, 'monthly saving');
  assertEqual(saving.measuredDays, 20, 'measured days');
});

Deno.test('a month with no whole-home reading still reports what export paid', () => {
  const [saving] = buildMonthlyEnergySavings([month()], []);

  assertEqual(saving.selfConsumedKwh, null, 'self-consumed energy');
  assertEqual(saving.avoidedImportSek, null, 'avoided purchases');
  assertEqual(saving.exportIncomeSek, 150, 'export income');
  assertEqual(saving.savingSek, 150, 'monthly saving');
});

Deno.test('export fees larger than the credit read as a cost, not a saving', () => {
  const [saving] = buildMonthlyEnergySavings([month({ exportNetSek: 40 })], []);

  assertEqual(saving.exportIncomeSek, -40, 'net export income');
});

Deno.test('the summary measures only the months it could measure', () => {
  const summary = summariseEnergySavings(buildMonthlyEnergySavings(
    [
      month({ monthKey: '2026-05', month: 5, daysInMonth: 31 }),
      month(),
    ],
    [flow()],
  ));

  assertEqual(summary.avoidedImportSek, 400, 'avoided purchases');
  assertEqual(summary.exportIncomeSek, 300, 'export income across both months');
  assertEqual(summary.savingSek, 700, 'total saving');
  assertEqual(summary.selfConsumedKwh, 200, 'measured self-consumption');
  assertEqual(summary.averageAvoidedRateSekPerKwh, 2, 'average avoided price');
  assertEqual(summary.measuredDays, 20, 'measured days');
  assertEqual(summary.measuredMonths, 1, 'measured months');
  assertEqual(summary.unmeasuredMonths, 1, 'months with a bill but no reading');
  assertEqual(summary.billedCostSek, 2125, 'billed cost of contributing months');
  assertEqual(summary.costWithoutSelfSupplySek, 2825, 'cost without solar or battery');
  assertEqual(summary.savedShare, 0.2478, 'share of the counterfactual bill');
  assertEqual(summary.firstMeasuredMonth, '2026-06', 'first measured month');
});

Deno.test('nothing measured and nothing billed reports null rather than zero', () => {
  const summary = summariseEnergySavings(buildMonthlyEnergySavings(
    [month({
      gridCoverageDays: 0,
      electricityCoverageDays: 0,
      gridCoverage: 'missing',
      electricityCoverage: 'missing',
      totalCostSek: null,
    })],
    [],
  ));

  assertEqual(summary.savingSek, null, 'total saving');
  assertEqual(summary.savedShare, null, 'share');
  assertEqual(summary.measuredMonths, 0, 'measured months');
});
