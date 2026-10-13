import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { readFileSync } from 'node:fs';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import { prepareRulesPlanningInput } from '../../../supabase/functions/_shared/rules-planner.ts';
import { baselineFixture } from './fixture.ts';
import { homePhysics } from './home-physics.ts';
import { prepareHomeBaseline, projectBaseline, frameStart, shiftFrame } from './model.ts';
import { projectDefaultProblem, DEFAULT_SETTINGS } from './controller.ts';
import { latestPeriod, stepPeriod } from './period.ts';

const engine = createWasmPlanner(new Uint8Array(readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));

Deno.test('calendar month carries physical state through every former 72-hour boundary and reconciles native cost', () => {
  const anchor = { snapshot: baselineFixture().snapshot, earliestStart: '2026-01-01T00:00:00.000Z', latestEnd: '2026-11-01T00:00:00.000Z' };
  const period = stepPeriod(anchor, latestPeriod(anchor, 'month'), -1)!;
  const rows = baselineFixture(period), input = prepareHomeBaseline(rows);
  assertEquals(input.problem.slots.length, 2980);
  assertEquals(input.evDemandKwh.length, 2980);
  const result = projectBaseline(input, engine);
  const continuous = engine.project(input.problem, result.commands).outcome;
  if (continuous.kind === 'failed') throw new Error(continuous.issue);
  assertEquals(result.series.start.at(-1), '2026-10-31T22:45:00.000Z');
  assertAlmostEquals(result.ledger.costSek, result.series.costSek.reduce((a, b) => a + b, 0));
  for (const i of [287, 288, 575, 576, 2016, 2979]) {
    assertAlmostEquals(result.series.costSek[i], continuous.quarters[i].cost, 1e-8);
    assertAlmostEquals(result.series.homeSoc[i]!, continuous.quarters[i].battery_kwh! / input.problem.battery!.capacity_kwh * 100);
    assertAlmostEquals(result.series.poolC[i]!, continuous.quarters[i].pool_c!);
  }
  assert(result.series.homeSoc[288]! < result.series.homeStartSoc!);
});

Deno.test('home physical models match unchanged live preparation', () => {
  const { snapshot } = baselineFixture();
  snapshot.slots = snapshot.slots.map(s => ({ ...s, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: .2 }));
  const p = prepareRulesPlanningInput({ snapshot, now: snapshot.captured_at, resolved_price_outlook: {
    level_sek_per_kwh: 1, observed_days: 1, effective_days: 1, shaped: false,
    shadow_import_sek_per_kwh: snapshot.slots.map(() => 1),
  } }, null, { rules: [], service_guard: { pool: [0, 0], ev: [0, 0] } }).problem;
  const facts = homePhysics(snapshot);
  assertEquals(facts.battery, p.battery);
  assertEquals(facts.car, p.car);
  assertEquals(facts.charger, p.charger);
  assertEquals(facts.poolStore, p.pool_store);
  assertEquals(facts.heater, p.heater);
});

Deno.test('empirical pool normalization agrees with live preparation', () => {
  const rows = baselineFixture();
  delete rows.snapshot.device_physics!.pool;
  rows.snapshot.pool_model!.response = [{ at_c: 25, idle_c_per_h: -.03, heat_c_per_kwh: .04, heated_kwh: 5 }, { at_c: 31, idle_c_per_h: -.05, heat_c_per_kwh: .05, heated_kwh: 10 }];
  rows.snapshot.slots = rows.snapshot.slots.map(s => ({ ...s, import_price_sek_per_kwh: 1, export_price_sek_per_kwh: .2 }));
  const p = prepareRulesPlanningInput({ snapshot: rows.snapshot, now: rows.snapshot.captured_at, resolved_price_outlook: {
    level_sek_per_kwh: 1, observed_days: 1, effective_days: 1, shaped: false,
    shadow_import_sek_per_kwh: rows.snapshot.slots.map(() => 1),
  } }, null, { rules: [], service_guard: { pool: [0, 0], ev: [0, 0] } }).problem;
  const facts = homePhysics(rows.snapshot);
  assertEquals(facts.poolStore, p.pool_store);
  assertEquals(facts.heater, p.heater);
});

