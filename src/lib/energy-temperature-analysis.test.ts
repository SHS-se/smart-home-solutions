/// <reference lib="deno.ns" />

import { buildEnergyTemperatureAnalysis } from './energy-temperature-analysis.ts';

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
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

Deno.test('calculates a bounded regression score for the overall series', () => {
  const result = buildEnergyTemperatureAnalysis(
    [
      { readingDate: '2025-01-01', consumptionKwh: 100 },
      { readingDate: '2025-01-02', consumptionKwh: 80 },
      { readingDate: '2025-01-03', consumptionKwh: 60 },
    ],
    [
      { observedOn: '2025-01-01', temperatureC: -3 },
      { observedOn: '2025-01-02', temperatureC: 0 },
      { observedOn: '2025-01-03', temperatureC: 3 },
    ],
  );

  assert(result.overall.regression !== null, 'regression exists');
  assertEqual(result.overall.regression?.rSquared, 1, 'perfect regression score');
});
