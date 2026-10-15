import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { QUARTERS } from './case.ts';
import { HOUSEHOLD } from './household.ts';
import { referee, simulate, type Decisions, type HotWaterCommand } from './referee.ts';
import { scoreQuarters } from './score.ts';
import { TARGETS, plan, quarters, world } from './world.fixture.ts';

const KEYS = HOUSEHOLD.hot_water.meter_keys;
const boiler = (watts: number) => Object.fromEntries(KEYS.map((key, i) => [key, quarters(() => i === 0 ? watts : 0)]));
const NEED_W = 400;
/** A measured window whose 1 kW base load includes a water heater drawing 400 W, forecast alike. */
const measured = () => {
  const c = world({ load: () => 1_000 });
  c.other_devices_w = boiler(NEED_W);
  c.recorded.actual = { base_load_w: quarters(() => 1_000), solar_w: quarters(() => 0), other_devices_w: boiler(NEED_W) };
  return c;
};
const commanding = (command: (i: number) => HotWaterCommand): Decisions => ({ ...plan(), hot_water: quarters(command) });
const kwh = (w: ArrayLike<number>) => Array.from(w).reduce((sum, v) => sum + v, 0) / 4000;

Deno.test('a heater the plan leaves free runs as the house drew it, and costs what it did', () => {
  const c = measured();
  const free = simulate(c, HOUSEHOLD, plan());
  const without = simulate({ ...c, recorded: { ...c.recorded, actual: { ...c.recorded.actual!, other_devices_w: undefined } } }, HOUSEHOLD, plan());
  assertEquals(free.cost, without.cost);
  assertEquals(Array.from(free.water!.w), quarters(() => NEED_W));
  assert(Array.from(free.water!.owedKwh).every(owed => owed === 0));
  assertEquals(without.water, null);
});

Deno.test('held-off heating is owed to the tank and made up at rated power, energy for energy', () => {
  const sim = simulate(measured(), HOUSEHOLD, commanding(i => i < 8 ? { kind: 'inhibit' } : { kind: 'free' }));
  assertAlmostEquals(sim.water!.owedKwh[7], 8 * NEED_W / 4_000);
  // The first quarter allowed again heats at the heater's rated power.
  assertAlmostEquals(sim.water!.w[8], HOUSEHOLD.hot_water.rated_w);
  assertEquals(sim.water!.owedKwh[QUARTERS - 1], 0);
  assertAlmostEquals(kwh(sim.water!.w), QUARTERS * NEED_W / 4_000, 1e-9);
});

Deno.test('a boiler left blocked misses daily permissions, and outstanding energy is billed separately', () => {
  const outcome = referee(measured(), HOUSEHOLD, TARGETS, commanding(() => ({ kind: 'inhibit' })));
  const owed = QUARTERS * NEED_W / 4_000;
  assertAlmostEquals(outcome.series.hotWater!.owedKwh[QUARTERS - 1], owed);
  const bill = outcome.series.bill!;
  assertAlmostEquals(bill.hot_water!.owed_sek, owed * bill.credit.reference_sek_per_kwh, 1e-3);
  assertAlmostEquals(bill.net_sek, bill.grid_sek + bill.wear_sek - bill.credit.credit_sek + bill.hot_water!.owed_sek, 1e-3);
  // This window touches four Stockholm dates: ten missing opportunities each.
  const scored = scoreQuarters(outcome.series, {});
  assertEquals(scored.counts.water_opportunities, 40);
  assertEquals(outcome.series.hotWater!.command[0], 'inhibit');
});

Deno.test('in the world the planner was told the heater runs as the plan expected', () => {
  const told = simulate(measured(), HOUSEHOLD, { ...commanding(() => ({ kind: 'permit' })),
    hot_water_expected_w: quarters(() => NEED_W) }, 'told');
  assertEquals(Array.from(told.water!.w), quarters(() => NEED_W));
});

Deno.test('boiler permission never shifts heat-pump preheating or mixed hot-water totals', () => {
  const c = measured();
  c.base_load_forecast_w = quarters(() => 2274);
  c.recorded.actual!.base_load_w = quarters(() => 2274);
  c.other_devices_w['sensor.hot_water_energy'] = quarters(() => 1674);
  c.recorded.actual!.other_devices_w!['sensor.hot_water_energy'] = quarters(() => 1674);
  const blocked = simulate(c, HOUSEHOLD, commanding(() => ({ kind: 'inhibit' })));
  assertEquals(Array.from(blocked.water!.w), quarters(() => 0));
  // 600 W other appliances plus 1274 W autonomous compressor remain.
  assertEquals(Array.from(blocked.baseW), quarters(() => 1874));
  assertEquals(HOUSEHOLD.hot_water.rated_w, 3000);
});

Deno.test('scheduled boiler energy replaces its inclusive base load once, including catch-up heating', () => {
  const c = measured();
  const inclusiveW = 2274; // 600 W appliances + 1274 W autonomous preheat + 400 W boiler.
  c.base_load_forecast_w = quarters(() => inclusiveW);
  c.recorded.actual!.base_load_w = quarters(() => inclusiveW);
  const result = referee(c, HOUSEHOLD, TARGETS, commanding(i => i < 8 ? { kind: 'inhibit' } : { kind: 'permit' }));
  const s = result.series;
  assertEquals(s.hotWaterW[0], 0);
  assertEquals(s.hotWaterW[8], HOUSEHOLD.hot_water.rated_w);
  for (let i = 0; i < QUARTERS; i++) {
    assertAlmostEquals(s.loadW[i] - s.poolW[i] - s.carW[i] - s.hotWaterW[i], inclusiveW - NEED_W, 1e-3);
  }
  assertAlmostEquals(kwh(s.hotWaterW) + s.hotWater!.owedKwh.at(-1)!, QUARTERS * NEED_W / 4000, 1e-3);
});

Deno.test('permission without boiler meters leaves load intact and water assessment unavailable', () => {
  const c = measured();
  c.other_devices_w = { 'sensor.hot_water_energy': quarters(() => 400) };
  c.recorded.actual!.other_devices_w = c.other_devices_w;
  const result = referee(c, HOUSEHOLD, TARGETS, commanding(() => ({ kind: 'inhibit' })));
  assertEquals(result.series.hotWater!.demandKnown, false);
  assertEquals(result.series.loadW, quarters(() => 1000));
  assertEquals(result.series.bill!.hot_water, undefined);
  // Permissions are assessable even though consumption is not.
  assertEquals(scoreQuarters(result.series, {}).applicability.water_opportunities.applicable, true);
  assertEquals(scoreQuarters(result.series, {}).counts.water_opportunities, 40);
});
