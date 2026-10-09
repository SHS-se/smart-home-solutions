import { assertAlmostEquals, assertEquals } from '@std/assert';
import { countedChange, endCredit, endCreditTerms, referencePrice } from '../../../supabase/functions/_shared/planner-wasm/end-credit.ts';
import { evaluate } from './evaluate.ts';
import { HOUSEHOLD } from './household.ts';
import { evLimitKwh, poolLevels, referee } from './referee.ts';
import { TARGETS, plan, within, world } from './world.fixture.ts';
import type { BenchCase } from './case.ts';
import type { Decisions } from './referee.ts';

const level = poolLevels(HOUSEHOLD).at(-1)!;
const termsOf = (c: BenchCase) => endCreditTerms({
  battery: HOUSEHOLD.battery,
  pool: { store: HOUSEHOLD.pool.store, draw_w: level.draw_w, heat_w: level.heat_w, target_c: TARGETS.pool_c },
  car: { battery: HOUSEHOLD.car.battery, target_km: TARGETS.ev_km, limit_kwh: evLimitKwh(c, HOUSEHOLD) },
  import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh,
});
const record = (c: BenchCase, decisions: Decisions) => ({ decisions, beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh } });

Deno.test('a store counts up to its target and no further, in either direction', () => {
  // Below the cap all of a gain or a loss counts.
  assertEquals([countedChange(10, 14, 20), countedChange(14, 10, 20)], [4, -4]);
  // A gain stops counting at the cap, and energy above it is worth nothing on the way down either.
  assertEquals([countedChange(18, 25, 20), countedChange(25, 22, 20), countedChange(25, 20, 20)], [2, 0, 0]);
  // A store that started above its cap and ends below it loses only what lies under the cap.
  assertEquals(countedChange(25, 17, 20), -3);
});

Deno.test('the reference price is the upper median of the import prices, never below zero', () => {
  assertEquals(referencePrice([3, 1, 2, 4]), 3);
  assertEquals(referencePrice([1, 2, 3]), 2);
  assertEquals(referencePrice([-2, -1, -3]), 0);
  assertEquals(referencePrice([]), 0);
});

Deno.test('each store is credited as the grid electricity it takes to put the energy there', () => {
  const c = world({ buy: () => 2 }), terms = termsOf(c), h = HOUSEHOLD;
  assertEquals(terms.reference_sek_per_kwh, 2);
  // The home battery counts to full and converts like the car: what it takes to charge it.
  assertEquals(terms.battery, { cap: h.battery.max_soc * h.battery.capacity_kwh, grid_kwh_per_unit: 1 / h.battery.charge_efficiency });
  // The car counts to the range asked for, within its charge limit.
  assertEquals(terms.ev, { cap: Math.min(TARGETS.ev_km * h.car.battery.kwh_per_km, evLimitKwh(c, h)), grid_kwh_per_unit: 1 / h.car.battery.charge_efficiency });
  // A degree of pool water is its heat over what the heat pump gives per watt drawn, the pump included.
  assertEquals(terms.pool!.cap, TARGETS.pool_c);
  assertAlmostEquals(terms.pool!.grid_kwh_per_unit, h.pool.store.capacity_kwh_per_c * level.draw_w / level.heat_w, 1e-9);
  const credit = endCredit(terms, { battery_kwh: 9, pool_c: TARGETS.pool_c - 1, ev_kwh: 20 }, { battery_kwh: 12, pool_c: TARGETS.pool_c + 3, ev_kwh: 15 });
  assertAlmostEquals(credit.battery!.credit_sek, 3 / h.battery.charge_efficiency * 2, 1e-9);
  // The pool is credited for the degree up to its target, not the three above it.
  assertAlmostEquals(credit.pool!.credit_sek, terms.pool!.grid_kwh_per_unit * 2, 1e-9);
  // A car that ends below where it started is a debit.
  assertAlmostEquals(credit.ev!.credit_sek, -5 / h.car.battery.charge_efficiency * 2, 1e-9);
  assertAlmostEquals(credit.credit_sek, credit.battery!.credit_sek + credit.pool!.credit_sek + credit.ev!.credit_sek, 1e-9);
  // A household without a store has no term and no credit for it.
  const bare = endCreditTerms({ battery: null, pool: null, car: null, import_sek_per_kwh: [1] });
  assertEquals(endCredit(bare, { battery_kwh: null, pool_c: null, ev_kwh: null }, { battery_kwh: null, pool_c: null, ev_kwh: null }).credit_sek, 0);
});

Deno.test('the referee bills a plan: grid cost and discharge wear, less what it leaves in the stores', () => {
  const c = world({ buy: i => i < 96 ? 1 : 3, sell: () => 0.5, published: 288 });
  // Charge on the cheap day, supply the house on the dear ones.
  const d = plan({ charge: i => within(i, 0, 16) ? 4000 : 0, discharge: i => within(i, 96, 136) ? 500 : 0 });
  const { series, cost_sek } = referee(c, HOUSEHOLD, TARGETS, d);
  const bill = series.bill!;
  assertEquals(bill.grid_sek, cost_sek);
  const dischargedKwh = series.batteryDischargeW.reduce((sum, w) => sum + w, 0) / 4000;
  assertAlmostEquals(bill.wear_sek, dischargedKwh * HOUSEHOLD.site.battery_degradation_sek_per_kwh, 1e-3);
  assertAlmostEquals(series.wearSek!.reduce((sum, w) => sum + w, 0), bill.wear_sek, 1e-2);
  assertAlmostEquals(bill.net_sek, bill.grid_sek + bill.wear_sek - bill.credit.credit_sek, 1e-3);
  // The battery ends above its start, so it is credited at the median price of 3 kr.
  assertEquals(bill.credit.reference_sek_per_kwh, 3);
  assert(bill.credit.battery!.counted > 0 && bill.credit.battery!.credit_sek > 0);
  // The score is that bill and the deductions, a point a krona.
  const evaluated = evaluate(c, record(c, d), {});
  assertAlmostEquals(evaluated.score.points, evaluated.score.sum - bill.net_sek, 1e-3);
  // The same decisions with the battery left alone cost more on the dear days: fewer points.
  const idle = evaluate(c, record(c, plan()), {});
  assert(evaluated.score.points > idle.score.points, `${evaluated.score.points} ${idle.score.points}`);
});

Deno.test('energy above a target earns nothing: heating the pool past it only costs', () => {
  // The pool starts five degrees above its target and stays above it all three days.
  const c = world({ buy: () => 2, start: { pool_water_c: TARGETS.pool_c + 5 }, published: 288 });
  const noHeat = { pool_hot: { enabled: false } };
  const coasting = evaluate(c, record(c, plan()), noHeat);
  const heated = evaluate(c, record(c, plan({ pool: i => within(i, 270, 288) ? 3764 : 0 })), noHeat);
  assert(coasting.series.poolC.at(-1)! > TARGETS.pool_c && heated.series.poolC.at(-1)! > coasting.series.poolC.at(-1)!);
  // Neither the cooling above the target nor the extra heat is worth anything.
  assertEquals([coasting.series.bill!.credit.pool!.credit_sek, heated.series.bill!.credit.pool!.credit_sek], [0, 0]);
  assertAlmostEquals(coasting.score.points - heated.score.points, heated.series.bill!.grid_sek - coasting.series.bill!.grid_sek, 1e-3);
  assert(heated.score.points < coasting.score.points);
});

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}
