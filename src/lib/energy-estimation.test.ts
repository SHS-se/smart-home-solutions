/// <reference lib="deno.ns" />

import {
  estimateAnnualEnergyHistory,
  estimateNormalYearFromTemperatureSweep,
  SWEDISH_RESIDENTIAL_CONSUMPTION_SHARES,
  type AnnualEnergyHistoryEstimate,
} from './energy-estimation.ts';
import type { EnergyBillingMonth } from './energy-billing-series.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function month(
  monthNumber: number,
  overrides: Partial<EnergyBillingMonth> = {},
): EnergyBillingMonth {
  const daysInMonth = new Date(Date.UTC(2026, monthNumber, 0)).getUTCDate();
  return {
    monthKey: `2026-${String(monthNumber).padStart(2, '0')}`,
    year: 2026,
    month: monthNumber,
    daysInMonth,
    gridCoverageDays: daysInMonth,
    electricityCoverageDays: daysInMonth,
    gridCoverage: 'complete',
    electricityCoverage: 'complete',
    consumptionSource: 'grid',
    exportSource: 'grid',
    consumptionKwh: 100,
    exportedKwh: 0,
    gridConsumptionKwh: 100,
    electricityConsumptionKwh: 100,
    gridCostSek: 100,
    electricityCostSek: 100,
    totalCostSek: 200,
    peakDemandKw: null,
    electricityEnergySek: 0,
    electricityFeesSek: 0,
    gridFixedSek: 0,
    gridTransferSek: 0,
    gridPeakSek: 0,
    energyTaxSek: 0,
    exportNetSek: 0,
    ...overrides,
  };
}

function annualConsumption(estimate: AnnualEnergyHistoryEstimate): number | null {
  return estimate.consumptionKwh.value;
}

Deno.test('twelve complete months are reported as an actual annual total', () => {
  const estimate = estimateAnnualEnergyHistory(
    Array.from({ length: 12 }, (_, index) => month(index + 1)),
  );

  assertEqual(annualConsumption(estimate), 1200, 'annual consumption');
  assertEqual(estimate.consumptionKwh.estimated, false, 'estimated flag');
  assertEqual(estimate.totalCostSek.value, 2400, 'annual total cost');
  assertEqual(estimate.totalCostSek.estimated, false, 'cost estimated flag');
});

Deno.test('partial history is annualized with residential seasonal shares', () => {
  const series = [1, 2, 3].map((monthNumber) => month(monthNumber, {
    consumptionKwh: SWEDISH_RESIDENTIAL_CONSUMPTION_SHARES[monthNumber - 1] * 10_000,
  }));
  const estimate = estimateAnnualEnergyHistory(series);

  assertEqual(annualConsumption(estimate), 10_000, 'seasonally annualized consumption');
  assertEqual(estimate.consumptionKwh.estimated, true, 'estimated flag');
  assertEqual(estimate.consumptionKwh.observedMonths, 3, 'observed months');
});

Deno.test('partial invoice months are normalized by covered days before annualization', () => {
  const january = month(1, {
    gridCoverageDays: 15,
    gridCoverage: 'partial',
    consumptionKwh: 1250 * 15 / 31,
  });
  const estimate = estimateAnnualEnergyHistory([january]);

  assertEqual(annualConsumption(estimate), 10_000, 'partial-month annualization');
  assertEqual(estimate.consumptionKwh.completeMonths, 0, 'complete months');
});

Deno.test('normal-year simulator estimate uses all calendar months', () => {
  const estimate = estimateNormalYearFromTemperatureSweep([
    { tempC: -20, dailyKwh: 10, peakW: 1000 },
    { tempC: 20, dailyKwh: 10, peakW: 1000 },
  ]);

  assertEqual(estimate.annualKwh, 3650, 'normal-year energy');
  assertEqual(estimate.annualPeakWMonths, 12_000, 'monthly peak sum');
  assertEqual(estimate.monthly.length, 12, 'calendar months');
});
