import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { OPPORTUNITY_AUDIT_VERSION, OPPORTUNITY_RULES, type OpportunityAudit } from './opportunities.ts';
import { planSeries } from './series.fixture.ts';
import { DEFAULT_SERVICE_GUARD } from './service.ts';
import { planStats, STATS_VERSION, suiteStats } from './stats.ts';
import {
  CriteriaError,
  criteriaErrors, criteriaFingerprint, distinctScoreRuns, isStale, resolveRules, runScore, scoreQuarters, serviceGuard,
  storedPassed, storedScore, type StoredScore,
} from './score.ts';
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
  // The pool's kWh at the import price of its own quarters (1 and 2 kr), not at the house's average.
  assertAlmostEquals(s.pool_cost_sek, 3);
  assertAlmostEquals(s.grid_import_sek, 6.5);
  assertAlmostEquals(s.import_price_paid!, 6.5 / 3.5);
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
  assertAlmostEquals(s.solar_export_revenue_sek, 0.375);
  assertEquals(s.ev_unplugged_quarters, 1);
  assertAlmostEquals(s.ev_unplugged_kwh, 0.5);
});

Deno.test('planStats keeps battery wear apart from what the grid charged, and counts only solar as solar export', () => {
  // The battery sells 2 kW on top of 1 kW of surplus sun: 3 kW leaves, 1 kW of it solar.
  const series = planSeries([
    slot(0, { pv_w: 2000, battery_discharge_w: 2000, grid_import_w: 0, grid_export_w: 3000 }),
    slot(1),
  ], null);
  series.wearSek = [0.025, 0];
  const s = planStats(series);
  assertAlmostEquals(s.battery_discharge_kwh, 0.5);
  assertAlmostEquals(s.battery_wear_sek, 0.025);
  assertAlmostEquals(s.export_revenue_sek, 0.375);
  // The sun covers the house's 1 kW first; only its surplus kW is solar export, the rest the battery's sale.
  assertAlmostEquals(s.solar_base_kwh, 0.25);
  assertAlmostEquals(s.solar_exported_kwh, 0.25);
  assertAlmostEquals(s.solar_export_revenue_sek, 0.125);
  assertAlmostEquals(s.grid_import_sek, 0.5);
});

Deno.test('planStats says where the solar went: base load, pool and car in proportion, battery, then export', () => {
  const split = (over: Record<string, unknown>) => planStats(planSeries([slot(0, { grid_import_w: 0, ...over })], null));
  const parts = (s: BenchStats) => [s.solar_base_kwh, s.solar_pool_kwh, s.solar_ev_kwh, s.solar_battery_kwh, s.solar_exported_kwh].map(v => Math.round(v * 1000) / 1000);
  // Plenty of sun: every load is covered, the battery charges and the rest leaves.
  const plenty = split({ pv_w: 12_000, load_w: 7000, pool_w: 4000, ev_w: 2000, battery_charge_w: 3000, grid_export_w: 2000 });
  assertEquals(parts(plenty), [0.25, 1, 0.5, 0.75, 0.5]);
  assertAlmostEquals(plenty.solar_used_kwh, 2.5);
  // Short of sun: base load is covered, pool and car share what is left 2:1, and the battery charges from the grid.
  const short = split({ pv_w: 4000, load_w: 7000, pool_w: 4000, ev_w: 2000, battery_charge_w: 3000, grid_import_w: 6000 });
  assertEquals(parts(short), [0.25, 0.5, 0.25, 0, 0]);
  for (const s of [plenty, short]) assertAlmostEquals(parts(s).reduce((a, b) => a + b, 0), s.solar_kwh);
});

const stats = (over: Partial<BenchStats>): BenchStats => ({
  version: STATS_VERSION,
  kwh_used: 50, grid_import_kwh: 40, grid_export_kwh: 0, grid_cost_sek: 60, grid_import_sek: 60, export_revenue_sek: 0,
  solar_export_revenue_sek: 0,
  pool_kwh: 20, pool_cost_sek: 30, pool_published_kwh: 20, pool_estimated_kwh: 0, pool_cheap_kwh: 10, pool_heating_hours: 5,
  pool_min_c: 29, pool_max_c: 31, pool_end_c: 30, battery_charge_kwh: 0, battery_discharge_kwh: 0, battery_wear_sek: 0, ev_kwh: 0,
  ev_unplugged_kwh: 0, ev_unplugged_quarters: 0, solar_kwh: 0, solar_used_kwh: 0, solar_base_kwh: 0, solar_pool_kwh: 0, solar_ev_kwh: 0, solar_battery_kwh: 0, solar_exported_kwh: 0,
  import_price_paid: 1.4, import_price_mean: 2, ...over,
});

