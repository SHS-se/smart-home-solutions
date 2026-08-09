/// <reference lib="deno.ns" />

import {
  buildEnergyTemperatureAnalysis,
  buildSeasonalEventImpacts,
  buildWeatherNormalizedHistory,
  predictTemperatureRegression,
  type EnergyTemperatureAnalysis,
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

Deno.test('normalizes daily consumption to a fixed reference temperature', () => {
  const regression = {
    temperatureCenterC: 0,
    quadraticCoefficient: 0,
    linearCoefficient: -2,
    interceptKwh: 100,
    startTemperatureC: -20,
    endTemperatureC: 25,
    rSquared: 1,
  };
  const analysis: EnergyTemperatureAnalysis = {
    joinedPoints: [
      {
        readingDate: '2025-01-01',
        year: 2025,
        temperatureC: -10,
        temperatureBinC: -10,
        consumptionKwh: 130,
      },
      {
        readingDate: '2025-01-02',
        year: 2025,
        temperatureC: 10,
        temperatureBinC: 10,
        consumptionKwh: 90,
      },
    ],
    years: [],
    overall: {
      points: [],
      regression,
    },
  };

  const normalized = buildWeatherNormalizedHistory(analysis);
  assert(normalized !== null, 'normalized history exists');
  assertClose(normalized.referenceUsageKwh, 100, 'reference usage at zero degrees');
  assertClose(normalized.dailyPoints[0].normalizedKwh, 110, 'cold day normalized usage');
  assertClose(normalized.dailyPoints[1].normalizedKwh, 110, 'warm day normalized usage');
  assertClose(normalized.months[0].averageNormalizedKwh, 110, 'monthly normalized average');
});

Deno.test('compares post-event usage with the same dates one year earlier', () => {
  const dailyPoints = [2024, 2025].flatMap((year) => Array.from({ length: 40 }, (_, index) => {
    const date = new Date(Date.UTC(year, 0, index + 2));
    const readingDate = date.toISOString().slice(0, 10);
    const consumption = year === 2024 ? 100 : 80;
    return {
      readingDate,
      monthKey: readingDate.slice(0, 7),
      actualKwh: consumption * 10,
      normalizedKwh: consumption,
    };
  }));
  const impacts = buildSeasonalEventImpacts(
    {
      referenceTemperatureC: 0,
      referenceUsageKwh: 100,
      dailyPoints,
      months: [],
    },
    [{
      id: 'windows',
      eventDate: '2025-01-01',
      eventText: 'Installed new windows',
    }],
    [
      { monthKey: '2024-01', consumptionKwh: 100, totalCostSek: 100 },
      { monthKey: '2024-02', consumptionKwh: 100, totalCostSek: 100 },
      { monthKey: '2025-01', consumptionKwh: 100, totalCostSek: 200 },
      { monthKey: '2025-02', consumptionKwh: 100, totalCostSek: 200 },
    ],
    3,
    30,
  );

  assertEqual(impacts.length, 1, 'event impact count');
  assertClose(impacts[0].referenceAverageKwh, 100, 'previous-year average');
  assertClose(impacts[0].comparisonAverageKwh, 80, 'post-event average');
  assertClose(impacts[0].changePercent, -20, 'weather-normalized percent change');
  assertClose(impacts[0].referenceCostSek!, 4000, 'previous-year comparable cost');
  assertClose(impacts[0].comparisonCostSek!, 6400, 'post-event comparable cost');
  assertClose(impacts[0].costChangeSek!, 2400, 'price-aware cost change');
  assertClose(impacts[0].costChangePercent!, 60, 'price-aware cost percent');
  assertEqual(impacts[0].matchedDayCount, 40, 'paired days');
  assertEqual(impacts[0].completeWindow, false, 'in-progress window');
});

Deno.test('does not reuse 28 February as the reference for leap day', () => {
  const impacts = buildSeasonalEventImpacts(
    {
      referenceTemperatureC: 0,
      referenceUsageKwh: 100,
      dailyPoints: [
        { readingDate: '2023-02-28', monthKey: '2023-02', actualKwh: 100, normalizedKwh: 100 },
        { readingDate: '2024-02-28', monthKey: '2024-02', actualKwh: 80, normalizedKwh: 80 },
        { readingDate: '2024-02-29', monthKey: '2024-02', actualKwh: 70, normalizedKwh: 70 },
      ],
      months: [],
    },
    [{ id: 'leap', eventDate: '2024-02-27', eventText: 'Leap-year event' }],
    [],
    3,
    1,
  );

  assertEqual(impacts[0].matchedDayCount, 1, 'leap-day pairs');
  assertClose(impacts[0].comparisonAverageKwh, 80, 'leap day is excluded');
});
