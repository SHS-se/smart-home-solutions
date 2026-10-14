import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { QUARTERS } from './case.ts';
import { HOUSEHOLD } from './household.ts';
import { referee, simulate, type Decisions, type HotWaterCommand } from './referee.ts';
import { scoreQuarters } from './score.ts';
import { TARGETS, plan, quarters, world } from './world.fixture.ts';

const KEY = HOUSEHOLD.hot_water.key;
const NEED_W = 400;
/** A measured window whose 1 kW base load includes a water heater drawing 400 W, forecast alike. */
const measured = () => {
  const c = world({ load: () => 1_000 });
  c.other_devices_w = { [KEY]: quarters(() => NEED_W) };
  c.recorded.actual = { base_load_w: quarters(() => 1_000), solar_w: quarters(() => 0), other_devices_w: { [KEY]: quarters(() => NEED_W) } };
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

Deno.test('a gate the house is above holds the heater off', () => {
  // 600 W of the rest of the house, and the heater's own 1.27 kW once it runs, are above the 1 kW the gate stops at.
  const sim = simulate(measured(), HOUSEHOLD, commanding(() => ({ kind: 'gate', allow_below_w: 500, inhibit_above_w: 1_000 })));
  assertEquals(Array.from(sim.water!.permitted), quarters(() => 0));
  // Below the lower level it may start, and between the two it keeps what it was doing.
  const open = simulate(measured(), HOUSEHOLD, commanding(() => ({ kind: 'gate', allow_below_w: 700, inhibit_above_w: 2_000 })));
  assertEquals(Array.from(open.water!.permitted), quarters(() => 1));
});

Deno.test('a tank left behind runs cold, and what it is owed at the end is billed', () => {
  const outcome = referee(measured(), HOUSEHOLD, TARGETS, commanding(() => ({ kind: 'inhibit' })));
  const owed = QUARTERS * NEED_W / 4_000;
  assertAlmostEquals(outcome.series.hotWater!.owedKwh[QUARTERS - 1], owed);
  const bill = outcome.series.bill!;
  assertAlmostEquals(bill.hot_water!.owed_sek, owed * bill.credit.reference_sek_per_kwh, 1e-3);
  assertAlmostEquals(bill.net_sek, bill.grid_sek + bill.wear_sek - bill.credit.credit_sek + bill.hot_water!.owed_sek, 1e-3);
  // 3 kWh is 30 quarters of 400 W: from the 31st the water is cold.
  const scored = scoreQuarters(outcome.series, {});
  assertEquals(scored.counts.water_cold, QUARTERS - 30);
  assertEquals(outcome.series.hotWater!.command[0], 'inhibit');
});

Deno.test('in the world the planner was told the heater runs as the plan expected', () => {
  const told = simulate(measured(), HOUSEHOLD, { ...commanding(() => ({ kind: 'gate', allow_below_w: 500, inhibit_above_w: 1_000 })),
    hot_water_expected_w: quarters(() => NEED_W) }, 'told');
  assertEquals(Array.from(told.water!.w), quarters(() => NEED_W));
});
