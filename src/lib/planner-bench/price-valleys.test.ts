import { assert, assertEquals } from '@std/assert';
import { RULE_DEFAULTS } from '../../../supabase/functions/_shared/planner-wasm/rule-policy.ts';
import { bridgedRanks, PRICE_BRIDGE_STRETCH, scoreQuarters } from './score.ts';
import type { BenchSeries } from './types.ts';

/** Twenty quarters of pool heating bought from the grid, at the given prices. */
function series(prices: number[]): BenchSeries {
  const each = <T>(value: T) => prices.map(() => value);
  return {
    devices: [], deviceW: {},
    start: prices.map((_, i) => new Date(Date.UTC(2026, 9, 5) + i * 900_000).toISOString()), hours: each(0.25), published: each(1),
    importPrice: prices, exportPrice: each(0), solarW: each(0), loadW: each(1500),
    poolW: each(1000), hotWaterW: each(0), carW: each(0), gridImportW: each(1500), gridExportW: each(0),
    batteryChargeW: each(0), batteryDischargeW: each(0), baseLoadBatteryCoverW: each(0), homeSoc: each(100), homeStartSoc: 100,
    carSoc: each(80), carKm: each(300), carConnected: each(1), poolC: each(30), costSek: each(0),
    comfort: { pool_target_c: 30, ev_target_km: 300, pool_start_c: 30, ev_start_km: 300,
      poolReachableC: each(35), carReachableKm: each(470) },
  };
}
const only = (key: string) => Object.fromEntries(Object.keys(RULE_DEFAULTS).filter(k => k !== key).map(k => [k, { enabled: false }]));

Deno.test('a quarter a hair over the cheap share inside a valley counts; a spike and the valley edge do not', () => {
  // The cheapest quarter of twenty is five quarters: 1.00 to 1.04.
  const prices = [1.00, 1.06, 1.01, 1.02, 3.00, 1.03, 1.04, 1.07, ...Array.from({ length: 12 }, (_, i) => 2 + i / 100)];
  const scores = scoreQuarters(series(prices), only('cheap_buy')).quarters.map(q => q.score);
  assertEquals(scores.slice(0, 8), [
    1,
    1, // 1.06 is sixth cheapest, between two cheap quarters
    1, 1,
    0, // the spike stays out
    1, 1,
    0, // 1.07 ends the valley: nothing cheap beyond it
  ]);
  assert(scores.slice(8).every(score => score === 0));
});

Deno.test('a gap closes only while every quarter in it is within the stretched share, at either end of the prices', () => {
  // Bridged: 0.30 < 0.25 × 1.5. Not bridged at 25 %: 0.40.
  assert(bridgedRanks([0.2, 0.3, 0.2])[1] < 0.25);
  assert(bridgedRanks([0.2, 0.4, 0.2])[1] >= 0.25);
  // A long gap closes as one; one quarter beyond the stretch keeps both sides apart.
  assert(bridgedRanks([0.24, 0.3, 0.36, 0.3, 0.24]).every(rank => rank < 0.25));
  const apart = bridgedRanks([0.2, 0.3, 0.9, 0.3, 0.2]);
  assertEquals([apart[1], apart[3]], [0.3, 0.3]);
  // The very cheap share stretches by the same factor, and no rank ever rises.
  assert(bridgedRanks([0.05, 0.14, 0.05])[1] < 0.1);
  assertEquals(bridgedRanks([0.05, 0.16, 0.05])[1], 0.16 / PRICE_BRIDGE_STRETCH);
  const ranks = [0.5, 0.1, 0.33, 0.02, 0.7, 0.26, 0.2];
  bridgedRanks(ranks).forEach((rank, i) => assert(rank <= ranks[i]));
});
