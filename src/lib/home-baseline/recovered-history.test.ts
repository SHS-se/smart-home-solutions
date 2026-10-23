import { assertAlmostEquals, assertEquals } from '@std/assert';
import { baselineFixture } from './fixture.ts';
import { alignLateMeters, energyDeltas, mergeHourlyHistory, prepareHourlyRecovery, type RecoveredHour, type RecoverySpec } from './recovered-history.ts';
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
  assertEquals(input.problem.slots.map(slot => slot.ev_available), [false, false, false, false]);
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

Deno.test('missing household demand uses electricity balance before an incomplete device sum', () => {
  const selected = { ...spec, actual: { ...spec.actual, solar_production_kwh: ['pv'], grid_export_kwh: ['export'],
    battery_charge_kwh: ['charge'], battery_discharge_kwh: ['discharge'] } };
  const data = capture().filter(s => s.statistic_id !== 'load');
  data.push(series('pv', 'kWh', [0, 0, 2]), series('export', 'kWh', [0, 0, 1]),
    series('charge', 'kWh', [0, 0, .3]), series('discharge', 'kWh', [0, 0, .1]));
  const recovered = prepareHourlyRecovery(data, selected).at(-1)!;
  assertAlmostEquals(recovered.actual.total_load_kwh!, 4.8);
  assertEquals(recovered.baseline_load_kwh, null);
  const noOtherChannels = prepareHourlyRecovery(capture().filter(s => s.statistic_id !== 'load'), spec).at(-1)!;
  assertEquals(noOtherChannels.actual.total_load_kwh, 4);
  const noGrid = prepareHourlyRecovery(capture().filter(s => !['load', 'grid'].includes(s.statistic_id)), spec).at(-1)!;
  assertAlmostEquals(noGrid.baseline_load_kwh!, .4);
});

Deno.test('PostgREST offset timestamps match recovered UTC quarters without duplicate or overwritten measurements', () => {
  const rows = baselineFixture({ start, end: new Date(at + hour).toISOString() });
  rows.actual.forEach(r => { r.start_ts = r.start_ts.replace('.000Z', '+00:00'); });
  rows.pool.forEach(r => { r.start_ts = r.start_ts.replace('.000Z', '+00:00'); });
  rows.deviceSlots.forEach(r => { r.start_ts = r.start_ts.replace('.000Z', '+00:00'); });
  rows.actual[1].grid_import_kwh = 0;
  const merged = mergeHourlyHistory(rows, prepareHourlyRecovery(capture(), spec));
  const input = prepareHomeBaseline(merged);
  assertEquals(merged.actual.length, 5);
  assertEquals(merged.actual.find(r => r.start_ts === start)!.grid_import_kwh, 0);
  assertAlmostEquals(input.recorded.ledger.importKwh, .265 * 3);
  assertEquals(input.problem.initial.pool_c, 31);
});

Deno.test('mixed hourly device recovery uses other meters when it conflicts with a measured quarter total', () => {
  const rows = baselineFixture({ start, end: new Date(at + hour).toISOString() });
  rows.devices.push({ id: 'other-id', colour: '#c07800', device_key: 'appliances', category: 'household' },
    { id: 'legacy-car-id', colour: '#467821', device_key: 'old_charger', category: 'ev_charging' });
  rows.actual.forEach(r => { r.total_load_kwh = .1; });
  rows.deviceSlots.forEach(r => { r.device_energy_kwh = { 'legacy-car-id': 2 }; });
  const merged = mergeHourlyHistory(rows, prepareHourlyRecovery(capture(), spec));
  const input = prepareHomeBaseline(merged);
  assertEquals(merged.baselineLoads.length, 4);
  assertAlmostEquals(input.problem.slots[0].base_w, 460);
  assertAlmostEquals(input.recorded.rows[0].loadW!, 400);
  assertEquals(merged.deviceSlots.find(r => r.start_ts === start)!.device_energy_kwh['legacy-car-id'], 2);
  assertEquals(input.recovery.deviceSumHours, 1);
});

