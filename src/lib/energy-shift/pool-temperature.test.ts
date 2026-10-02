import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { plannedPoolTarget, plannedPoolTemperature, type PoolPlanSlot } from './pool-temperature.ts';

const idle: PoolPlanSlot = { decision: { store_allocations: [] } };
const heat = (before: number, after: number): PoolPlanSlot =>
  ({ decision: { store_allocations: [{ store_key: 'battery', state_before: 1, state_after: 2 }, { store_key: 'pool', state_before: before, state_after: after }] } });

Deno.test('a planned pool cools between runs, warms through them and ends where the plan says', () => {
  // Two idle quarters from 30, a run from 29.8 to 30.0, then two idle quarters to 29.6.
  const temps = plannedPoolTemperature([idle, idle, heat(29.8, 29.9), heat(29.9, 30.0), idle, idle], 30, 29.6);
  [29.9, 29.8, 29.9, 30.0, 29.8, 29.6].forEach((expected, i) => assertAlmostEquals(temps[i]!, expected, 1e-9));
});

Deno.test('a plan that never heats is the line from where the pool is to where it ends', () => {
  const temps = plannedPoolTemperature([idle, idle, idle, idle], 30, 29.6);
  [29.9, 29.8, 29.7, 29.6].forEach((expected, i) => assertAlmostEquals(temps[i]!, expected, 1e-9));
});

Deno.test('without a pool there is no projection, and without an end the tail is left open', () => {
  assertEquals(plannedPoolTemperature([idle, idle], null, 29), [null, null]);
  assertEquals(plannedPoolTemperature([heat(29, 29.1), idle], 29, null), [29.1, null]);
});

Deno.test('the target is read only from a plan made from one', () => {
  assertEquals(plannedPoolTarget({ pool: { stop_temperature_c: 32 }, resolved_value_stores: [{ key: 'pool', derivation: { method: 'merit_order' } }] }), 30);
  assertEquals(plannedPoolTarget({ pool: { stop_temperature_c: 32 }, resolved_value_stores: [{ key: 'pool' }] }), null);
  assertEquals(plannedPoolTarget({ pool: null }), null);
});
