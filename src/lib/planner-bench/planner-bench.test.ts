import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { ReplayFormatError, stripReplay } from './strip.ts';
import { planSeries } from './series.ts';
import { planStats, suiteStats } from './stats.ts';
import { CASE_SCALE, isStale, runScore, scoreQuarters, storedScore } from './score.ts';
import type { BenchStats } from './types.ts';

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

Deno.test('stripReplay keeps only the planner arguments', () => {
  const replay = {
    format: 'shs-energy-optimisation-quarter-replay',
    input_hash: 'abc',
    entrypoint: { arguments: { snapshot: { captured_at: '2026-09-24T07:25:46Z', slots: [] }, now: '2026-09-24T07:25:57Z', price_archive: [] } },
    expected: { huge: true },
    history: [1, 2, 3],
  };
  const stripped = stripReplay(replay);
  assertEquals(Object.keys(stripped.input).sort(), ['now', 'price_archive', 'snapshot']);
  assertEquals(stripped.capturedAt, '2026-09-24T07:25:46.000Z');
  assertEquals(stripped.inputHash, 'abc');
  assertThrows(() => stripReplay({ format: 'something-else' }), ReplayFormatError);
  assertThrows(() => stripReplay({ format: replay.format, entrypoint: {} }), ReplayFormatError);
});

Deno.test('planSeries prices estimated quarters at the shadow price and reads pool state after each quarter', () => {
  const series = planSeries([slot(0), slot(4)], [29, 29.5, 29.25]);
  assertEquals(series.importPrice, [1, 2]);
  assertEquals(series.published, [1, 0]);
  assertEquals(series.poolC, [29.5, 29.25]);
  assertAlmostEquals(series.costSek[0], 0.25);
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
const quarterPlan = (over: (i: number) => Record<string, unknown> = () => ({})) =>
  planSeries(Array.from({ length: 8 }, (_, i) => slot(i, {
    binding: i < 4, import_price_sek_per_kwh: i < 4 ? i + 1 : null, shadow_import_sek_per_kwh: i + 1, ...over(i),
  })), [30, ...Array(8).fill(30)]);

Deno.test('quarters score the rules that fire, clamped to ±2', () => {
  // Pool heating in the cheapest quarter: cheap (+1) and very cheap (+1).
  const s = quarterPlan(i => (i === 0 ? { pool_w: 3000 } : {}));
  const scored = scoreQuarters(s);
  assertEquals(scored.quarters[0], { score: 2, fired: ['cheap_buy', 'cheapest_buy'] });
  assertEquals(scored.quarters[1].score, 0, 'an ordinary quarter scores nothing');
  assertEquals(scored.sum, 2);

  // Heating in the dearest, estimated quarter (rank 7/8: dear, not the dearest tenth) = -2.
  const dear = scoreQuarters(quarterPlan(i => (i === 7 ? { pool_w: 3000 } : {})));
  assertEquals(dear.quarters[7], { score: -2, fired: ['dear_buy', 'estimated_buy'] });
  // With the pool also cold the raw -4 is clamped to -2.
  const cold = quarterPlan(i => (i === 7 ? { pool_w: 3000 } : {}));
  cold.poolC[7] = 27;
  assertEquals(scoreQuarters(cold).quarters[7].score, -2);
});

Deno.test('a cold pool fails the case through a required rule', () => {
  const s = quarterPlan();
  s.poolC = s.poolC.map((t, i) => (i === 3 ? 27.5 : t));
  const scored = scoreQuarters(s);
  assertEquals(scored.quarters[3].fired, ['pool_cold', 'pool_low']);
  assertEquals(scored.quarters[3].score, -2);
  assertEquals(scored.requiredFired, ['pool_cold']);
  assertEquals(scored.passed, false);
  assertEquals(scoreQuarters(s, {}, 'pass').passed, true, 'your verdict overrides the automatic reading');
});

Deno.test('rule overrides change thresholds, points and whether a rule runs', () => {
  const s = quarterPlan(i => (i === 0 ? { pool_w: 3000 } : {}));
  assertEquals(scoreQuarters(s, { cheapest_buy: { enabled: false } }).quarters[0].score, 1);
  assertEquals(scoreQuarters(s, { cheap_buy: { points: -1 } }).quarters[0].score, 0);
  assertEquals(scoreQuarters(s, { cheap_buy: { threshold: 0 }, cheapest_buy: { threshold: 0 } }).quarters[0].score, 0);
});

Deno.test('case points are the quarter sum scaled and clamped, and stored scores know when they are stale', () => {
  const s = quarterPlan(i => ({ pool_w: i < 2 ? 3000 : 0 }));
  const scored = scoreQuarters(s);
  assertAlmostEquals(scored.points, scored.sum / CASE_SCALE);
  const stored = storedScore(s);
  assertEquals(stored.histogram['2'], 1);
  assertEquals(isStale(stored), false);
  assertEquals(isStale(stored, { cheap_buy: { points: 2 } }), true);
  assertEquals(isStale({ ...stored, version: stored.version - 1 }), true);
});

Deno.test('runScore maps the mean case score onto 100–1000', () => {
  assertEquals(runScore([]), null);
  assertEquals(runScore([-10, -10]), 100);
  assertEquals(runScore([0]), 550);
  assertEquals(runScore([10, 10]), 1000);
});

Deno.test('suiteStats sums totals and weights averages by energy', () => {
  const suite = suiteStats([stats({ grid_export_kwh: 2, export_revenue_sek: 1 }), stats({ pool_min_c: 28, grid_export_kwh: 0 })]);
  assertEquals(suite.cases, 2);
  assertEquals(suite.grid_cost_sek, 120);
  assertAlmostEquals(suite.cost_per_kwh!, 1.2);
  assertEquals(suite.pool_min_c, 28);
  assertEquals(suite.export_price, 0.5);
});
