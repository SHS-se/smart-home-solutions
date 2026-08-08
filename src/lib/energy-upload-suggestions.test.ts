/// <reference lib="deno.ns" />

import type { EnergyBillingMonth } from './energy-billing-series.ts';
import {
  suggestedEnergyUploads,
  estimatedMonthKeys,
} from './energy-upload-suggestions.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function month(
  monthKey: string,
  overrides: Partial<EnergyBillingMonth> = {},
): EnergyBillingMonth {
  const daysInMonth = new Date(
    Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 0),
  ).getUTCDate();
  return {
    monthKey,
    daysInMonth,
    gridCoverageDays: daysInMonth,
    electricityCoverageDays: daysInMonth,
    gridCoverage: 'complete',
    electricityCoverage: 'complete',
    gridCostSek: 1000,
    electricityCostSek: 500,
    totalCostSek: 1500,
    consumptionKwh: 1000,
    consumptionSource: 'grid',
    exportedKwh: null,
    exportSource: null,
    peakDemandKw: null,
    ...overrides,
  } as EnergyBillingMonth;
}

const TODAY = new Date('2026-08-08T00:00:00Z');

Deno.test('the month in progress is never suggested', () => {
  const suggestions = suggestedEnergyUploads(
    [month('2026-08', {
      gridCoverageDays: 7,
      gridCoverage: 'partial',
      electricityCoverageDays: 2,
      electricityCoverage: 'partial',
    })],
    null,
    TODAY,
  );

  assertEqual(suggestions.length, 0, 'partial by definition, so nothing to prompt');
});

Deno.test('a closed month missing a kind is suggested for that kind only', () => {
  const suggestions = suggestedEnergyUploads(
    [month('2026-07', {
      electricityCoverageDays: 0,
      electricityCoverage: 'missing',
      electricityCostSek: null,
    })],
    null,
    TODAY,
  );

  assertEqual(suggestions.length, 1, 'one suggestion');
  assertEqual(suggestions[0].kind, 'electricity', 'the missing kind');
  assertEqual(suggestions[0].missingDays, 31, 'whole month');
});

Deno.test('suggestions rank by how much money the upload would explain', () => {
  const suggestions = suggestedEnergyUploads(
    [
      // A whole winter month of grid missing: 3000 kr unexplained.
      month('2026-01', {
        gridCoverageDays: 0,
        gridCoverage: 'missing',
        gridCostSek: null,
        electricityCostSek: 3000,
      }),
      // One day of a summer month missing.
      month('2026-06', {
        gridCoverageDays: 29,
        gridCoverage: 'partial',
        gridCostSek: 300,
      }),
    ],
    null,
    TODAY,
  );

  assertEqual(suggestions[0].monthKey, '2026-01', 'the expensive gap first');
  assertEqual(suggestions.length, 2, 'both still offered');
});

Deno.test('a fully covered history suggests nothing at all', () => {
  const suggestions = suggestedEnergyUploads(
    [month('2026-06'), month('2026-07')],
    null,
    TODAY,
  );

  assertEqual(suggestions.length, 0, 'silence is the default');
});

Deno.test('months carried by an estimate are reported for the chart', () => {
  const keys = estimatedMonthKeys(
    [
      month('2026-06'),
      month('2026-07', { electricityCoverageDays: 0, electricityCoverage: 'missing' }),
    ],
    null,
  );

  assertEqual(keys.has('2026-07'), true, 'the thin month is marked');
  assertEqual(keys.has('2026-06'), false, 'the complete one is not');
});
