/// <reference lib="deno.ns" />

// Rewritten 2026-08-13. The previous suite encoded the behaviour that turned
// out to be the defect: it asserted that measured category data always beat the
// grid estimate, and that partial-year coverage was merely "medium confidence".
// A 43-day summer window then produced a class A rating for a house that is
// nowhere near class A. See ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.
//
// The rule under test now: evidence must cover enough of a normal heating
// season before it may speak for the year.

import {
  resolveEnergyPerformance,
  type EnergyPerformanceMethod,
} from './energy-performance.ts';
import type { DailyCategoryReading, DailyTemperature } from './energiprestanda.ts';
import type { DailyEnergyReading } from './energy-usage-series.ts';

const ATEMP_M2 = 200;

const HOME = {
  yearBuilt: 1975,
  dwelling: 'detached' as const,
  heating: 'resistive' as const,
};

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
}

function isoDate(dayOffset: number): string {
  return new Date(Date.UTC(2025, 0, 1 + dayOffset)).toISOString().slice(0, 10);
}

function gridOnlyReadings(kwhPerDay: number, days = 365): DailyEnergyReading[] {
  return Array.from({ length: days }, (_, day) => ({
    readingDate: isoDate(day),
    consumptionKwh: kwhPerDay,
    readingKind: 'grid_import' as const,
  }));
}

/** Category readings for a contiguous run of days starting at `from`. */
function categoryReadings(days: number, from = 0): DailyCategoryReading[] {
  const readings: DailyCategoryReading[] = [];
  for (let day = from; day < from + days; day += 1) {
    const reading_date = isoDate(day);
    readings.push({ reading_date, category: 'heating', kwh: 12 });
    readings.push({ reading_date, category: 'hot_water', kwh: 6 });
    readings.push({ reading_date, category: 'property_energy', kwh: 2 });
    readings.push({ reading_date, category: 'household', kwh: 9 });
  }
  return readings;
}

/**
 * A seasonal weather year: cold in winter, above the 17 °C heating base in
 * high summer. A flat year would make every window look equally informative,
 * which is exactly the assumption being removed.
 */
function weatherYear(years = 1): DailyTemperature[] {
  const temps: DailyTemperature[] = [];
  for (let year = 0; year < years; year += 1) {
    for (let day = 0; day < 365; day += 1) {
      const offset = year * 365 + day;
      const seasonal = 8 - 12 * Math.cos((2 * Math.PI * day) / 365);
      temps.push({ observed_on: isoDate(offset), temperature_c: seasonal });
    }
  }
  return temps;
}

Deno.test('a summer-only window cannot produce a measured class', () => {
  // The reference defect: 43 days ending in high summer.
  const summerWindow = categoryReadings(43, 190);
  const resolved = resolveEnergyPerformance(
    summerWindow,
    [],
    ATEMP_M2,
    weatherYear(),
    false,
    HOME,
  );

  assert(
    resolved.method !== 'measured_categories',
    `summer window must not be graded as measured, got ${resolved.method}`,
  );
  assertEqual(resolved.measured.reason, 'insufficient_heating_season', 'reason');
  assertEqual(resolved.measured.ep, null, 'no measured EP from a summer window');
});

Deno.test('a summer-only window falls back to the modelled archetype', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(43, 190),
    [],
    ATEMP_M2,
    weatherYear(),
    false,
    HOME,
  );

  assertEqual(resolved.method, 'modelled_archetype' as EnergyPerformanceMethod, 'method');
  assertEqual(resolved.isModelled, true, 'must be badged as modelled');
  assertEqual(resolved.measuredWeight, 0, 'no measured weight');
  assertEqual(resolved.confidence, 'low', 'confidence');
  assert(resolved.grade !== null, 'a modelled grade is still offered');
});