Deno.test('home reconstruction joins UUID meters and counts the circulation floor once', () => {
  const input = prepareHomeBaseline(baselineFixture());
  assertEquals(input.problem.slots.length, 288);
  assertAlmostEquals(input.problem.slots[0].base_w, 1060);
  assertEquals(input.problem.heater!.auxiliary_w, 704);
  assertEquals(input.problem.initial.battery_kwh, .5 * input.problem.battery!.capacity_kwh);
  assertEquals(input.initialObservedAt, new Date(Date.parse(input.start) - 900_000).toISOString());
  assertEquals(input.problem.initial.heater_state, { kind: 'off_unobserved' });
});

Deno.test('missing historical prices still fail instead of inventing electricity costs', () => {
  const rows = baselineFixture(); rows.prices.pop();
  assertThrows(() => prepareHomeBaseline(rows), Error, 'import price');
});

for (const gap of ['null', 'absent'] as const) {
  Deno.test(`missing initial EV SOC and pool temperature (${gap}) use disclosed defaults through a whole month`, () => {
    const rows = baselineFixture({ start: '2026-04-30T22:00:00.000Z', end: '2026-05-31T22:00:00.000Z' });
    rows.actual.forEach(row => { row.ev_soc = null; });
    if (gap === 'absent') { rows.evInitial = null; rows.pool = []; }
    else { rows.evInitial!.ev_soc = null; rows.pool[0].water_temperature_c = null; }
    // Null in-period temperatures must remain gaps in the recorded graph.
    rows.pool.push({ start_ts: rows.start, water_temperature_c: null });
    const input = prepareHomeBaseline(rows), result = projectBaseline(input, engine);
    assertEquals(input.evInitialAssumed, true);
    assertEquals(input.poolInitialAssumed, true);
    assertEquals(input.evInitialObservedAt, null);
    assertAlmostEquals(input.problem.initial.ev_kwh!, .8 * input.problem.car!.capacity_kwh);
    assertEquals(input.problem.initial.pool_c, 30);
    assertEquals(result.series.start.length, 31 * 96);
    assertEquals(result.commands[0].pool_on, true);
    assertEquals(result.series.carSoc.every(value => Math.abs(value! - 80) < 1e-8), true);
    assertEquals(input.recorded.rows.every(row => row.evSoc === null && row.poolC === null), true);
    assertEquals(input.evDemandKwh.every(value => value === 0), true);
    assertAlmostEquals(result.ledger.costSek, result.series.costSek.reduce((sum, value) => sum + value, 0));
  });
}

Deno.test('assumed initial EV SOC does not invent driving before the first observed reading', () => {
  const rows = baselineFixture(); rows.evInitial = null;
  rows.actual.slice(1).forEach((row, i) => { row.ev_soc = i < 2 ? null : i < 4 ? .2 : i < 6 ? .1 : i < 8 ? .9 : .8; });
  const input = prepareHomeBaseline(rows), result = projectBaseline(input, engine);
  assertEquals(input.evDemandKwh[2], 0);
  assertAlmostEquals(input.evDemandKwh[4], .1 * input.problem.car!.capacity_kwh);
  assertEquals(input.evDemandKwh[6], 0);
  assertAlmostEquals(input.evDemandKwh[8], .1 * input.problem.car!.capacity_kwh);
  assertAlmostEquals(result.series.carSoc[2]!, 80);
  assertAlmostEquals(result.series.carSoc[4]!, 70);
  assertAlmostEquals(result.series.carSoc[6]!, 70);
  assertAlmostEquals(result.series.carSoc[8]!, 60);
  assertAlmostEquals(result.series.carSoc.at(-1)!, 80);
});