// A night's charging as the house meter saw it (22:00–01:00) and as a late counter reported it (23:00–02:00).
const recoveredHour = (i: number, load: number, car: number, other: number, source = 'late-car'): RecoveredHour => ({
  start_ts: new Date(at + i * hour).toISOString(), actual: { total_load_kwh: load, grid_import_kwh: load },
  device_energy_kwh: { 'car-id': car, 'other-id': other }, pool_c: null, outdoor_c: null,
  // As first normalised: where the car's reading exceeds the house, the other meters stand in.
  baseline_load_kwh: load - car < -1e-9 ? other : null,
  sources: { grid_import_kwh: 'grid', household_estimate: 'grid_balance', 'device:car-id': source, 'device:other-id': 'other' }, invalid_readings: 0 });
const night = () => [recoveredHour(0, 2, 0, .5), recoveredHour(1, 13, 0, .5), recoveredHour(2, 12.5, 10.5, .5), recoveredHour(3, 13.5, 11, .5),
  recoveredHour(4, 5, 11, .5), recoveredHour(5, 2, 3.5, .5), recoveredHour(6, 2, 0, .5)];

Deno.test('a counter that reports an hour late has its energy moved back to the hour it was drawn', () => {
  const aligned = alignLateMeters(night(), new Set(['car-id']));
  assertEquals(aligned.map(h => h.device_energy_kwh['car-id']), [0, 10.5, 11, 11, 3.5, 0, 0]);
  // The house without the car is an ordinary 2 kWh every hour, instead of 13 at the start and a stand-in at the end.
  assertEquals(aligned.map(h => h.actual.total_load_kwh! - h.device_energy_kwh['car-id']), [2, 2.5, 1.5, 2.5, 1.5, 2, 2]);
  assertEquals(aligned.map(h => h.baseline_load_kwh), [null, null, null, null, null, null, null]);
  assertEquals(aligned.reduce((n, h) => n + h.device_energy_kwh['car-id'], 0), 36, 'no energy is created or lost');
  assertEquals(aligned.map(h => h.device_energy_kwh['other-id']), night().map(h => h.device_energy_kwh['other-id']));
});

Deno.test('a prompt counter is left alone, also after it replaces a late one', () => {
  const prompt = [recoveredHour(0, 2, 0, .5, 'car'), recoveredHour(1, 13, 11, .5, 'car'), recoveredHour(2, 12.5, 10.5, .5, 'car'), recoveredHour(3, 2, 0, .5, 'car')];
  assertEquals(alignLateMeters(prompt, new Set(['car-id'])), prompt);
  // The late counter's nights are corrected; the prompt counter that took over keeps its own hours.
  const replaced = [...night(), recoveredHour(7, 13, 11, .5, 'car'), recoveredHour(8, 2, 0, .5, 'car')];
  const aligned = alignLateMeters(replaced, new Set(['car-id']));
  assertEquals(aligned.map(h => h.device_energy_kwh['car-id']), [0, 10.5, 11, 11, 3.5, 0, 0, 11, 0]);
  assertEquals(aligned.slice(7).map(h => h.sources['device:car-id']), ['car', 'car']);
});

Deno.test('one impossible reading that an earlier hour does not explain is not treated as lateness', () => {
  // The hour before is just as small, so reading it earlier fixes nothing.
  const odd = [recoveredHour(0, 2, 0, .5), recoveredHour(1, 2, 0, .5), recoveredHour(2, 2, 6, .5), recoveredHour(3, 2, 0, .5)];
  assertEquals(alignLateMeters(odd, new Set(['car-id'])), odd);
});

Deno.test('the baseline model sees the corrected house: no phantom load in the hour charging began', () => {
  const fixture = baselineFixture({ start, end: new Date(at + 7 * hour).toISOString() });
  fixture.actual = []; fixture.deviceSlots = [];
  const merged = mergeHourlyHistory(fixture, [recoveredHour(-1, 2, 0, .5), ...night()].map(h => ({ ...h, actual: { ...h.actual, ev_soc: .5, battery_soc: .5 } })));
  const input = prepareHomeBaseline(merged);
  const houseKw = (i: number) => input.problem.slots.slice(i * 4, i * 4 + 4).reduce((n, slot) => n + slot.base_w, 0) / 4000;
  // Idle pool circulation is the only addition to the measured house in each hour.
  [2, 2.5, 1.5, 2.5, 1.5, 2, 2].forEach((kw, i) => assertAlmostEquals(houseKw(i), kw + input.idlePumpW / 1000, 1e-9));
});
