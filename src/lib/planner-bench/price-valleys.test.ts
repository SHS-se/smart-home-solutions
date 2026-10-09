import { assert, assertEquals } from '@std/assert';
import { RULE_DEFAULTS } from '../../../supabase/functions/_shared/planner-wasm/rule-policy.ts';
import { PRICE_BRIDGE_MIN_QUARTERS, PRICE_BRIDGE_STRETCH, measuredQuarters as scoreQuarters, stretchedValleys } from './score.ts';
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

Deno.test('a valley of eight cheap quarters stretches from 25 % to 32.5 %; a shorter one does not', () => {
  assertEquals([PRICE_BRIDGE_STRETCH, PRICE_BRIDGE_MIN_QUARTERS], [1.3, 8]);
  // Forty quarters: the cheapest quarter of them is the ten priced 1.00 to 1.09; the stretch reaches the next three, 1.10 to 1.12.
  const prices = Array.from({ length: 40 }, (_, i) => 2 + i / 100);
  // Eight cheap quarters stretch through 1.10 before them, 1.11 after them and the cheap quarter beyond it.
  prices.splice(2, 11, 1.10, 1.00, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.11, 1.08);
  // A single cheap quarter is no valley: the 1.12 beside it gains nothing.
  prices.splice(20, 2, 1.12, 1.09);
  const scores = scoreQuarters(series(prices), only('cheap_buy')).quarters.map(q => q.score);
  assertEquals(scores.slice(0, 14), [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  assertEquals(scores.slice(19, 23), [0, 0, 1, 0]);
});

Deno.test('the very cheap share never stretches, and its two points need a kilowatt', () => {
  const prices = Array.from({ length: 40 }, (_, i) => 2 + i / 100);
  // The cheapest tenth is four quarters, 1.00 to 1.03; 1.04 sits between them in a valley of eight cheap quarters.
  prices.splice(0, 8, 1.00, 1.01, 1.04, 1.02, 1.03, 1.05, 1.06, 1.07);
  const s = series(prices);
  const both = Object.fromEntries(Object.keys(RULE_DEFAULTS).filter(k => k !== 'cheap_buy' && k !== 'cheapest_buy').map(k => [k, { enabled: false }]));
  assertEquals(scoreQuarters(s, both).quarters.slice(0, 8).map(q => q.score), [2, 2, 1, 2, 2, 1, 1, 1]);
  // At 999 W a very cheap quarter gains the cheap point only; at 1 kW it gains two; below 500 W nothing.
  for (const [watts, score] of [[999, 1], [1000, 2], [499, 0]]) {
    s.poolW = s.poolW.map(() => watts);
    assertEquals(scoreQuarters(s, both).quarters[0].score, score, `${watts} W`);
  }
});

Deno.test('the dear shares stay exact: a dip between dear quarters is not counted with them', () => {
  // The dearest quarter of twenty is five quarters, 3.00 to 3.04; 2.99 sits between them.
  const prices = [3.00, 3.01, 2.99, 3.02, 3.03, 3.04, ...Array.from({ length: 14 }, (_, i) => 1 + i / 100)];
  const scores = scoreQuarters(series(prices), only('dear_load')).quarters.map(q => q.score);
  assertEquals(scores.slice(0, 6), [-1, -1, 0, -1, -1, -1]);
});

Deno.test('only eight consecutive quarters in the share make a valley, and the stretch stops at its limit', () => {
  const rank = new Array<number>(50).fill(0.9);
  // Seven in the share are no valley, however many lie within reach.
  rank.splice(2, 11, 0.3, 0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3, 0.3);
  // Neither are eight split by a quarter out of the share.
  rank.splice(15, 9, 0.1, 0.1, 0.1, 0.1, 0.3, 0.1, 0.1, 0.1, 0.1);
  // Eight make one, and the stretch stops at 32.5 % exactly.
  rank.splice(40, 10, 0.325, 0.32, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2);
  const valley = stretchedValleys(rank, 0.25);
  assertEquals(valley.flatMap((counts, i) => counts ? [i] : []), [41, 42, 43, 44, 45, 46, 47, 48, 49]);
});
