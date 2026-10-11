import { assertAlmostEquals, assertEquals } from '@std/assert';
import { baselineFixture } from './fixture.ts';
import { energyDeltas, mergeHourlyHistory, prepareHourlyRecovery, type RecoverySpec } from './recovered-history.ts';
import { prepareHomeBaseline } from './model.ts';

const start = '2026-04-30T22:00:00.000Z', hour = 3_600_000, at = Date.parse(start);
const spec: RecoverySpec = { start, end: new Date(at + hour).toISOString(), actual: { grid_import_kwh: ['grid'], total_load_kwh: ['load'] },
  devices: [{ id: 'car-id', sources: ['old-car'] }, { id: 'heater-id', sources: ['heater'] }, { id: 'pump-id', sources: ['pump'] }, { id: 'other-id', sources: ['other'] }],
  members: ['car-id', 'heater-id', 'pump-id'], states: { ev_soc: 'soc', pool_c: 'temperature' } };
const series = (statistic_id: string, unit: string, sums: number[]) => ({ statistic_id, unit, statistics: sums.map((sum, i) => ({ start: at + (i - 2) * hour, sum })) });
const capture = () => [series('grid', 'kWh', [8, 10, 14]), series('load', 'MWh', [0, .001, .003]), series('old-car', 'kWh', [0, 0, 1]),
  series('heater', 'kWh', [0, 0, .2]), series('pump', 'kWh', [0, 0, .1]), series('other', 'kWh', [0, 0, .4]),
  { statistic_id: 'soc', unit: '%', statistics: [{ start: at - hour, mean: 80 }, { start: at, mean: 70 }] },
  { statistic_id: 'temperature', unit: '°C', statistics: [{ start: at - hour, mean: 29 }] }];

Deno.test('hourly reset-adjusted sums convert units, preserve resets and isolate invalid readings', () => {
  const source = series('solar', 'MWh', [5, 5.001, 5.002]);
  const values = energyDeltas(source);
  assertAlmostEquals(values.energy.get(at)!, 1);
  // Raw counter resets are irrelevant; HA sum already carries them.
  assertEquals(values.energy.has(at - 2 * hour), false);
  const bad = energyDeltas(series('bad', 'kWh', [5, 4, 6]));
  assertEquals(bad.invalid.has(at - hour), true); assertEquals(bad.energy.has(at - hour), false);
  assertEquals(bad.energy.get(at), 2);
  source.statistics.splice(1, 1);
  assertEquals(energyDeltas(source).energy.size, 0); // No invented allocation across an unobserved hour.
});

Deno.test('hourly energy and legacy device readings conserve totals under quarter price variation', () => {
  const hours = prepareHourlyRecovery(capture(), spec);
  const rows = baselineFixture({ start, end: new Date(at + hour).toISOString() });
  rows.actual = []; rows.deviceSlots = []; rows.pool = []; rows.evInitial = null;
  rows.prices.forEach((p, i) => { p.import_price_sek_per_kwh = i + 1; });
  const merged = mergeHourlyHistory(rows, hours), input = prepareHomeBaseline(merged);
  assertEquals(merged.actual.filter(r => r.start_ts >= start).length, 4);
  assertEquals(input.recorded.ledger.importKwh, 4);
  assertEquals(input.recorded.ledger.importCostSek, 10);
  assertAlmostEquals(input.evDemandKwh.reduce((n, kwh) => n + kwh, 0), .1 * input.problem.car!.capacity_kwh);
  assertEquals(input.evInitialAssumed, false); assertEquals(input.poolInitialAssumed, false);
  assertEquals(input.problem.initial.pool_c, 29);
  assertEquals(input.recovery.hours, 1);
});

Deno.test('measured zero and per-device readings take precedence, including initial states', () => {
  const rows = baselineFixture({ start, end: new Date(at + hour).toISOString() });
  rows.actual[1].grid_import_kwh = 0; rows.actual[2].grid_import_kwh = null;
  rows.deviceSlots[0].device_energy_kwh['car-id'] = 0;
  const merged = mergeHourlyHistory(rows, prepareHourlyRecovery(capture(), spec));
  assertEquals(merged.actual.find(r => r.start_ts === start)!.grid_import_kwh, 0);
  assertEquals(merged.actual.find(r => r.start_ts === new Date(at + 900_000).toISOString())!.grid_import_kwh, 1);
  assertEquals(merged.deviceSlots.find(r => r.start_ts === start)!.device_energy_kwh['car-id'], 0);
  assertEquals(merged.evInitial, rows.evInitial);
});

Deno.test('incompatible recovered household meters use independent other-device baseline without clipping actual load', () => {
  const data = capture(); data.find(s => s.statistic_id === 'load')!.statistics = series('load', 'MWh', [0, .001, .0011]).statistics;
  const hours = prepareHourlyRecovery(data, spec), rows = baselineFixture({ start, end: new Date(at + hour).toISOString() });
  rows.actual = []; rows.deviceSlots = []; rows.pool = []; rows.evInitial = null;
  const merged = mergeHourlyHistory(rows, hours), input = prepareHomeBaseline(merged);
  assertAlmostEquals(input.problem.slots[0].base_w, 460); // Other meter 0.4kWh/h + 60W circulation.
  assertAlmostEquals(input.recorded.rows[0].loadW!, 100);
  assertEquals(input.recovery.deviceSumHours, 1);
  const measured = baselineFixture({ start, end: rows.end });
  assertEquals(mergeHourlyHistory(measured, hours).baselineLoads.length, 0);
  measured.actual[1].total_load_kwh = null;
  assertEquals(mergeHourlyHistory(measured, hours).baselineLoads.length, 1);
});

Deno.test('replacement sources choose a present zero over the older meter without double counting', () => {
  const selected = { ...spec, actual: { ...spec.actual, grid_import_kwh: ['new-grid', 'grid'] } };
  const hours = prepareHourlyRecovery([...capture(), series('new-grid', 'kWh', [1, 1, 1])], selected);
  assertEquals(hours.at(-1)!.actual.grid_import_kwh, 0);
  assertEquals(hours.at(-1)!.sources.grid_import_kwh, 'new-grid');
});

Deno.test('partial frame reads conserve the selected fraction and keep hour-end initial means', () => {
  const rows = baselineFixture({ start: new Date(at + 900_000).toISOString(), end: new Date(at + 2 * 900_000).toISOString() });
  rows.actual = []; rows.deviceSlots = []; rows.pool = []; rows.evInitial = null;
  const input = prepareHomeBaseline(mergeHourlyHistory(rows, prepareHourlyRecovery(capture(), spec)));
  assertEquals(input.recorded.ledger.importKwh, 1);
  assertAlmostEquals(input.problem.initial.ev_kwh!, .7 * input.problem.car!.capacity_kwh);
});
