import { assertAlmostEquals, assertEquals } from '@std/assert';
import { planSeries } from './series.fixture.ts';
import { planStats, suiteStats } from './stats.ts';
import { CASE_SCALE, isStale, runScore, scoreQuarters, storedScore } from './score.ts';
import type { BenchSeries, BenchStats } from './types.ts';

const slot = (i: number, over: Record<string, unknown> = {}) => ({
  start: new Date(Date.UTC(2026, 8, 24, 0, i * 15)).toISOString(),
  duration_hours: 0.25,
  binding: i < 4,
  import_price_sek_per_kwh: i < 4 ? [1, 2, 3, 4][i] : null,
  export_price_sek_per_kwh: i < 4 ? 0.5 : null,
  shadow_import_sek_per_kwh: 2,
  shadow_export_sek_per_kwh: 0.5,
  pv_w: 0, load_w: 1000, pool_w: 0, boiler_expected_w: 0, ev_w: 0,
  ev_soc: null, ev_connected: true,
  battery_charge_w: 0, battery_discharge_w: 0, battery_export_w: 0, battery_soc: 0.5,
  grid_import_w: 1000, grid_export_w: 0,
  ...over,
});

Deno.test('planStats splits pool energy by price source and cheapness', () => {
  const slots = [0, 1, 2, 3, 4, 5].map(i => slot(i, { pool_w: i === 0 || i === 5 ? 4000 : 0, grid_import_w: 1000 + (i === 0 || i === 5 ? 4000 : 0) }));
  const s = planStats(planSeries(slots, null));
  assertAlmostEquals(s.pool_kwh, 2);
  assertAlmostEquals(s.pool_published_kwh, 1);
  assertAlmostEquals(s.pool_estimated_kwh, 1);
  assertAlmostEquals(s.pool_cheap_kwh, 1);
  assertAlmostEquals(s.pool_heating_hours, 0.5);
  assertEquals(s.pool_min_c, null);
});

Deno.test('planStats separates used and exported solar and flags unplugged charging', () => {
  const s = planStats(planSeries([
    slot(0, { pv_w: 4000, grid_import_w: 0, grid_export_w: 3000 }),
    slot(1, { ev_connected: false, ev_w: 2000 }),
  ], null));
  assertAlmostEquals(s.solar_kwh, 1);
  assertAlmostEquals(s.solar_exported_kwh, 0.75);
  assertAlmostEquals(s.solar_used_kwh, 0.25);
  assertAlmostEquals(s.export_revenue_sek, 0.375);
  assertEquals(s.ev_unplugged_quarters, 1);
  assertAlmostEquals(s.ev_unplugged_kwh, 0.5);
});

const stats = (over: Partial<BenchStats>): BenchStats => ({
  kwh_used: 50, grid_import_kwh: 40, grid_export_kwh: 0, grid_cost_sek: 60, export_revenue_sek: 0,
  pool_kwh: 20, pool_published_kwh: 20, pool_estimated_kwh: 0, pool_cheap_kwh: 10, pool_heating_hours: 5,
  pool_min_c: 29, pool_max_c: 31, pool_end_c: 30, battery_charge_kwh: 0, ev_kwh: 0,
  ev_unplugged_kwh: 0, ev_unplugged_quarters: 0, solar_kwh: 0, solar_used_kwh: 0, solar_exported_kwh: 0,
  import_price_paid: 1.4, import_price_mean: 2, ...over,
});

/** Eight quarters priced 1..8, the first four published, pool at 30 °C. */
/** A 288-quarter series with a pool and a car trajectory, both reachable from the start unless said otherwise. */
function comfortSeries(poolC: (i: number) => number, carKm: (i: number) => number, over: Partial<NonNullable<BenchSeries['comfort']>> = {}): BenchSeries {
  const n = 288;
  const series = planSeries(Array.from({ length: n }, (_, i) => slot(i)), null);
  series.poolC = Array.from({ length: n }, (_, i) => poolC(i));
  series.carKm = Array.from({ length: n }, (_, i) => carKm(i));
  series.comfort = {
    pool_target_c: 30, ev_target_km: 300, pool_start_c: 30, ev_start_km: 300,
    poolReachableC: new Array(n).fill(35), carReachableKm: new Array(n).fill(470), ...over,
  };
  return series;
}

