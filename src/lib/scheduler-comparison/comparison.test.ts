import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core.ts';
import { readyProblem } from '../../../bench/wasm-planner.ts';
import { HOUSEHOLD } from '../planner-bench/household.ts';
import { realisticWorld, world } from '../planner-bench/world.fixture.ts';
import { DEFAULT_SETTINGS, compareScheduler, forecastProblem, projectDefaults, electricityLedger, subscriptionForCase } from './comparison.ts';

const engine = createWasmPlanner(await Deno.readFile(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url)));
const measured = (c = world()) => ({ ...c, recorded: { ...c.recorded, actual: { base_load_w: [...c.base_load_forecast_w], solar_w: [...c.solar_forecast_w] } } });

Deno.test('scheduler comparison starts with the requested native settings', () => {
  assertEquals(DEFAULT_SETTINGS, { poolStartC: 30, poolStopC: 30.5, idlePumpW: 60, batterySuppliesEv: true });
});

Deno.test('SHS modelling retains the existing solar, load and price forecasts', () => {
  const c = measured(realisticWorld());
  const previous = readyProblem(c, HOUSEHOLD);
  const p = forecastProblem(c, HOUSEHOLD, DEFAULT_SETTINGS, {});
  assertEquals(p.slots.map(s => s.solar_w), previous.slots.map(s => s.solar_w));
  assertEquals(p.slots.map(s => s.import_price), previous.slots.map(s => s.import_price));
  assertEquals(p.slots.map(s => s.export_price), previous.slots.map(s => s.export_price));
  assertEquals(p.slots.map(s => s.base_w), previous.slots.map(s => s.base_w + 60));
  assertEquals(p.heater!.auxiliary_w, previous.heater!.auxiliary_w - 60);
  assertEquals(p.pool_stop_c, 30.5);
  const changed = forecastProblem({ ...c, solar_forecast_w: c.solar_forecast_w.map(v => v * .5) }, HOUSEHOLD, DEFAULT_SETTINGS, {});
  assertEquals(changed.slots.map(s => s.solar_w), p.slots.map(s => s.solar_w * .5));
});

