import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { QUARTERS, parseRecorded } from './case.ts';
import { HOUSEHOLD, TARGETS } from './household.ts';
import { referee, simulate, type Decisions } from './referee.ts';
import { plan, quarters, within, world } from './world.fixture.ts';

/** A dear evening (quarters 68 to 84 of each day) the battery is planned to carry, told 1 kW of load there. */
const told = () => world({ load: i => within(i % 96, 68, 84) ? 1000 : 0, buy: i => within(i % 96, 68, 84) ? 3 : 1, start: { battery_soc: 0.5 } });
/** The same window measured: the house drew `evening` W in those quarters, the panels gave `solar`. */
const measured = (evening: number, solar: (i: number) => number = () => 0) => {
  const c = told();
  c.recorded.actual = { base_load_w: quarters(i => within(i % 96, 68, 84) ? evening : 0), solar_w: quarters(solar) };
  return c;
};
/** Supplies the told evening load in full, on the first day only. */
const supplying = () => plan({ discharge: i => within(i, 68, 84) ? 1000 : 0 });
const kwh = (w: ArrayLike<number>) => Array.from(w).reduce((sum, v) => sum + v, 0) / 4000;

Deno.test('a window that was not measured is carried through what the planner was told', () => {
  const sim = simulate(told(), HOUSEHOLD, supplying());
  assertAlmostEquals(kwh(sim.dischargeW), 4);
  assertAlmostEquals(kwh(sim.netW), 8, 1e-6); // the two evenings the plan left to the grid
});

Deno.test('a battery supplying the whole house follows what the house really drew', () => {
  // Half the forecast: the battery gives half, and nothing is sold.
  const light = simulate(measured(500), HOUSEHOLD, supplying());
  assertAlmostEquals(kwh(light.dischargeW), 2);
  assert(Array.from(light.netW).every(w => w >= -1e-9));
  // Twice the forecast: the battery covers it while it lasts, then the grid does, at the evening's price.
  const heavy = simulate(measured(2000), HOUSEHOLD, supplying());
  const usable = (0.5 - HOUSEHOLD.battery.min_soc) * HOUSEHOLD.battery.capacity_kwh * HOUSEHOLD.battery.discharge_efficiency;
  assertAlmostEquals(kwh(heavy.dischargeW), usable, 1e-6);
  assertAlmostEquals(heavy.batteryKwh[QUARTERS - 1], HOUSEHOLD.battery.min_soc * HOUSEHOLD.battery.capacity_kwh, 1e-6);
  assertAlmostEquals(heavy.cost, (8 - usable) * 3 + 16 * 3, 1e-6);
});

Deno.test('running dry on a heavier day is a cost, not a violation', () => {
  const outcome = referee(measured(2000), HOUSEHOLD, TARGETS, supplying());
  assertEquals(outcome.violations, []);
  // The chart shows the house as it was.
  assertEquals(outcome.series.loadW[70], 2000);
  // Asking for more than the pack held in the told world still is one.
  const impossible = referee(measured(1000), HOUSEHOLD, TARGETS, plan({ discharge: i => within(i, 0, 96) ? 5000 : 0 }));
  assert(impossible.violations.some(v => v.kind === 'battery_empty'));
});

Deno.test('a part supply stays capped, and a grid charge stays as planned', () => {
  // The plan covers half the told evening: the limit is its own power, whatever the house draws.
  const part = simulate(measured(2000), HOUSEHOLD, plan({ discharge: i => within(i, 68, 84) ? 500 : 0 }));
  assertAlmostEquals(kwh(part.dischargeW), 2);
  // A grid charge in a quarter the house drew nothing in is unchanged by what the day did.
  const charging = plan({ charge: i => within(i, 0, 8) ? 2000 : 0 });
  assertAlmostEquals(kwh(simulate(measured(2000), HOUSEHOLD, charging).chargeW), 4);
});

Deno.test('a battery left to itself takes the surplus sun there really was', () => {
  // Nothing planned for the battery; the panels gave 3 kW for an hour nobody forecast.
  const sunny = simulate(measured(1000, i => within(i, 40, 44) ? 3000 : 0), HOUSEHOLD, plan());
  assertAlmostEquals(kwh(sunny.chargeW), 3);
  assert(Array.from(sunny.netW).slice(40, 44).every(w => Math.abs(w) < 1e-9));
});

Deno.test('the limits a plan states are the ones followed, until the decision is changed', () => {
  // The planner planned for 1.5 kW in the evening and said: supply the house, whatever it draws.
  const decisions: Decisions = plan({ discharge: i => within(i, 68, 84) ? 1500 : 0 });
  decisions.battery_follow = quarters(i => within(i, 68, 84)
    ? { follows: true, charge_limit_w: 8800, discharge_limit_w: 9600, planned: [0, 1500] as [number, number] }
    : { follows: true, charge_limit_w: 8800, discharge_limit_w: 0, planned: [0, 0] as [number, number] });
  // The house drew 1 kW: the battery gives 1 kW and sells nothing. Read from the decision alone, 1.5 kW against a told 1 kW would be a sale.
  const stated = simulate(measured(1000), HOUSEHOLD, decisions);
  assertAlmostEquals(kwh(stated.dischargeW), 4);
  const unstated = simulate(measured(1000), HOUSEHOLD, { ...decisions, battery_follow: undefined });
  assertAlmostEquals(kwh(unstated.dischargeW), 6);
  // An alternative that changes a quarter is read from its own decision there.
  const changed = { ...decisions, battery_discharge_w: decisions.battery_discharge_w.map((w, i) => i === 68 ? 0 : w) };
  assertEquals(simulate(measured(1000), HOUSEHOLD, changed).dischargeW[68], 0);
});

Deno.test('measured series and the days before a case are checked like the rest of it', () => {
  const recorded = measured(1000).recorded;
  assertEquals(parseRecorded({ ...recorded, history: { ...recorded.history, demand_days: [{ day: '2026-09-23', forecast_kwh: 20, actual_kwh: 25 }] } }).actual!.base_load_w.length, QUARTERS);
  let threw = 0;
  for (const bad of [
    { ...recorded, actual: { base_load_w: [1], solar_w: recorded.actual!.solar_w } },
    { ...recorded, history: { ...recorded.history, demand_days: [{ day: '2026-09-23', forecast_kwh: 'x', actual_kwh: 1 }] } },
  ]) { try { parseRecorded(bad); } catch { threw++; } }
  assertEquals(threw, 2);
});