/** Eight quarters priced 1..8, the first four published, pool at 30 °C. */
/** A 288-quarter series with a pool and a car trajectory, both reachable from the start unless said otherwise. */
function comfortSeries(poolC: (i: number) => number, carKm: (i: number) => number, over: Partial<NonNullable<BenchSeries['comfort']>> = {}): BenchSeries {
  const n = 288;
  const series = planSeries(Array.from({ length: n }, (_, i) => slot(i)), null);
  series.poolStart = new Array(n).fill(null);
  series.poolThermal = {
    store: { capacity_kwh_per_c: 1, response_time_constant_h: 0, loss: { kind: 'measured', points: [{ at_c: 30, c_per_h: -1 / 24 }] } },
    outdoorC: new Array(n).fill(20), localMonth: new Array(n).fill(7),
  };
  series.poolC = Array.from({ length: n }, (_, i) => poolC(i));
  series.carKm = Array.from({ length: n }, (_, i) => carKm(i));
  series.comfort = {
    pool_target_c: 30, ev_target_km: 300, pool_start_c: 30, ev_start_km: 300,
    poolReachableC: new Array(n).fill(35), carReachableKm: new Array(n).fill(470), ...over,
  };
  return series;
}

Deno.test('pool cold exposure is fractional, quadratic near target with a duration-weighted linear tail without threshold cliffs', () => {
  assertEquals(scoreQuarters(comfortSeries(() => 30, () => 300)).sum, 0);
  const constant = (temp: number) => scoreQuarters(comfortSeries(() => temp, () => 300, { pool_start_c: temp }));
  assertAlmostEquals(constant(29).sum, -144, 1e-9);
  assertAlmostEquals(constant(28).sum, -576, 1e-9);
  assertAlmostEquals(constant(27).sum, -1152, 1e-9);
  assertAlmostEquals(constant(20).sum, -5184, 1e-9);
  assertAlmostEquals(constant(29.5).quarters[0].score, -.125, 1e-9);
  assertAlmostEquals(constant(29.99).quarters[0].score - constant(30.01).quarters[0].score, -.00005, 1e-9);
  const nearFormerLine = constant(28.9999).quarters[0].score - constant(29.0001).quarters[0].score;
  assertAlmostEquals(nearFormerLine, -.0002, 1e-9);
  assertEquals(constant(28).requiredFired, []);
  const partial = comfortSeries(() => 29, () => 300, { pool_start_c: 29 });
  partial.hours[0] = .05;
  assertAlmostEquals(scoreQuarters(partial).quarters[0].score, -.1, 1e-9);
});

Deno.test('the car loses two points in a quarter below its floor line, and never fails the case', () => {
  const lines = Array.from({ length: 288 }, (_, i) => i < 4 ? null : 100);
  const low = scoreQuarters(comfortSeries(() => 30, i => i < 8 ? 99 : 100, { carFloorKm: lines }));
  assertEquals(low.quarters[3], { score: 0, fired: [], deductions: {} });
  assertEquals(low.quarters[4], { score: -2, fired: ['car_floor'], deductions: { car_floor: -2 } });
  assertEquals(low.quarters[8], { score: 0, fired: [], deductions: {} });
  assertEquals([low.counts.car_floor, low.sum, low.requiredFired], [4, -8, []]);
});

Deno.test('warm water earns no comfort reward or arbitrary next-day deduction', () => {
  const warm = comfortSeries(() => 34, () => 300, { pool_start_c: 34 });
  assertEquals(scoreQuarters(warm).sum, 0);
  warm.importPrice.fill(10); warm.solarW.fill(0);
  assertEquals(scoreQuarters(warm).sum, 0);
});

Deno.test('pool applicability needs a temperature trajectory, not reachability grace', () => {
  const cold = comfortSeries(() => 24, () => 300, { pool_start_c: 24, poolReachableC: Array(288).fill(24) });
  assertEquals(scoreQuarters(cold).applicability.pool_shortfall, { applicable: true, eligibleQuarters: 288, reason: 'Counts in 288 of 288 quarters.' });
});

