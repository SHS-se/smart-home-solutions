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

Deno.test('a recorded renovation never makes the modelled rating worse', () => {
  // This invariant was violated by the first implementation, which shifted the
  // effective build year toward the renovation year. The published band table
  // is not monotonic — 1981-1990 uses more per m² than 1961-1970 — so a 1970
  // house renovated in 1990 came out WORSE for having been improved. Renovation
  // is now a reduction in heat demand, which cannot invert.
  const summerOnly = categoryReadings(43, 190);
  const base = resolveEnergyPerformance(
    summerOnly, [], ATEMP_M2, weatherYear(), false, { ...HOME, yearBuilt: 1970 }, [],
  );
  const renovated = resolveEnergyPerformance(
    summerOnly, [], ATEMP_M2, weatherYear(), false, { ...HOME, yearBuilt: 1970 },
    [{ note_date: '1990-06-01', event_type: 'renovation', event_text: 'attic + windows' }],
  );

  assert(
    (renovated.primaryEnergyKwhM2 ?? 0) < (base.primaryEnergyKwhM2 ?? 0),
    `renovation must lower the modelled figure: ${base.primaryEnergyKwhM2} -> ${renovated.primaryEnergyKwhM2}`,
  );
  assert(renovated.renovationHeatingFactor < 1, 'the factor is applied');
  assertEqual(renovated.renovationYear, 1990, 'renovation year reported');
});

Deno.test('flagged days are removed from the measured evidence', () => {
  const readings = categoryReadings(365);
  const clean = resolveEnergyPerformance(readings, [], ATEMP_M2, weatherYear(), false, HOME, []);
  const withHoliday = resolveEnergyPerformance(
    readings, [], ATEMP_M2, weatherYear(), false, HOME,
    [{ note_date: isoDate(10), end_date: isoDate(23), event_type: 'absence', event_text: 'away' }],
  );

  assertEqual(withHoliday.measured.excludedDayCount, 14, 'fourteen days excluded');
  assertEqual(
    clean.measured.coverageDays - withHoliday.measured.coverageDays,
    14,
    'and they really left the evidence',
  );
  assert(
    withHoliday.eventWarnings.some(w => w.kind === 'period_days_excluded'),
    'the exclusion is surfaced, not silent',
  );
});

Deno.test('excluding a holiday does not distort the degree-day ratio', () => {
  // Dropping a fortnight's energy while keeping its cold days would make the
  // house look worse for having gone away. Both must leave together.
  //
  // This needs a *physical* fixture: heating proportional to degree days, which
  // is the assumption the whole normalization rests on. The flat 12 kWh/day
  // fixture used elsewhere deliberately violates it, and under that fixture the
  // estimator legitimately gives different answers depending on which season
  // you remove — an artefact of the fixture, not of the code.
  const readings: DailyCategoryReading[] = [];
  for (let day = 0; day < 365; day += 1) {
    const reading_date = isoDate(day);
    const outdoor = 8 - 12 * Math.cos((2 * Math.PI * day) / 365);
    readings.push({ reading_date, category: 'heating', kwh: Math.max(0, 17 - outdoor) * 1.5 });
    readings.push({ reading_date, category: 'hot_water', kwh: 6 });
    readings.push({ reading_date, category: 'property_energy', kwh: 2 });
  }
  const winterHoliday = resolveEnergyPerformance(
    readings, [], ATEMP_M2, weatherYear(), false, HOME,
    [{ note_date: isoDate(5), end_date: isoDate(18), event_type: 'absence', event_text: 'away' }],
  );
  const summerHoliday = resolveEnergyPerformance(
    readings, [], ATEMP_M2, weatherYear(), false, HOME,
    [{ note_date: isoDate(190), end_date: isoDate(203), event_type: 'absence', event_text: 'away' }],
  );

  // Identical synthetic daily readings, so removing any fourteen days should
  // land in the same place regardless of which season they came from.
  const gap = Math.abs(
    (winterHoliday.primaryEnergyKwhM2 ?? 0) - (summerHoliday.primaryEnergyKwhM2 ?? 0),
  );
  assert(gap < 1, `season of the excluded days should not swing the result: gap ${gap}`);
});
