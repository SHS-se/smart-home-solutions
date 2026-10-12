import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { allocateReportedEnergy, measureReportedEnergy, reportedEnergyIntervals, type ReportedEnergyInterval } from './reported-energy-intervals.ts';
import { mergeHourlyHistory, type RecoveredHour } from './recovered-history.ts';
import { baselineFixture } from './fixture.ts';
import { prepareHomeBaseline } from './model.ts';
import { projectPlanChart } from '../energy-shift/plan-chart-data.ts';

const start = '2026-08-31T08:30:00Z', end = '2026-08-31T12:15:00Z', quarter = 900_000;
const interval: ReportedEnergyInterval = { field: 'solar_production_kwh', start, end, kwh: 9.21, source: 'sensor.pv_energy' };

Deno.test('delayed counter energy becomes an interval average without losing energy or healthy channels', () => {
  const rows = baselineFixture({ start, end }).actual.slice(1);
  rows.forEach(row => { row.solar_production_kwh = 0; });
  rows.at(-1)!.solar_production_kwh = 9.21;
  rows.at(-2)!.solar_production_kwh = null;
  const measured = measureReportedEnergy(rows, [{ field: interval.field, start, end, source: interval.source }]);
  assertAlmostEquals(measured[0].kwh, 9.21);
  const byTime = new Map(rows.map(row => [new Date(row.start_ts).toISOString(), { ...row }]));
  const adjusted = allocateReportedEnergy(byTime, measured, Date.parse(start), Date.parse(end));
  assertEquals(adjusted.size, 15);
  assertAlmostEquals([...byTime.values()].reduce((sum, row) => sum + row.solar_production_kwh!, 0), 9.21);
  for (const row of byTime.values()) {
    assertAlmostEquals(row.solar_production_kwh! * 4000, 2456);
    assertEquals(row.grid_import_kwh, .265);
    assertEquals(row.battery_soc, .5);
  }
  assertEquals(rows.at(-1)!.solar_production_kwh, 9.21, 'source facts remain intact');
});

Deno.test('partial views use the full reporting duration and repeated hourly metadata is deduplicated', () => {
  const rows = baselineFixture({ start: '2026-08-31T12:00:00Z', end }).actual.slice(1);
  const byTime = new Map(rows.map(row => [new Date(row.start_ts).toISOString(), row]));
  allocateReportedEnergy(byTime, [interval, interval], Date.parse('2026-08-31T12:00:00Z'), Date.parse(end));
  assertAlmostEquals([...byTime.values()][0].solar_production_kwh!, 9.21 / 15);
  assertEquals(reportedEnergyIntervals([interval, { ...interval, start: '2026-08-31T08:30:00.000+00:00' }]).length, 1);
});

Deno.test('invalid, conflicting, overlapping or unobserved correction intervals fail', () => {
  for (const value of [{ ...interval, kwh: -1 }, { ...interval, end: start }, { ...interval, start: 'invalid' },
    { ...interval, end: '2026-08-31T12:16:00Z' }, { ...interval, source: '' }]) assertThrows(() => reportedEnergyIntervals([value]));
  assertThrows(() => reportedEnergyIntervals([interval, { ...interval, kwh: 8 }]));
  assertThrows(() => reportedEnergyIntervals([interval, { ...interval, start: '2026-08-31T09:00:00Z' }]));
  assertThrows(() => measureReportedEnergy([], [{ field: interval.field, start, end, source: interval.source }]));
});

Deno.test('ROI merges explicit interval corrections into model and recorded chart with an estimate disclosure', () => {
  const rows = baselineFixture({ start, end });
  rows.actual.slice(1).forEach(row => { row.solar_production_kwh = 0; });
  rows.actual.at(-1)!.solar_production_kwh = 9.21;
  const hour: RecoveredHour = { start_ts: '2026-08-31T12:00:00Z', actual: { reported_intervals: [interval] },
    device_energy_kwh: {}, pool_c: null, outdoor_c: null, baseline_load_kwh: null, sources: {}, invalid_readings: 0 };
  const merged = mergeHourlyHistory(rows, [hour]);
  const input = prepareHomeBaseline(merged);
  assertAlmostEquals(input.problem.slots.at(-1)!.solar_w, 2456);
  assertAlmostEquals(input.recorded.rows.at(-1)!.solarW!, 2456);
  assertEquals(input.recorded.rows.every(row => row.estimatedEnergy), true);
  const chart = projectPlanChart({ rows: input.recorded.rows, devices: input.recorded.devices, range: { from: 0, to: 15 }, timeZone: input.timeZone, prices: { kind: 'actual' } });
  assertEquals(chart.rows.every(row => row.estimatedEnergy), true);
  assertEquals(merged.intervalFields?.length, (Date.parse(end) - Date.parse(start)) / quarter);
  assertEquals(rows.actual.at(-1)!.solar_production_kwh, 9.21);
});
