import { assertEquals } from '@std/assert';
import { evaluate } from './evaluate.ts';
import { scoreQuarters, type QuarterScore } from './score.ts';
import type { BenchSeries, PlanRecord } from './types.ts';
import { plan, TARGETS, world } from './world.fixture.ts';

function series(): BenchSeries {
  return {
    start: ['2026-10-05T00:00:00Z'], hours: [0.25], published: [1],
    importPrice: [0.9999], exportPrice: [0], solarW: [0], loadW: [500],
    poolW: [0], hotWaterW: [0], carW: [0], gridImportW: [500], gridExportW: [0],
    batteryChargeW: [0], batteryDischargeW: [0], homeSoc: [100], homeStartSoc: 100,
    carSoc: [80], carKm: [300], carConnected: [1], poolC: [30], costSek: [0],
    comfort: { pool_target_c: 30, ev_target_km: 300, pool_start_c: 30, ev_start_km: 300,
      poolReachableC: [35], carReachableKm: [470] },
  };
}

const onlyMissedCheap = { cheap_buy: { enabled: false }, cheapest_buy: { enabled: false },
  dear_load: { enabled: false }, dearest_load: { enabled: false } };
const missed: QuarterScore = { score: -1, fired: ['missed_cheap_quarter'] };
const taken: QuarterScore = { score: 0, fired: [] };

Deno.test('each flexible store below its exact target must take at least 500 W in a cheap quarter', () => {
  for (const [state, watts, below, target] of [
    ['homeSoc', 'batteryChargeW', 99.9, 100],
    ['carKm', 'carW', 299.9, 300],
    ['poolC', 'poolW', 29.999, 30],
  ] as const) {
    const s = series();
    s[state][0] = below;
    for (const power of [0, 499.9, 500]) {
      s[watts][0] = power;
      assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], power < 500 ? missed : taken, `${state}: ${power} W`);
    }
    s[watts][0] = 0;
    for (const level of [target, target + 1]) {
      s[state][0] = level;
      assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], taken);
    }
  }
});

Deno.test('one below-target device taking 500 W avoids the single penalty; unrelated or combined small draws do not', () => {
  const s = series();
  s.homeSoc[0] = 50; s.carKm![0] = 299; s.poolC[0] = 29.5;
  assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], missed);
  s.poolW[0] = 300; s.carW[0] = 300;
  assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], missed);
  s.carW[0] = 500;
  assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], taken);
  s.carKm![0] = 300;
  s.hotWaterW[0] = 2000; s.loadW[0] = 5000; s.batteryDischargeW[0] = 1000;
  assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], missed);
  s.batteryChargeW[0] = 500;
  assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], taken);
});

Deno.test('the cheap price boundary is strict, zero and negative prices count, and rule settings apply', () => {
  const s = series(); s.homeSoc[0] = 50;
  for (const price of [-1, 0, 0.9999, 1, 1.0001]) {
    s.importPrice[0] = price;
    assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], price < 1 ? missed : taken);
  }
  s.importPrice[0] = 0.9;
  assertEquals(scoreQuarters(s, { ...onlyMissedCheap, missed_cheap_quarter: { enabled: false } }).sum, 0);
  assertEquals(scoreQuarters(s, { ...onlyMissedCheap, missed_cheap_quarter: { threshold: 0.9 } }).sum, 0);
  assertEquals(scoreQuarters(s, { ...onlyMissedCheap, missed_cheap_quarter: { points: -2 } }).sum, -2);
  s.homeSoc[0] = null; s.poolC[0] = null; delete s.carKm;
  assertEquals(scoreQuarters(s, onlyMissedCheap).quarters[0], taken);
});

Deno.test('isolated first and unpublished cheap quarters are stored and displayed with the same penalty', () => {
  const c = world({ buy: i => i === 0 || i === 200 ? 0.9 : 1, start: { battery_soc: 0.5, pool_water_c: TARGETS.pool_c,
    ev: { soc: 0.7 } } });
  const record: PlanRecord = {
    status: 'ready', generation: 'test', valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' },
    decisions: plan(), beliefs: { import_sek_per_kwh: [], grid_cost_sek: null }, curves: [],
  };
  const evaluated = evaluate(c, record, {});
  const live = scoreQuarters(evaluated.series);
  assertEquals(live.quarters.flatMap((q, i) => q.fired.includes('missed_cheap_quarter') ? [i] : []), [0, 200]);
  assertEquals(evaluated.score.counts.missed_cheap_quarter, 2);
  assertEquals(evaluated.score.points, live.points);
});
