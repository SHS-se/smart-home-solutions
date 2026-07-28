/// <reference lib="deno.ns" />

import {
  buildEnergyTemperatureAnalysis,
  predictTemperatureRegression,
} from './energy-temperature-analysis.ts';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertClose(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

Deno.test('matches daily usage and weather by date and groups by rounded temperature', () => {
  const result = buildEnergyTemperatureAnalysis(
    [
      { readingDate: '2025-01-01', consumptionKwh: 100 },
      { readingDate: '2025-01-02', consumptionKwh: 80 },
      { readingDate: '2025-01-03', consumptionKwh: 60 },
    ],
    [
      { observedOn: '2025-01-01', temperatureC: -2.4 },
      { observedOn: '2025-01-02', temperatureC: -2.6 },
    ],
  );

  assertEqual(result.joinedPoints.length, 2, 'joined point count');
  assertEqual(result.years.length, 1, 'year count');
  assertEqual(result.years[0].points.length, 2, 'temperature bin count');
  assertEqual(result.years[0].points[0].temperatureC, -3, 'rounded negative bin');
  assertEqual(result.years[0].points[1].averageKwh, 100, 'bin average');
});

Deno.test('rounds negative half-degree temperatures away from zero like spreadsheets', () => {
  const result = buildEnergyTemperatureAnalysis(
    [
      { readingDate: '2025-01-01', consumptionKwh: 100 },
      { readingDate: '2025-01-02', consumptionKwh: 80 },
    ],
    [
      { observedOn: '2025-01-01', temperatureC: -2.5 },
      { observedOn: '2025-01-02', temperatureC: 2.5 },
    ],
  );

  assertEqual(result.overall.points[0].temperatureC, -3, 'negative half-degree bin');
  assertEqual(result.overall.points[1].temperatureC, 3, 'positive half-degree bin');
});

Deno.test('fits the quadratic trend curve used by the reference graphs', () => {
  const result = buildEnergyTemperatureAnalysis(
    [
      { readingDate: '2025-01-01', consumptionKwh: 3 },
      { readingDate: '2025-01-02', consumptionKwh: 2 },
      { readingDate: '2025-01-03', consumptionKwh: 3 },
      { readingDate: '2025-01-04', consumptionKwh: 6 },
      { readingDate: '2025-01-05', consumptionKwh: 11 },
    ],
    [
      { observedOn: '2025-01-01', temperatureC: -2 },
      { observedOn: '2025-01-02', temperatureC: -1 },
      { observedOn: '2025-01-03', temperatureC: 0 },
      { observedOn: '2025-01-04', temperatureC: 1 },
      { observedOn: '2025-01-05', temperatureC: 2 },
    ],
  );

  assert(result.overall.regression !== null, 'regression exists');
  assertClose(result.overall.regression.rSquared, 1, 'perfect regression score');
  assertClose(
    predictTemperatureRegression(3, result.overall.regression),
    18,
    'quadratic prediction',
  );
});