Deno.test('valid initial EV and pool readings remain authoritative; invalid readings are rejected', () => {
  for (const [evSoc, poolC] of [[0, 0], [.9, 31]]) {
    const rows = baselineFixture(); rows.evInitial!.ev_soc = evSoc; rows.pool[0].water_temperature_c = poolC;
    const input = prepareHomeBaseline(rows);
    assertEquals(input.evInitialAssumed, false); assertEquals(input.poolInitialAssumed, false);
    assertEquals(input.evInitialObservedAt, rows.evInitial!.start_ts);
    assertAlmostEquals(input.problem.initial.ev_kwh!, evSoc * input.problem.car!.capacity_kwh);
    assertEquals(input.problem.initial.pool_c, poolC);
  }
  const rows = baselineFixture(); rows.evInitial!.ev_soc = 1.1;
  assertThrows(() => prepareHomeBaseline(rows), Error, 'initial EV SOC');
  rows.evInitial!.ev_soc = .8; rows.evInitial!.start_ts = rows.start;
  assertThrows(() => prepareHomeBaseline(rows), Error, 'before the frame');
  rows.evInitial!.start_ts = rows.actual[0].start_ts; rows.pool[0].water_temperature_c = NaN;
  assertThrows(() => prepareHomeBaseline(rows), Error, 'initial pool temperature');
});

for (const gap of ['null', 'absent'] as const) {
  Deno.test(`missing initial battery SOC (${gap}) starts an empty battery and projects a whole month`, () => {
    const rows = baselineFixture({ start: '2026-04-30T22:00:00.000Z', end: '2026-05-31T22:00:00.000Z' });
    rows.actual.forEach(row => { row.battery_soc = null; });
    if (gap === 'absent') rows.actual.shift();
    const input = prepareHomeBaseline(rows), result = projectBaseline(input, engine);
    assertEquals(input.batteryInitialAssumed, true);
    assertEquals(input.problem.initial.battery_kwh, 0);
    assertEquals(result.series.homeStartSoc, 0);
    assertEquals(result.series.start.length, 31 * 96);
    assertEquals(input.recorded.rows.every(row => row.batterySoc === null), true);
    assertEquals(result.series.batteryDischargeW.every(w => w === 0), true);
    assertAlmostEquals(result.ledger.costSek, result.series.costSek.reduce((sum, v) => sum + v, 0));
    // Empty storage may refill from later solar; the configured minimum is not invented starting energy.
    rows.actual[1].solar_production_kwh = 2;
    const refilled = projectBaseline(prepareHomeBaseline(rows), engine);
    assert(refilled.series.batteryChargeW.some(w => w > 0));
    assert(refilled.series.homeSoc.some(value => value !== null && value > 0));
  });
}

Deno.test('available initial SOC, including a measured empty battery, remains authoritative', () => {
  for (const value of [0, .5]) {
    const rows = baselineFixture(); rows.actual[0].battery_soc = value;
    const input = prepareHomeBaseline(rows);
    assertEquals(input.batteryInitialAssumed, false);
    assertEquals(input.problem.initial.battery_kwh, value * input.problem.battery!.capacity_kwh);
  }
  const rows = baselineFixture(); rows.actual[0].battery_soc = 1.1;
  assertThrows(() => prepareHomeBaseline(rows), Error, 'initial battery SOC');
  rows.snapshot.capabilities.battery = false;
  const input = prepareHomeBaseline(rows);
  assertEquals(input.batteryInitialAssumed, false); assertEquals(input.problem.initial.battery_kwh, null);
});

Deno.test('replacement heater and offline meter readings contribute zero without blocking modelled heating', () => {
  const rows = baselineFixture();
  delete rows.deviceSlots[0].device_energy_kwh['heater-id'];
  rows.deviceSlots[1].device_energy_kwh['pump-id'] = null;
  rows.deviceSlots.splice(2, 1);
  rows.pool[0].water_temperature_c = 30;
  const input = prepareHomeBaseline(rows), result = projectBaseline(input, engine);
  assertAlmostEquals(input.problem.slots[0].base_w, 1060);
  assertAlmostEquals(input.problem.slots[1].base_w, 1120);
  assertAlmostEquals(input.problem.slots[2].base_w, 1120);
  assertEquals(input.energyGaps.deviceReadings, 5);
  assertEquals(result.commands[0].pool_on, true);
  assert(result.series.deviceW.$default_pool_heat[0] > 0);
  assertAlmostEquals(result.ledger.costSek, result.series.costSek.reduce((a, b) => a + b, 0));
});

