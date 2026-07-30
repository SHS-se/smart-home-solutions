/// <reference lib="deno.ns" />

import { resolveEnergyPerformance } from './energy-performance.ts';
import type { DailyCategoryReading, DailyTemperature } from './energiprestanda.ts';
import type { DailyEnergyReading } from './energy-usage-series.ts';

const ATEMP_M2 = 200;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function isoDate(dayOffset: number): string {
  return new Date(Date.UTC(2025, 0, 1 + dayOffset)).toISOString().slice(0, 10);
}

/** A full year of daily grid-import readings, the only data most homes have. */
function gridOnlyReadings(kwhPerDay: number, days = 365): DailyEnergyReading[] {
  return Array.from({ length: days }, (_, day) => ({
    readingDate: isoDate(day),
    consumptionKwh: kwhPerDay,
    readingKind: 'grid_import' as const,
  }));
}

function categoryReadings(days: number): DailyCategoryReading[] {
  const readings: DailyCategoryReading[] = [];
  for (let day = 0; day < days; day += 1) {
    const reading_date = isoDate(day);
    readings.push({ reading_date, category: 'heating', kwh: 12 });
    readings.push({ reading_date, category: 'hot_water', kwh: 6 });
    readings.push({ reading_date, category: 'property_energy', kwh: 2 });
    readings.push({ reading_date, category: 'household', kwh: 9 });
  }
  return readings;
}

function weatherYear(): DailyTemperature[] {
  return Array.from({ length: 365 }, (_, day) => ({
    observed_on: isoDate(day),
    temperature_c: 6,
  }));
}

Deno.test('grades a home that only has grid-import data from the grid operator', () => {
  const resolved = resolveEnergyPerformance(
    [],
    gridOnlyReadings(30),
    ATEMP_M2,
    [],
    false,
  );

  assertEqual(resolved.method, 'estimated_from_grid', 'method');
  assertEqual(resolved.confidence, 'low', 'confidence');
  assertEqual(resolved.blocker, null, 'blocker');
  assertEqual(resolved.grade !== null, true, 'grade is produced');
  assertEqual(resolved.newBuildRequirementKwhM2, 90, 'BBR 31 requirement');
  assertEqual(resolved.hasCategoryReadings, false, 'no category readings');
  if (resolved.primaryEnergyKwhM2 === null || resolved.primaryEnergyKwhM2 <= 0) {
    throw new Error('estimated primary energy should be positive');
  }
});

Deno.test('prefers measured category data over the grid estimate', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(365),
    gridOnlyReadings(30),
    ATEMP_M2,
    weatherYear(),
    false,
  );

  assertEqual(resolved.method, 'measured_categories', 'method');
  assertEqual(resolved.blocker, null, 'blocker');
  assertEqual(resolved.measured.reason, 'ok', 'measured reason');
  assertEqual(
    resolved.primaryEnergyKwhM2,
    resolved.measured.ep,
    'grade uses the measured primary energy number',
  );
});

Deno.test('reports medium confidence when category data covers only part of the year', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(60),
    [],
    ATEMP_M2,
    weatherYear(),
    false,
  );

  assertEqual(resolved.method, 'measured_categories', 'method');
  assertEqual(resolved.confidence, 'medium', 'confidence');
});

Deno.test('falls back to the estimate when category data is too thin', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(10),
    gridOnlyReadings(30),
    ATEMP_M2,
    weatherYear(),
    false,
  );

  assertEqual(resolved.method, 'estimated_from_grid', 'method');
  assertEqual(resolved.measured.reason, 'insufficient_coverage', 'measured reason');
  assertEqual(resolved.hasCategoryReadings, true, 'category readings exist');
});

Deno.test('explains the blocker instead of guessing a grade', () => {
  assertEqual(
    resolveEnergyPerformance([], [], null, [], false).blocker,
    'missing_heated_area',
    'missing area',
  );
  assertEqual(
    resolveEnergyPerformance([], [], 40, [], false).blocker,
    'area_not_supported',
    'area below the BBR 31 floor',
  );
  assertEqual(
    resolveEnergyPerformance([], [], ATEMP_M2, [], false).blocker,
    'no_data',
    'no readings at all',
  );
  assertEqual(
    resolveEnergyPerformance([], gridOnlyReadings(30, 120), ATEMP_M2, [], false).blocker,
    'insufficient_data',
    'too few grid days',
  );
  assertEqual(
    resolveEnergyPerformance([], gridOnlyReadings(30), ATEMP_M2, [], true).blocker,
    'solar_requires_total_consumption',
    'solar home without whole-home metering',
  );
});

Deno.test('lets measured category data grade a solar home the estimate refuses', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(365),
    gridOnlyReadings(30),
    ATEMP_M2,
    weatherYear(),
    true,
  );

  assertEqual(resolved.method, 'measured_categories', 'method');
  assertEqual(resolved.grade !== null, true, 'grade is produced');
});
