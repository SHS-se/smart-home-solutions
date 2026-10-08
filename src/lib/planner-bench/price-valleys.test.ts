import { assert, assertEquals } from '@std/assert';
import { RULE_DEFAULTS } from '../../../supabase/functions/_shared/planner-wasm/rule-policy.ts';
import { scoreQuarters, valleyRanks, VALLEY_PRICE_STRETCH } from './score.ts';
import type { BenchSeries } from './types.ts';

/** Pool heating bought from the grid in every quarter, at the given prices. */
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

Deno.test('a cheap valley widens and closes its gaps within the price stretch; a spike and dearer quarters stay out', () => {
  // The cheapest quarter of twenty is five quarters, 1.00 to 1.04, so the valley reaches 1.04 × 1.2 = 1.248.
  const prices = [1.30, 1.10, 1.00, 1.06, 1.01, 1.02, 3.00, 1.03, 1.04, 1.24, 1.25, ...Array.from({ length: 9 }, (_, i) => 2 + i / 100)];
  assertEquals(VALLEY_PRICE_STRETCH, 1.2);
  const scores = scoreQuarters(series(prices), only('cheap_buy')).quarters.map(q => q.score);
  assertEquals(scores.slice(0, 11), [
    0, // 1.30 is beyond the stretch
    1, // 1.10 widens the valley at its start
    1,
    1, // 1.06 is a gap inside it
    1, 1,
    0, // the spike stays out and splits the valley
    1, 1,
    1, // 1.24 widens it at its end
    0, // 1.25 is beyond the stretch
  ]);
  assert(scores.slice(11).every(score => score === 0));
});

Deno.test('the dear shares stay exact: a dip between dear quarters is not counted with them', () => {
  // The dearest quarter of twenty is five quarters, 3.00 to 3.04; 2.99 sits between them.
  const prices = [3.00, 3.01, 2.99, 3.02, 3.03, 3.04, ...Array.from({ length: 14 }, (_, i) => 1 + i / 100)];
  const scores = scoreQuarters(series(prices), only('dear_load')).quarters.map(q => q.score);
  assertEquals(scores.slice(0, 6), [-1, -1, 0, -1, -1, -1]);
});

Deno.test('a valley counts from the share its cheapest quarter is in, and only where an unbroken run reaches it', () => {
  // A quarter within the stretch that no valley reaches gains nothing.
  assertEquals(valleyRanks([1.0, 5.0, 1.1, 5.0, 5.0, 5.0, 5.0, 5.0])[2], 0.125);
  // The very cheap share widens by the same factor.
  assertEquals(valleyRanks([1.0, 1.1, 1.15, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0]).slice(0, 4), [0, 0, 0, 0.3]);
  // Prices at or below zero stretch upwards too, and no rank ever rises.
  assertEquals(valleyRanks([-1.0, -0.9, 1.0, 1.0])[1], 0);
  const prices = [1.5, 1.1, 1.33, 1.02, 1.7, 1.26, 1.2];
  const exact = prices.map(price => prices.filter(other => other < price).length / prices.length);
  valleyRanks(prices).forEach((rank, i) => assert(rank <= exact[i]));
});