Deno.test('missing total consumption uses other device meters, excluding the loads being modelled', () => {
  const rows = baselineFixture();
  rows.actual[1].total_load_kwh = null;
  rows.deviceSlots[0].device_energy_kwh = { 'heater-id': .5, 'pump-id': .015, 'car-id': 1,
    'household-id': .25, 'hot-water-id': .1, 'offline-id': null };
  const input = prepareHomeBaseline(rows);
  assertAlmostEquals(input.problem.slots[0].base_w, 1460);
  assertEquals(input.energyGaps.householdQuarters, 1);
  assertEquals(input.energyGaps.deviceReadings, 1);
  // A valid total still retains the unmetered household demand.
  assertAlmostEquals(input.problem.slots[1].base_w, 1060);
});

Deno.test('absent energy quarters produce zero observed demand and solar while default controls still run', () => {
  const rows = baselineFixture();
  rows.actual.splice(1, 1); rows.deviceSlots.splice(0, 1);
  rows.actual[1].solar_production_kwh = null;
  const input = prepareHomeBaseline(rows);
  assertEquals(input.problem.slots[0].base_w, 60);
  assertEquals(input.problem.slots[0].solar_w, 0);
  assertEquals(input.problem.slots[1].solar_w, 0);
  assertEquals(input.energyGaps, { householdQuarters: 1, solarQuarters: 2, deviceReadings: 3 });
  assertEquals(projectBaseline(input, engine).series.start.length, 288);
});

Deno.test('invalid observed energy is rejected rather than treated as a sensor gap', () => {
  for (const value of [NaN, Infinity, -1]) {
    const rows = baselineFixture();
    rows.deviceSlots[0].device_energy_kwh['heater-id'] = value;
    assertThrows(() => prepareHomeBaseline(rows), Error, 'device meter');
  }
});

Deno.test('other device meters supply missing household totals when no stores are modelled', () => {
  const rows = baselineFixture();
  rows.snapshot.capabilities = { battery: false, pool: false, ev: false };
  rows.actual[1].total_load_kwh = null;
  rows.deviceSlots[0].device_energy_kwh = { 'household-id': .25, 'hot-water-id': .1 };
  assertAlmostEquals(prepareHomeBaseline(rows).problem.slots[0].base_w, 1400);
});

Deno.test('unknown device IDs, inconsistent total load and unsupported pump model fail', () => {
  let rows = baselineFixture();
  rows.devices.pop();
  assertThrows(() => prepareHomeBaseline(rows), Error, 'car');
  rows = baselineFixture(); rows.actual[1].total_load_kwh = .001;
  assertThrows(() => prepareHomeBaseline(rows), Error, 'exceeds');
  rows = baselineFixture(); rows.snapshot.device_physics!.pool!.heater.auxiliary_w = 30;
  assertThrows(() => prepareHomeBaseline(rows), Error, '60');
});

Deno.test('DST frames are 288 contiguous quarters and adjacent without overlap', () => {
  const rows = baselineFixture(), start = frameStart(rows.end);
  assertEquals(Date.parse(rows.end) - Date.parse(start), 72 * 3_600_000);
  assertEquals(shiftFrame(rows.end, -1), start);
  assertEquals(frameStart(shiftFrame(rows.end, 1)), rows.end);
  const p = prepareHomeBaseline(rows);
  assertEquals(p.problem.slots[287].start_seconds, 287 * 900);
});

Deno.test('projection is native physics only, does not mutate input, and reconciles signed cash', () => {
  const input = prepareHomeBaseline(baselineFixture()), before = JSON.stringify(input);
  const guarded = { project: engine.project, solve: () => { throw new Error('must never solve'); } };
  const result = projectBaseline(input, guarded);
  assertEquals(JSON.stringify(input), before);
  assertEquals(result.series.start.length, 288);
  assertAlmostEquals(result.ledger.costSek, result.series.costSek.reduce((a, b) => a + b, 0));
  assertAlmostEquals(result.series.loadW[0], 1060 + result.series.carW[0]);
  const full = engine.project(input.problem, result.commands).outcome;
  assertEquals(full.kind, 'projected');
  if (full.kind === 'failed') throw new Error(full.issue);
  for (let i = 0; i < 288; i++) assertAlmostEquals(result.series.costSek[i], full.quarters[i].cost, 1e-8);
});