Deno.test('a full year of category data is graded as measured and high confidence', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(365),
    gridOnlyReadings(30),
    ATEMP_M2,
    weatherYear(),
    false,
    HOME,
  );

  assertEqual(resolved.method, 'measured_categories' as EnergyPerformanceMethod, 'method');
  assertEqual(resolved.confidence, 'high', 'confidence');
  assertEqual(resolved.measuredWeight, 1, 'fully measured');
  assertEqual(resolved.isModelled, false, 'not modelled');
  assertEqual(resolved.measured.reason, 'ok', 'reason');
});

Deno.test('a year of grid history outranks the prior when categories are unusable', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(43, 190),
    gridOnlyReadings(30),
    ATEMP_M2,
    weatherYear(),
    false,
    HOME,
  );

  assertEqual(resolved.method, 'estimated_from_grid' as EnergyPerformanceMethod, 'method');
  // Grid import alone is not whole-home consumption at a solar home, so
  // `actualTotalConsumptionDays` stays 0 and the estimate remains low confidence.
  assertEqual(resolved.confidence, 'low', 'confidence');
  assertEqual(resolved.isModelled, true, 'the grid estimate is not a measurement of the building');
});

Deno.test('a prospective home with no data at all still gets a modelled grade', () => {
  const resolved = resolveEnergyPerformance([], [], ATEMP_M2, [], null, HOME);

  assertEqual(resolved.method, 'modelled_archetype' as EnergyPerformanceMethod, 'method');
  assertEqual(resolved.blocker, null, 'no blocker: a prior is always available');
  assert(resolved.grade !== null, 'grade');
  assert(
    (resolved.priorPrimaryEnergyKwhM2 ?? 0) > 0,
    'prior primary energy is positive',
  );
});

Deno.test('no grade without a heated area, however much data exists', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(365),
    gridOnlyReadings(30),
    null,
    weatherYear(),
    false,
    HOME,
  );

  assertEqual(resolved.grade, null, 'grade');
  assertEqual(resolved.method, null, 'method');
  assertEqual(resolved.blocker, 'missing_heated_area', 'blocker');
});

Deno.test('degree-day normalization needs a complete year of weather', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(365),
    [],
    ATEMP_M2,
    weatherYear().slice(0, 100),
    false,
    HOME,
  );

  assertEqual(resolved.measured.reason, 'no_normal_year_weather', 'reason');
  assert(
    resolved.method !== 'measured_categories',
    'cannot claim a measured class without a normal year',
  );
});

Deno.test('a colder municipality does not score worse for the same energy', () => {
  const warm = resolveEnergyPerformance(
    categoryReadings(365),
    [],
    ATEMP_M2,
    weatherYear(),
    false,
    { ...HOME, geographicAdjustmentFactor: 1.0 },
  );
  const cold = resolveEnergyPerformance(
    categoryReadings(365),
    [],
    ATEMP_M2,
    weatherYear(),
    false,
    { ...HOME, geographicAdjustmentFactor: 1.6 },
  );

  assert(
    (cold.primaryEnergyKwhM2 ?? 0) < (warm.primaryEnergyKwhM2 ?? 0),
    'F_geo must divide the heating term, not multiply it',
  );
  assertEqual(cold.geographicFactorAssumed, false, 'a supplied F_geo is not an assumption');
  assertEqual(warm.geographicFactorAssumed, false, 'a supplied F_geo is not an assumption');
});

Deno.test('an unknown F_geo is recorded as an assumption', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(365),
    [],
    ATEMP_M2,
    weatherYear(),
    false,
    HOME,
  );
  assertEqual(resolved.geographicFactorAssumed, true, 'assumption is surfaced');
});

Deno.test('the archetype prior is always computed alongside, for comparison', () => {
  const resolved = resolveEnergyPerformance(
    categoryReadings(365),
    [],
    ATEMP_M2,
    weatherYear(),
    false,
    HOME,
  );
  assert(resolved.prior !== null, 'prior is present even on the measured path');
  assert(
    (resolved.prior?.basis.length ?? 0) > 0,
    'prior explains what it rests on',
  );
});