Deno.test('cold exposure does not restart a recovery grace on replanning', () => {
  const cold = comfortSeries(() => 24, () => 300, { pool_start_c: 24, poolReachableC: Array(288).fill(24) });
  assertAlmostEquals(scoreQuarters(cold).quarters[0].score, -10, 1e-9);
});

Deno.test('continuous pool coefficient and enabled state control its cost', () => {
  const series = comfortSeries(() => 29, () => 300, { pool_start_c: 29 });
  assertEquals(scoreQuarters(series, { pool_shortfall: { enabled: false } }).sum, 0);
  assertAlmostEquals(scoreQuarters(series, { pool_shortfall: { points: -1.5 } }).quarters[0].score, -.375, 1e-9);
});

Deno.test('continuous pool costs accept finite negative coefficients and reject retired temperature rules', () => {
  assertEquals(criteriaErrors({ pool_shortfall: { points: -0.5 } }), []);
  assertEquals(criteriaErrors({ pool_shortfall: { points: 0 } }).length, 1);
  assertEquals(criteriaErrors({ pool_shortfall: { points: 1 } }).length, 1);
  assertEquals(criteriaErrors({ pool_shortfall: { threshold: 1 } }).length, 1);
  for (const key of ['pool_low', 'pool_cold', 'pool_hot', 'pool_warm', 'cheap_buy']) assertThrows(() => resolveRules({ [key]: { points: -1 } }), CriteriaError);
  assertEquals(criteriaErrors({ car_floor: { threshold: 10 } }).length, 1);
  assertEquals(criteriaErrors({ car_floor: { points: 3 } }).length, 1);
  assertEquals(criteriaErrors({ ev_low: { threshold: 60 }, ev_short: { points: -2 } }), []);
  assertEquals(resolveRules().map(r => r.key), ['pool_shortfall', 'car_floor', 'water_opportunities']);
  assertEquals(criteriaErrors({ water_opportunities: { threshold: 2, points: -2 } }), []);
  assertEquals(criteriaFingerprint({ pool_shortfall: { points: -1.5 }, car_floor: { points: -2 } }),
    criteriaFingerprint({ car_floor: { points: -2 }, pool_shortfall: { points: -1.5 } }));
  assertEquals(serviceGuard(), { pool: 'linear_tail_shortfall' });
});

/** An audit as evaluate.ts attaches it: nothing found unless said otherwise. */
const auditOf = (over: Partial<OpportunityAudit> = {}): OpportunityAudit => ({
  version: OPPORTUNITY_AUDIT_VERSION, lane: 'told/nominal', status: 'complete', reason: null, guard: DEFAULT_SERVICE_GUARD,
  scaleSek: 40, originalCostSek: 50, improvedCostSek: 50, avoidableSek: 0, knownSek: 0, hindsightSek: 0, wearSek: 0,
  trials: 1, limitReached: false, findings: [], violations: [],
  rules: Object.fromEntries(OPPORTUNITY_RULES.map(r => [r.key, { findings: 0, kwh: 0, knownSek: 0, hindsightSek: 0, knownQuarters: [] }])) as OpportunityAudit['rules'],
  applicability: Object.fromEntries(OPPORTUNITY_RULES.map(r => [r.key, { applicable: true, reason: 'test' }])) as OpportunityAudit['applicability'],
  ...over,
});