Deno.test('optional absent stores require no state, meters or weather, with negative export pricing', () => {
  const rows = baselineFixture();
  rows.snapshot.capabilities = { ...rows.snapshot.capabilities, battery: false, pool: false, ev: false };
  rows.actual = rows.actual.slice(1).map(r => ({ ...r, solar_production_kwh: 1, battery_soc: null, ev_soc: null }));
  rows.deviceSlots = []; rows.devices = []; rows.pool = [];
  rows.prices.forEach(p => { p.import_price_sek_per_kwh = -1; p.export_price_sek_per_kwh = -.2; });
  const input = prepareHomeBaseline(rows), result = projectBaseline(input, engine);
  assertEquals(input.evInitialAssumed, false); assertEquals(input.poolInitialAssumed, false);
  assertEquals(input.problem.initial.ev_kwh, null); assertEquals(input.problem.initial.pool_c, null);
  assertEquals(result.series.homeSoc.every(v => v === null), true);
  assertEquals(result.series.carSoc.every(v => v === null), true);
  assertEquals(result.series.poolC.every(v => v === null), true);
  assertEquals(result.series.poolW.every(v => v === 0), true);
  assert(result.ledger.exportRevenueSek < 0);
});

Deno.test('EV waits for midnight then tapers to80%', () => {
  const input = prepareHomeBaseline(baselineFixture());
  input.problem.initial.ev_kwh = .799 * input.problem.car!.capacity_kwh;
  const r = projectDefaultProblem(input.problem, input.start, input.timeZone, DEFAULT_SETTINGS, engine, input.evDemandKwh);
  const first = r.commands.findIndex(c => c.ev_amps > 0);
  assertEquals(first, 88); // start02:00 local; next midnight22:00Z.
  assert(r.quarters[first].ev_w > 0 && r.quarters[first].ev_w < 11040);
  assertAlmostEquals(r.quarters.at(-1)!.ev_kwh!, .8 * input.problem.car!.capacity_kwh);
  assert(r.commands.slice(first + 1).every(c => c.ev_amps === 0));
});

Deno.test('thermostat carries its latch and native physical stops across quarters', () => {
  const input = prepareHomeBaseline(baselineFixture());
  input.problem.initial.pool_c = 30;
  const r = projectDefaultProblem(input.problem, input.start, input.timeZone, DEFAULT_SETTINGS, engine, input.evDemandKwh);
  assertEquals(r.commands[0].pool_on, true);
  const stop = r.quarters.findIndex(q => q.heater_state?.kind === 'off');
  assert(stop > 0);
  assertEquals(r.commands[stop + 1].pool_on, false);
});

Deno.test('the car is paused first; a pool thermostat on top of a full house runs over the limit instead of failing the month', () => {
  const rows = baselineFixture({ start: '2026-05-01T22:00:00.000Z', end: '2026-05-02T04:00:00.000Z' });
  const input = prepareHomeBaseline(rows);
  // No battery to lean on; the car wants to charge from midnight and the pool wants heat.
  input.problem.battery = null; input.problem.initial.battery_kwh = null;
  input.problem.initial.ev_kwh = .4 * input.problem.car!.capacity_kwh;
  input.problem.initial.pool_c = 30;
  const limit = input.problem.limits.import_w;
  // Quarter 0: room for the heater but not for any charging. Quarter 1: the house alone nearly fills the supply.
  input.problem.slots[0].base_w = limit - input.problem.heater!.compressor_w - input.problem.heater!.auxiliary_w - 1000;
  input.problem.slots[1].base_w = limit - 50;
  const r = projectDefaultProblem(input.problem, input.start, input.timeZone, DEFAULT_SETTINGS, engine, input.evDemandKwh);
  assertEquals(r.commands.slice(0, 3).map(c => [c.pool_on, c.ev_amps > 0]), [[true, false], [true, false], [true, true]]);
  assert(r.quarters[0].net_w <= limit + 1e-6, 'pausing the car is enough in the first quarter');
  assert(r.quarters[1].net_w > limit && r.quarters[1].pool_compressor_w > 0, 'the thermostat is not interrupted');
  // A house that exceeds its own limit with everything off is a data fault and still stops the month.
  input.problem.slots[1].base_w = limit + 500;
  assertThrows(() => projectDefaultProblem(input.problem, input.start, input.timeZone, DEFAULT_SETTINGS, engine, input.evDemandKwh), Error, 'quarter 1: shared_grid_limit');
});

