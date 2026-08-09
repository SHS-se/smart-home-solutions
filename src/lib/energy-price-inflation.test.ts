/// <reference lib="deno.ns" />

import type { EnergyBillingMonth } from './energy-billing-series.ts';
import { buildEnergyPriceInflation } from './energy-price-inflation.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function month(
  monthKey: string,
  rateMultiplier = 1,
  overrides: Partial<EnergyBillingMonth> = {},
): EnergyBillingMonth {
  const [year, monthNumber] = monthKey.split('-').map(Number);
  return {
    monthKey,
    year,
    month: monthNumber,
    daysInMonth: 30,
    gridCoverageDays: 30,
    electricityCoverageDays: 30,
    gridCoverage: 'complete',
    electricityCoverage: 'complete',
    consumptionSource: 'grid',
    exportSource: 'electricity',
    consumptionKwh: 300,
    exportedKwh: 200,
    gridConsumptionKwh: 300,
    electricityConsumptionKwh: 300,
    gridCostSek: 0,
    electricityCostSek: 0,
    totalCostSek: 0,
    peakDemandKw: 5,
    electricityEnergySek: 240 * rateMultiplier,
    electricityFeesSek: (20 * rateMultiplier) + 40,
    electricityFixedSek: 40,
    electricityVatSek: 0,
    gridFixedSek: 300,
    gridTransferSek: 90 * rateMultiplier,
    gridPeakSek: 150,
    gridVatSek: 0,
    energyTaxSek: 130 * rateMultiplier,
    exportNetSek: -5_000,
    ...overrides,
  };
}

Deno.test('price inflation separates grid and electricity unit prices', () => {
  const inflation = buildEnergyPriceInflation([
    month('2026-01'),
    month('2026-02', 1.25),
  ]);

  assertEqual(inflation.points[0].gridIndex, 100, 'grid baseline');
  assertEqual(inflation.points[1].gridIndex, 125, 'grid index');
  assertEqual(inflation.points[1].electricityIndex, 125, 'electricity index');
  assertEqual(inflation.grid.changeRatio, 0.25, 'grid change');
  assertEqual(inflation.electricity.changeRatio, 0.25, 'electricity change');
});

Deno.test('consumption, fixed charges, peak charges, and export do not alter the index', () => {
  const inflation = buildEnergyPriceInflation([
    month('2026-01'),
    month('2026-02', 2, {
      gridConsumptionKwh: 600,
      electricityConsumptionKwh: 600,
      consumptionKwh: 600,
      gridTransferSek: 180,
      energyTaxSek: 260,
      electricityEnergySek: 480,
      electricityFeesSek: 80,
      electricityFixedSek: 40,
      gridFixedSek: 9_000,
      gridPeakSek: 12_000,
      exportNetSek: 100_000,
    }),
  ]);

  assertEqual(inflation.points[1].gridIndex, 100, 'grid index');
  assertEqual(inflation.points[1].electricityIndex, 100, 'electricity index');
});

Deno.test('partial source months are excluded instead of being presented as inflation', () => {
  const inflation = buildEnergyPriceInflation([
    month('2026-01'),
    month('2026-02', 50, {
      gridCoverage: 'partial',
      gridCoverageDays: 14,
    }),
  ]);

  assertEqual(inflation.points[1].gridIndex, null, 'partial grid month');
  assertEqual(inflation.points[1].electricityIndex, 5000, 'complete electricity month');
  assertEqual(inflation.grid.latestMonth, '2026-01', 'latest complete grid month');
});