Deno.test('case points are the deductions less the net bill, a point a krona; evidence takes none', () => {
  const cold = comfortSeries(() => 28.5, () => 300);
  const worst = scoreQuarters(cold);
  assertAlmostEquals(worst.sum, -323.25, 1e-9);
  assertEquals([worst.audit, worst.bill, worst.complete], [null, null, false]);
  // Without its bill or its audit a case shows its deductions alone, and has no stored score.
  assertEquals(worst.points, -323.25);
  assertThrows(() => storedScore(cold), Error, 'opportunity audit');

  const audit = auditOf({ knownSek: 5, hindsightSek: 30, avoidableSek: 35 });
  audit.rules.battery_price_spread.knownQuarters = [4, 5, 8];
  audit.rules.export_before_import.knownQuarters = [8, 12];
  const bill = { grid_sek: 100, wear_sek: 2, net_sek: 72, credit: { reference_sek_per_kwh: 2, battery: null, pool: null, ev: null, credit_sek: 30 } };
  assertEquals(scoreQuarters({ ...cold, audit }).complete, false);
  assertThrows(() => storedScore({ ...cold, audit }), Error, 'bill');
  const audited = scoreQuarters({ ...cold, audit, bill });
  // 323.25 kr of deductions and a net bill of 72 kr; what the audit proves is evidence and takes nothing.
  assertEquals([audited.points, audited.sum, audited.complete], [-395.25, -323.25, true]);
  // Loading a device does not change the service deductions or award a price-rank reward.
  const busy = { ...cold, audit, bill, carW: cold.carW.map(() => 3000) };
  assertEquals(scoreQuarters(busy).points, -395.25);
  // An audit of another version is not read.
  const dated = scoreQuarters({ ...cold, audit: auditOf({ version: OPPORTUNITY_AUDIT_VERSION + 1 }), bill });
  assertEquals([dated.auditPending, dated.complete, dated.points], [true, false, -323.25]);

  const stored = storedScore({ ...comfortSeries(() => 30, () => 300), audit, bill });
  assertEquals([stored.sum, stored.points, stored.physical_failed], [0, -72, false]);
  assertEquals([stored.grid_sek, stored.wear_sek, stored.credit_sek], [100, 2, 30]);
  assertEquals([stored.audit.knownSek, stored.audit.findingCount, stored.audit.violations], [5, 0, 0]);
  assertEquals(isStale(stored), false);
  assertEquals(isStale(stored, { pool_shortfall: { points: -1.5 } }), true);
  assertEquals(isStale({ ...stored, version: 2 }), true);
  assertEquals(isStale({ ...stored, audit: { ...stored.audit, version: OPPORTUNITY_AUDIT_VERSION + 1 } }), true);
  // A score stored by the comfort-only scorer has no audit at all.
  const { audit: _audit, physical_failed: _failed, ...v2 } = stored;
  assertEquals(isStale({ ...v2, version: 2 } as StoredScore), true);
  assertEquals([storedPassed(stored, null), storedPassed(stored, 'fail'), storedPassed({ ...stored, required_fired: ['pool_cold'] }, 'pass')], [true, false, true]);
  assertEquals(storedPassed({ ...stored, physical_failed: true }, 'pass'), false);
});

Deno.test('runScore is exactly the sum of visible integer case points', () => {
  assertEquals(runScore([]), null);
  assertEquals(runScore([0, 0]), 0);
  assertEquals(runScore([-10, -10]), -20);
  assertEquals(runScore([0, -2, -5]), -7);
});

Deno.test('distinctScoreRuns keeps the newest of consecutive versions with the same score', () => {
  const runs = [['a', 383], ['b', 411], ['c', 411], ['d', 407], ['e', 407], ['f', 407], ['g', 411], ['h', 505]] as const;
  const listed = (keep?: (run: readonly [string, number | null]) => boolean, from: readonly (readonly [string, number | null])[] = runs) =>
    distinctScoreRuns(from, run => run[1], keep).map(run => run[0]).join('');
  // The later 411 is not next to the earlier ones, so it is a version of its own.
  assertEquals(listed(), 'acfgh');
  assertEquals(listed(run => run[0] === 'd'), 'acdfgh');
  // An unscored version stays and separates the equal scores either side of it.
  assertEquals(listed(undefined, [['a', 407], ['b', null], ['c', 407], ['d', null], ['e', null]]), 'abcde');
  assertEquals(listed(undefined, []), '');
});

Deno.test('suiteStats sums totals and weights averages by energy', () => {
  const suite = suiteStats([stats({ grid_export_kwh: 2, export_revenue_sek: 1 }), stats({ pool_min_c: 28, grid_export_kwh: 0 })]);
  assertEquals(suite.cases, 2);
  assertEquals(suite.grid_cost_sek, 120);
  assertEquals(suite.pool_min_c, 28);
  assertEquals(suite.export_price, 0.5);
  // Per kWh bought, not per kWh used: solar in the house does not dilute the price.
  assertAlmostEquals(suite.import_price!, 1.5);
  assertAlmostEquals(suite.pool_price!, 1.5);
  assertEquals(suite.solar_export_price, null);
  const sunny = suiteStats([stats({ solar_exported_kwh: 4, solar_export_revenue_sek: 1 }), stats({ solar_exported_kwh: 1, solar_export_revenue_sek: 1.5, battery_wear_sek: 0.4 })]);
  assertAlmostEquals(sunny.solar_export_price!, 0.5);
  assertAlmostEquals(sunny.battery_wear_sek, 0.4);
});
