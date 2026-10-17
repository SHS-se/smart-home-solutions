import { assert, assertAlmostEquals } from '@std/assert';
import { HOUSEHOLD } from './household.ts';
import { findOpportunities } from './opportunities.ts';
import { referee, simulate } from './referee.ts';
import { plan, TARGETS, world } from './world.fixture.ts';
import { poolInventoryC } from '../../../supabase/functions/_shared/planner/device-models.ts';

Deno.test('referee retains delayed heat after a short run and credits heat still in transit at the horizon', () => {
  const household = structuredClone(HOUSEHOLD);
  household.pool.store = { capacity_kwh_per_c: 10, response_time_constant_h: 2,
    loss: { kind: 'linear', kw_per_c: 0, surroundings_c: 20 } };
  household.pool.heater.response = { kind: 'steady' };
  const c = world({ start: { pool_water_c: 25 } });
  const draw = 3764, heatKwh = 12450 * .25 / 1000;
  const early = simulate(c, household, plan({ pool: i => i === 0 ? draw : 0 }));
  assert(early.poolPendingHeatKwh[0] > heatKwh * .9);
  assert(early.poolC[1] > early.poolC[0]);
  assert(early.poolPendingHeatKwh[1] < early.poolPendingHeatKwh[0]);
  assertAlmostEquals(poolInventoryC(household.pool.store, early.poolC[1], early.poolPendingHeatKwh[1]), 25 + heatKwh / 10);
  const late = referee(c, household, TARGETS, plan({ pool: i => i === 287 ? draw : 0 }));
  assertAlmostEquals(late.series.bill!.credit.pool!.counted, heatKwh / 10, 1e-4);
  assert(late.series.poolPendingHeatKwh.at(-1)! > heatKwh * .9);
  assertAlmostEquals(late.terminal.credit_sek, draw * .25 / 1000, 1e-4);
});

Deno.test('opportunity audit cannot save money by discarding heat awaiting the water response', () => {
  const household = structuredClone(HOUSEHOLD);
  household.pool.store = { capacity_kwh_per_c: 10, response_time_constant_h: 24,
    loss: { kind: 'linear', kw_per_c: 0, surroundings_c: 20 } };
  household.pool.heater.response = { kind: 'steady' };
  const c = world({ start: { pool_water_c: 25 }, published: 288, buy: i => i >= 280 ? 3 : 1 });
  const commands = plan({ pool: i => i >= 280 ? 3764 : 0 });
  const before = simulate(c, household, commands);
  const { improved } = findOpportunities(c, household, TARGETS, commands, 'told/nominal');
  const after = simulate(c, household, improved);
  assert(poolInventoryC(household.pool.store, after.poolC[287], after.poolPendingHeatKwh[287])
    >= poolInventoryC(household.pool.store, before.poolC[287], before.poolPendingHeatKwh[287]) - 1e-9);
});
