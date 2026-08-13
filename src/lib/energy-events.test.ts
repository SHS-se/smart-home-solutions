/// <reference lib="deno.ns" />

import {
  eventCoverage,
  latestRenovationYear,
  renovationHeatingFactor,
  periodDates,
  stepAffects,
  stepChangesWithin,
  treatmentOf,
  type EnergyEvent,
} from './energy-events.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
}

const event = (
  note_date: string,
  event_type: string,
  end_date: string | null = null,
): EnergyEvent => ({ note_date, event_type, end_date, event_text: `${event_type} ${note_date}` });

Deno.test('event types map onto the two treatments', () => {
  assertEqual(treatmentOf('renovation'), 'step', 'renovation');
  assertEqual(treatmentOf('occupancy_decrease'), 'step', 'someone moved out');
  assertEqual(treatmentOf('absence'), 'period', 'holiday');
  assertEqual(treatmentOf('equipment_fault'), 'period', 'broken heat pump');
  assertEqual(treatmentOf('other'), 'none', 'free text');
  assertEqual(treatmentOf(null), 'none', 'legacy note with no type');
});

Deno.test('a legacy untyped note affects no calculation', () => {
  // Every note that existed before typing defaults to 'other'. None of them
  // should suddenly start removing days or invalidating windows.
  const legacy: EnergyEvent[] = [{ note_date: '2026-03-01', event_text: 'replaced a lamp' }];
  assertEqual(periodDates(legacy).size, 0, 'no excluded days');
  assertEqual(stepChangesWithin(legacy, '2020-01-01', '2027-01-01').length, 0, 'no steps');
});

Deno.test('a period covers both of its end days', () => {
  // 1-14 July is a fortnight, not thirteen days.
  const dates = periodDates([event('2026-07-01', 'absence', '2026-07-14')]);
  assertEqual(dates.size, 14, 'day count');
  assert(dates.has('2026-07-01'), 'includes the first day');
  assert(dates.has('2026-07-14'), 'includes the last day');
  assert(!dates.has('2026-07-15'), 'stops after the last day');
});

Deno.test('a period with no end date covers exactly one day', () => {
  const dates = periodDates([event('2026-07-01', 'absence')]);
  assertEqual(dates.size, 1, 'single day');
});

Deno.test('overlapping periods do not double-count days', () => {
  const dates = periodDates([
    event('2026-07-01', 'absence', '2026-07-10'),
    event('2026-07-05', 'guests', '2026-07-12'),
  ]);
  assertEqual(dates.size, 12, 'union of both periods');
});

Deno.test('a mistyped end date cannot delete years of measurement', () => {
  // A holiday ending in 2035 is a typo, not a decade away from home.
  const dates = periodDates([event('2026-07-01', 'absence', '2035-07-01')]);
  assert(dates.size <= 401, `runaway period was not capped: ${dates.size}`);
});

Deno.test('an end date before the start is ignored', () => {
  assertEqual(periodDates([event('2026-07-14', 'absence', '2026-07-01')]).size, 0, 'ignored');
});

Deno.test('step changes inside a window are listed newest first', () => {
  const steps = stepChangesWithin([
    event('2024-05-01', 'renovation'),
    event('2026-02-01', 'heating_system_change'),
    event('2019-01-01', 'renovation'),
    event('2026-07-01', 'absence', '2026-07-14'),
  ], '2023-01-01', '2026-12-31');

  assertEqual(steps.length, 2, 'two steps in the window');
  assertEqual(steps[0].date, '2026-02-01', 'newest first');
  assertEqual(steps[1].date, '2024-05-01', 'then older');
});

Deno.test('what a step changed is reported, not just that it happened', () => {
  assertEqual(stepAffects('renovation').envelope, true, 'renovation touches the envelope');
  assertEqual(stepAffects('renovation').heatingSystem, false, 'but not the heating system');
  assertEqual(stepAffects('solar_installed').generation, true, 'solar is generation');
  assertEqual(stepAffects('occupancy_increase').occupancy, true, 'a person is occupancy');
});

Deno.test('a renovation reduces modelled heat demand', () => {
  assertEqual(renovationHeatingFactor([]), 1, 'no renovation, no change');
  assert(renovationHeatingFactor([event('2010-06-01', 'renovation')]) < 1, 'reduces demand');
});

Deno.test('recording ten renovations does not make a house ten times better', () => {
  const once = renovationHeatingFactor([event('2010-06-01', 'renovation')]);
  const many = renovationHeatingFactor([
    event('2010-06-01', 'renovation'),
    event('2012-06-01', 'renovation'),
    event('2014-06-01', 'renovation'),
  ]);
  assertEqual(many, once, 'applied once, not compounded');
});

Deno.test('a heating system change does not also take the renovation discount', () => {
  // The published per-system factors already carry that improvement; applying
  // both would count it twice.
  assertEqual(renovationHeatingFactor([event('2015-01-01', 'heating_system_change')]), 1, 'no discount');
});

Deno.test('events other than renovations leave heat demand alone', () => {
  assertEqual(renovationHeatingFactor([
    event('2020-01-01', 'absence', '2020-01-14'),
    event('2021-01-01', 'occupancy_increase'),
    event('2022-01-01', 'solar_installed'),
  ]), 1, 'unchanged');
});

Deno.test('the most recent renovation year is reported', () => {
  assertEqual(latestRenovationYear([
    event('1995-01-01', 'renovation'),
    event('2015-01-01', 'renovation'),
    event('2005-01-01', 'renovation'),
  ]), 2015, 'latest');
  assertEqual(latestRenovationYear([]), null, 'none');
});

Deno.test('coverage reports both problems a window can have', () => {
  const warnings = eventCoverage([
    event('2026-02-01', 'renovation'),
    event('2026-07-01', 'absence', '2026-07-14'),
  ], '2026-01-01', '2026-12-31');

  const kinds = warnings.map(w => w.kind).sort();
  assertEqual(kinds.join(','), 'period_days_excluded,step_inside_window', 'both kinds');
  assertEqual(warnings.find(w => w.kind === 'period_days_excluded')?.days, 14, 'excluded days');
});

Deno.test('a period outside the window is not counted against it', () => {
  const warnings = eventCoverage(
    [event('2025-07-01', 'absence', '2025-07-14')],
    '2026-01-01',
    '2026-12-31',
  );
  assertEqual(warnings.length, 0, 'nothing to warn about');
});

Deno.test('a clean window produces no warnings', () => {
  assertEqual(eventCoverage([], '2026-01-01', '2026-12-31').length, 0, 'no warnings');
});
