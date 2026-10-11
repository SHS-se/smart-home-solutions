import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { readFileSync } from 'node:fs';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import { prepareRulesPlanningInput } from '../../../supabase/functions/_shared/rules-planner.ts';
import { baselineFixture } from './fixture.ts';
import { homePhysics } from './home-physics.ts';
import { prepareHomeBaseline, projectBaseline, frameStart, shiftFrame } from './model.ts';
import { projectDefaultProblem, DEFAULT_SETTINGS } from './controller.ts';

const engine = createWasmPlanner(new Uint8Array(readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url))));

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

for (const source of ['load', 'solar', 'price', 'meter', 'battery', 'ev', 'pool'] as const) {
  Deno.test(`missing historical ${source} fails instead of substituting a current reading or zero`, () => {
    const rows = baselineFixture();
    if (source === 'load') rows.actual[1].total_load_kwh = null;
    if (source === 'solar') rows.actual[1].solar_production_kwh = null;
    if (source === 'price') rows.prices.pop();
    if (source === 'meter') delete rows.deviceSlots[0].device_energy_kwh['pump-id'];
    if (source === 'battery') rows.actual[0].battery_soc = null;
    if (source === 'ev') rows.evInitial = null;
    if (source === 'pool') rows.pool = [];
    assertThrows(() => prepareHomeBaseline(rows));
  });
}

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
  const result = projectBaseline(prepareHomeBaseline(rows), engine);
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
  assertThrows(() => projectBaseline(input, engine), Error, 'Recorded EV demand exceeds');
});