Deno.test('default overnight EV charging load balances within the home grid limit and resumes at full current', () => {
  const rows = baselineFixture({ start: '2026-05-01T22:00:00.000Z', end: '2026-05-02T04:00:00.000Z' });
  const input = prepareHomeBaseline(rows);
  input.problem.initial.ev_kwh = .4 * input.problem.car!.capacity_kwh;
  input.problem.initial.battery_kwh = input.problem.battery!.min_soc * input.problem.battery!.capacity_kwh;
  input.problem.slots[0].base_w = 10_000;
  const result = projectBaseline(input, engine);
  assert(result.commands[0].ev_amps > 0 && result.commands[0].ev_amps < input.problem.charger!.max_current_a);
  assertEquals(result.commands[1].ev_amps, input.problem.charger!.max_current_a);
  assert(result.series.gridImportW.every(w => w <= rows.snapshot.grid.import_limit_w + 1e-6));
  assertAlmostEquals(result.series.carSoc.at(-1)!, 80);
});

Deno.test('linear outdoor loss requires historical outdoor observations', () => {
  const rows = baselineFixture();
  rows.snapshot.device_physics!.pool!.store.loss = { kind: 'linear', kw_per_c: .1, surroundings_c: null };
  assertThrows(() => prepareHomeBaseline(rows), Error, 'outdoor');
  rows.outdoor = rows.prices.map(p => ({ start_ts: p.start_ts, temperature_c: 15 }));
  assertEquals(prepareHomeBaseline(rows).problem.slots[0].outdoor_c, 15);
});

Deno.test('recorded SOC declines become daily driving demand; charging increases are discarded', () => {
  const rows = baselineFixture();
  rows.evInitial!.ev_soc = .8;
  rows.actual.slice(1).forEach((r, i) => { r.ev_soc = i < 12 ? .8 : i < 40 ? .7 : i < 60 ? .9 : i < 80 ? .85 : .8; });
  const input = prepareHomeBaseline(rows);
  assertAlmostEquals(input.evDemandKwh.reduce((sum, v) => sum + v, 0), .2 * input.problem.car!.capacity_kwh);
  assertEquals(input.evDemandKwh[40], 0);
  assertAlmostEquals(input.evDailyDemand.reduce((sum, d) => sum + d.kwh, 0), .2 * input.problem.car!.capacity_kwh);
  const result = projectBaseline(input, engine);
  assertAlmostEquals(result.series.carSoc[12]!, 70);
  assertAlmostEquals(result.series.carSoc[40]!, 70); // actual charging never tops up the default model
  assertAlmostEquals(result.series.carSoc[80]!, 60);
  assertAlmostEquals(result.series.carSoc.at(-1)!, 80);
});

Deno.test('SOC gaps retain observed declines across the gap and disclose missing quarters', () => {
  const rows = baselineFixture();
  rows.evInitial!.ev_soc = .8;
  rows.actual[1].ev_soc = null; rows.actual[2].ev_soc = null; rows.actual[3].ev_soc = .7;
  const input = prepareHomeBaseline(rows);
  assertEquals(input.evMissingSocQuarters, 2);
  assertAlmostEquals(input.evDemandKwh[2], .1 * input.problem.car!.capacity_kwh);
});

Deno.test('unreachable recorded driving demand fails rather than clipping trips', () => {
  const input = prepareHomeBaseline(baselineFixture());
  input.evDemandKwh[0] = input.problem.car!.capacity_kwh;
  assertThrows(() => projectBaseline(input, engine), Error, 'unserved recorded EV trip');
});