Deno.test('default thermostat retains its latch in the deadband and uses native startup physics', () => {
  const h = { ...HOUSEHOLD, pool: { ...HOUSEHOLD.pool, store: { capacity_kwh_per_c: 1, loss: { kind: 'linear' as const, kw_per_c: .13, surroundings_c: 13.5 } } } };
  const c = measured(world({ start: { pool_water_c: 29.9, ev: { soc: .8 } } }));
  const p = forecastProblem(c, h, DEFAULT_SETTINGS, {});
  const result = projectDefaults(c, h, p, DEFAULT_SETTINGS, engine);
  assert(result.commands[0].pool_on);
  assertEquals(result.quarters[0].heater_state?.kind, 'off');
  assertEquals(result.commands[1].pool_on, false);
  assert(result.quarters.every(q => q.pool_c! <= 30.5));
  assert(result.commands.some(command => !command.pool_on));
  const hot = measured(world({ start: { pool_water_c: 31, ev: { soc: .8 } } }));
  assertEquals(projectDefaults(hot, h, forecastProblem(hot, h, DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS, engine).commands[0].pool_on, false);
});

Deno.test('midnight EV charging tapers to exactly 80% without invented trips', () => {
  const c = measured(world({ start: { pool_water_c: 31, ev: { soc: .799 } } }));
  const p = forecastProblem(c, HOUSEHOLD, DEFAULT_SETTINGS, {});
  const r = projectDefaults(c, HOUSEHOLD, p, DEFAULT_SETTINGS, engine);
  assertEquals(r.commands.slice(0, 88).every(command => command.ev_amps === 0), true);
  assertEquals(r.commands[88].ev_amps, HOUSEHOLD.car.charger.max_current_a);
  assert(r.quarters[88].ev_w > 0 && r.quarters[88].ev_w < 11_040);
  assertAlmostEquals(r.quarters.at(-1)!.ev_kwh!, .8 * HOUSEHOLD.car.battery.capacity_kwh);
  assertEquals(r.commands.slice(89).every(command => command.ev_amps === 0), true);
});

Deno.test('sequential default projection matches complete native projection including thermostat stops', () => {
  const c = measured(realisticWorld());
  const p = forecastProblem(c, HOUSEHOLD, DEFAULT_SETTINGS, {});
  const r = projectDefaults(c, HOUSEHOLD, p, DEFAULT_SETTINGS, engine);
  const full = engine.project(r.problem, r.commands).outcome;
  assertEquals(full.kind, 'projected');
  if (full.kind !== 'projected') throw new Error(full.issue);
  for (let i = 0; i < r.quarters.length; i++) {
    for (const key of ['cost', 'pool_w', 'ev_w', 'charge_w', 'discharge_w', 'net_w', 'battery_kwh', 'ev_kwh', 'pool_c'] as const) {
      assertAlmostEquals(full.quarters[i][key]!, r.quarters[i][key]!, 1e-8);
    }
  }
});

Deno.test('default commands ignore forecasts and price changes but measured conditions price the electricity', () => {
  const c = measured(realisticWorld());
  const p = forecastProblem(c, HOUSEHOLD, DEFAULT_SETTINGS, {});
  const a = projectDefaults(c, HOUSEHOLD, p, DEFAULT_SETTINGS, engine);
  const altered = { ...c, solar_forecast_w: c.solar_forecast_w.map(v => v * 2), recorded: { ...c.recorded, prices: { ...c.recorded.prices, import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh.map(v => v + 1) } } };
  const b = projectDefaults(altered, HOUSEHOLD, forecastProblem(altered, HOUSEHOLD, DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS, engine);
  assertEquals(a.commands, b.commands);
  assert(electricityLedger(a.quarters, a.problem).costSek !== electricityLedger(b.quarters, b.problem).costSek);
});

Deno.test('bill ledger reconciles native quarter cash, respects signed prices and counts 60W once', () => {
  const c = measured(world({ load: () => 0, solar: () => 1000, buy: () => -1, sell: () => -.2, start: { pool_water_c: 40, battery_soc: 1, ev: { soc: .8 } } }));
  const r = projectDefaults(c, HOUSEHOLD, forecastProblem(c, HOUSEHOLD, DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS, engine);
  const ledger = electricityLedger(r.quarters, r.problem);
  assertAlmostEquals(ledger.costSek, r.quarters.reduce((sum, q) => sum + q.cost, 0));
  assert(ledger.exportRevenueSek < 0);
  assertEquals(r.problem.slots[0].base_w, 60);
  assertEquals(r.quarters[0].pool_auxiliary_w, 0);
  assertAlmostEquals(r.quarters[0].net_w, -940);
});

Deno.test('comparison evaluation requires recorded household data and keeps cash separate from wear and credit', async () => {
  assertThrows(() => forecastProblem(world(), HOUSEHOLD, { ...DEFAULT_SETTINGS, poolStartC: 31 }, {}));
  const c = measured(realisticWorld());
  const r = await compareScheduler(c, HOUSEHOLD, DEFAULT_SETTINGS, {}, engine);
  assertAlmostEquals(r.cashSavingSek, r.baseline.ledger.costSek - r.shs.ledger.costSek);
  assertAlmostEquals(r.adjustedSavingSek, r.cashSavingSek + r.shs.credit.credit_sek - r.baseline.credit.credit_sek);
  assertEquals(r.shs.series.solarW, c.recorded.actual!.solar_w);
  assertAlmostEquals(r.baseline.series.deviceW['sensor.pool_pump_energy'][0], 60 + r.baseline.quarters[0].pool_auxiliary_w);
  await assertRejectsMissing();
  async function assertRejectsMissing() {
    try { await compareScheduler(world(), HOUSEHOLD, DEFAULT_SETTINGS, {}, engine); }
    catch (error) { assert(String(error).includes('Recorded')); return; }
    throw new Error('Expected missing measurements to fail');
  }
});

Deno.test('case subscription uses the covered local month fraction and is never annualised', () => {
  const c = measured();
  assertAlmostEquals(subscriptionForCase(c.start, c.timezone, 72, 300), 30);
});

Deno.test('60W circulation alone costs 4.32 kWh over 72 hours with no double counting', () => {
  const h = { ...HOUSEHOLD, pool: { ...HOUSEHOLD.pool, store: { capacity_kwh_per_c: 1, loss: { kind: 'linear' as const, kw_per_c: 0, surroundings_c: 30 } } } };
  const c = measured(world({ load: () => 0, solar: () => 0, buy: () => 1, start: { pool_water_c: 31, battery_soc: 0, ev: { soc: .8 } } }));
  const r = projectDefaults(c, h, forecastProblem(c, h, DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS, engine);
  assertAlmostEquals(electricityLedger(r.quarters, r.problem).importKwh, 4.32);
  assertAlmostEquals(electricityLedger(r.quarters, r.problem).costSek, 4.32);
  assertEquals(r.quarters.every(q => q.pool_w === 0 && q.ev_w === 0), true);
});

Deno.test('readings above requested pool and car limits remain valid and are not forced down', () => {
  const c = measured(world({ start: { pool_water_c: 34, ev: { soc: .9 } } }));
  const r = projectDefaults(c, HOUSEHOLD, forecastProblem(c, HOUSEHOLD, DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS, engine);
  assertEquals(r.commands.every(command => command.ev_amps === 0), true);
  assertAlmostEquals(r.quarters.at(-1)!.ev_kwh!, .9 * HOUSEHOLD.car.battery.capacity_kwh);
  assertEquals(r.commands[0].pool_on, false);
});

Deno.test('local midnight and subscription handle the Stockholm daylight saving change and month boundary', () => {
  const c = { ...measured(world({ start: { ev: { soc: .79 } } })), start: '2026-10-24T10:00:00Z' };
  const r = projectDefaults(c, HOUSEHOLD, forecastProblem(c, HOUSEHOLD, DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS, engine);
  assertEquals(r.commands.slice(0, 48).every(command => command.ev_amps === 0), true);
  assertEquals(r.commands[48].ev_amps, HOUSEHOLD.car.charger.max_current_a);
  assertAlmostEquals(subscriptionForCase(c.start, c.timezone, 72, 300), 300 * 72 / 745);
  assertAlmostEquals(subscriptionForCase('2026-10-30T23:00:00Z', c.timezone, 72, 300), 300 * 24 / 745 + 300 * 48 / 720);
  assertAlmostEquals(subscriptionForCase('2026-03-27T23:00:00Z', c.timezone, 72, 300), 300 * 72 / 743);
});

Deno.test('identical native operation gives zero savings and independent state for both sides', async () => {
  const c = measured(realisticWorld());
  const settings = { ...DEFAULT_SETTINGS, batterySuppliesEv: HOUSEHOLD.site.ev_battery_supply_allowed };
  const defaults = projectDefaults(c, HOUSEHOLD, forecastProblem(c, HOUSEHOLD, settings, {}), settings, engine);
  const identical = { project: engine.project, solve: (p: Parameters<typeof engine.solve>[0]) => {
    const solved = engine.solve(p);
    if (solved.outcome.kind === 'selected') solved.outcome.selection.commands = defaults.commands;
    return solved;
  } };
  const r = await compareScheduler(c, HOUSEHOLD, settings, {}, identical);
  assertAlmostEquals(r.cashSavingSek, 0, 1e-8);
  assertAlmostEquals(r.adjustedSavingSek, 0, 1e-8);
  assertAlmostEquals(r.baseline.evEndSoc, r.shs.evEndSoc);
  assertAlmostEquals(r.baseline.batteryEndSoc, r.shs.batteryEndSoc);
  assertAlmostEquals(r.shs.ledger.costSek, r.shs.quarters.reduce((sum, q) => sum + q.cost, 0));
});

Deno.test('comparison identity changes with actual and forecast inputs without mutating the case', async () => {
  const c = measured(realisticWorld()), before = structuredClone(c);
  const a = await compareScheduler(c, HOUSEHOLD, DEFAULT_SETTINGS, {}, engine);
  const changed = structuredClone(c);
  changed.solar_forecast_w[0] += 1;
  const b = await compareScheduler(changed, HOUSEHOLD, DEFAULT_SETTINGS, {}, engine);
  changed.recorded.actual!.solar_w[0] += 1;
  const d = await compareScheduler(changed, HOUSEHOLD, DEFAULT_SETTINGS, {}, engine);
  assert(a.inputHash !== b.inputHash && b.inputHash !== d.inputHash);
  assertEquals(c, before);
});