Deno.test('comfort is scored from the target: a point per level missed, per store', () => {
  // On target: nothing fires.
  assertEquals(scoreQuarters(comfortSeries(() => 30, () => 300)).sum, 0);
  // Exactly 1 °C below and exactly 50 km short are still fine; just past them lose a point each.
  assertEquals(scoreQuarters(comfortSeries(() => 29, () => 250)).sum, 0);
  const slipping = scoreQuarters(comfortSeries(() => 28.9, () => 249));
  assertEquals(slipping.quarters[0], { score: -2, fired: ['pool_low', 'ev_low'] });
  // More than 2 °C below and more than 100 km short lose a second point each; a store never loses more than two.
  const far = scoreQuarters(comfortSeries(() => 27.9, () => 199));
  assertEquals(far.quarters[0], { score: -4, fired: ['pool_low', 'pool_cold', 'ev_low', 'ev_short'] });
  assertEquals(far.requiredFired, ['pool_cold', 'ev_short']);
  assertEquals(far.passed, false);
  // More than 2 °C above the target loses one; a car above its target loses nothing.
  assertEquals(scoreQuarters(comfortSeries(() => 32.1, () => 450)).quarters[0], { score: -1, fired: ['pool_hot'] });
});

Deno.test('a miss counts only once its level has been reachable for a day', () => {
  // A pool that starts at 24 °C and can first reach 29 °C in quarter 40: quarters before 40 + 96 are not held against the plan.
  const reachable = Array.from({ length: 288 }, (_, i) => 24 + i * 0.125);
  const cold = scoreQuarters(comfortSeries(() => 24, () => 300, { pool_start_c: 24, poolReachableC: reachable }));
  // 28 °C (two below target) was reachable at quarter 32, so that level is due from 128;
  // 29 °C (one below) at quarter 40, due from 136.
  assertEquals(cold.quarters[127].fired, []);
  assertEquals(cold.quarters[128].fired, ['pool_cold']);
  assertEquals(cold.quarters[135].fired, ['pool_cold']);
  assertEquals(cold.quarters[136].fired, ['pool_low', 'pool_cold']);
  // A level that was never reachable in the window never counts.
  const never = scoreQuarters(comfortSeries(() => 20, () => 300, { pool_start_c: 20, poolReachableC: new Array(288).fill(21) }));
  assertEquals(never.sum, 0);
});

Deno.test('rule overrides change thresholds, points and whether a rule runs', () => {
  const series = comfortSeries(() => 28.5, () => 300);
  assertEquals(scoreQuarters(series).quarters[0].fired, ['pool_low']);
  assertEquals(scoreQuarters(series, { pool_low: { threshold: 2 } }).quarters[0].fired, []);
  assertEquals(scoreQuarters(series, { pool_low: { enabled: false } }).sum, 0);
  assertEquals(scoreQuarters(series, { pool_low: { points: -2 } }).quarters[0].score, -2);
});

Deno.test('case points are the quarter sum scaled, and stored scores know when they are stale', () => {
  // A point lost in every quarter is the worst case score.
  const worst = scoreQuarters(comfortSeries(() => 28.5, () => 300));
  assertEquals(worst.sum, -288);
  assertAlmostEquals(worst.points, -288 / CASE_SCALE);
  assertAlmostEquals(worst.points, -10);
  const stored = storedScore(comfortSeries(() => 30, () => 300));
  assertEquals(stored.points, 0);
  assertEquals(isStale(stored), false);
  assertEquals(isStale(stored, { pool_low: { threshold: 2 } }), true);
  assertEquals(isStale({ ...stored, version: 1 }), true);
});

Deno.test('runScore is 1000 when no comfort was missed and 100 at the worst', () => {
  assertEquals(runScore([]), null);
  assertEquals(runScore([0, 0]), 1000);
  assertEquals(runScore([-10, -10]), 100);
  assertEquals(runScore([0, -2]), 910);
});

Deno.test('suiteStats sums totals and weights averages by energy', () => {
  const suite = suiteStats([stats({ grid_export_kwh: 2, export_revenue_sek: 1 }), stats({ pool_min_c: 28, grid_export_kwh: 0 })]);
  assertEquals(suite.cases, 2);
  assertEquals(suite.grid_cost_sek, 120);
  assertAlmostEquals(suite.cost_per_kwh!, 1.2);
  assertEquals(suite.pool_min_c, 28);
  assertEquals(suite.export_price, 0.5);
});
