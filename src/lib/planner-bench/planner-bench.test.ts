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
    store: { capacity_kwh_per_c: 1, loss: { kind: 'measured', points: [{ at_c: 30, c_per_h: -1 / 24 }] } },
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
  // A car above its target loses nothing.
  assertEquals(scoreQuarters(comfortSeries(() => 30, () => 450)).sum, 0);
});

Deno.test('overheating accounts for the following day’s price and solar without earning points', () => {
  const hot = (price: (day: number) => number, solar: (day: number) => number) => {
    const series = comfortSeries(() => 32.1, () => 300);
    series.importPrice = series.importPrice.map((_, i) => price(Math.floor(i / 96)));
    series.solarW = series.solarW.map((_, i) => solar(Math.floor(i / 96)));
    return scoreQuarters(series);
  };
  // The same every day: nothing to hold the heat for. The last day has no next day and is not judged.
  const waste = hot(() => 1, () => 1000);
  assertEquals([waste.quarters[0], waste.quarters[287]], [{ score: -1, fired: ['pool_hot'] }, { score: 0, fired: [] }]);
  assertEquals([waste.counts.pool_hot, waste.sum, waste.passed], [192, -192, true]);
  // Dearer on the second day only: storing heat on day one avoids an overheating deduction.
  const dearer = hot(day => day === 1 ? 2 : 1, () => 1000);
  assertEquals([dearer.quarters[0], dearer.quarters[96]], [{ score: 0, fired: [] }, { score: -1, fired: ['pool_hot'] }]);
  assertEquals(dearer.sum, -96);
  // Less sun the next day counts the same; a difference within the margin does not.
  assertEquals(hot(() => 1, day => day === 0 ? 1000 : 500).quarters[0].fired, []);
  assertEquals(hot(day => 1 + day * 0.05, () => 1000).quarters[0].fired, ['pool_hot']);
  // At the target nothing fires.
  assertEquals(scoreQuarters(comfortSeries(() => 31.9, () => 300)).counts.pool_hot, undefined);
});

Deno.test('each comfort rule says whether it could fire in the case, and in how many quarters', () => {
  const reachable = Array.from({ length: 288 }, (_, i) => 24 + i * 0.125);
  const cold = scoreQuarters(comfortSeries(() => 24, () => 300, { pool_start_c: 24, poolReachableC: reachable }), { ev_short: { enabled: false } });
  // 29 °C is due from quarter 136, 28 °C from 128; the car was on target from the start.
  assertEquals(cold.applicability.pool_low, { applicable: true, eligibleQuarters: 152, reason: 'Counts in 152 of 288 quarters.' });
  assertEquals(cold.applicability.pool_cold.eligibleQuarters, 160);
  assertEquals(cold.applicability.ev_low.eligibleQuarters, 288);
  assertEquals([cold.applicability.ev_short.applicable, cold.applicability.ev_short.reason], [false, 'Switched off for this case.']);
  const never = scoreQuarters(comfortSeries(() => 20, () => 300, { pool_start_c: 20, poolReachableC: new Array(288).fill(21) }));
  assertEquals(never.applicability.pool_low, { applicable: false, eligibleQuarters: 0, reason: 'This level was not reachable for a day within the window.' });
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

Deno.test('criteria are checked: a rule gives or takes at most two points, at a real threshold, and old money rules are gone by name', () => {
  assertEquals(criteriaErrors({}), []);
  assertEquals(criteriaErrors({ pool_low: { enabled: false, threshold: 0, points: -2 }, pool_hot: { points: -1 } }), []);
  assertEquals(criteriaErrors({ pool_low: { points: 3 } }), ['pool_low: points must be between -2 and 2, and not 0.']);
  assertEquals(criteriaErrors({ pool_low: { points: -3 } }).length, 1);
  assertEquals(criteriaErrors({ pool_low: { points: -0.5 } }).length, 1);
  assertEquals(criteriaErrors({ ev_low: { threshold: Number.NaN }, ev_short: { threshold: -5 } }).length, 2);
  assertEquals(criteriaErrors({ pool_warm: { points: -1 } }), ['Unknown rule "pool_warm".']);
  const series = comfortSeries(() => 28.5, () => 300);
  assertThrows(() => scoreQuarters(series, { pool_low: { points: 3 } }), CriteriaError);
  assertThrows(() => resolveRules({ ev_low: { threshold: Number.POSITIVE_INFINITY } }), CriteriaError);
  assertEquals(resolveRules().map(r => r.key), ['pool_low', 'pool_cold', 'pool_hot', 'ev_low', 'ev_short']);
  assertEquals(criteriaErrors({ cheap_buy: { points: 1 } }), ['Unknown rule "cheap_buy".']);
  assertThrows(() => resolveRules({ ev_from_home_battery: { points: -1 } }), CriteriaError);
  assertEquals(criteriaFingerprint({ pool_low: { threshold: 2 }, ev_low: { points: -2 } }),
    criteriaFingerprint({ ev_low: { points: -2 }, pool_low: { threshold: 2 } }));
  assertEquals(serviceGuard({ pool_low: { threshold: 0.5, enabled: false }, ev_short: { threshold: 120 } }), { pool: [0.5, 2], ev: [50, 120] });
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
  assertEquals(worst.sum, -288);
  assertEquals([worst.audit, worst.bill, worst.complete], [null, null, false]);
  // Without its bill or its audit a case shows its deductions alone, and has no stored score.
  assertEquals(worst.points, -288);
  assertThrows(() => storedScore(cold), Error, 'opportunity audit');

  const audit = auditOf({ knownSek: 5, hindsightSek: 30, avoidableSek: 35 });
  audit.rules.battery_price_spread.knownQuarters = [4, 5, 8];
  audit.rules.export_before_import.knownQuarters = [8, 12];
  const bill = { grid_sek: 100, wear_sek: 2, net_sek: 72, credit: { reference_sek_per_kwh: 2, battery: null, pool: null, ev: null, credit_sek: 30 } };
  assertEquals(scoreQuarters({ ...cold, audit }).complete, false);
  assertThrows(() => storedScore({ ...cold, audit }), Error, 'bill');
  const audited = scoreQuarters({ ...cold, audit, bill });
  // 288 kr of deductions and a net bill of 72 kr; what the audit proves is evidence and takes nothing.
  assertEquals([audited.points, audited.sum, audited.complete], [-360, -288, true]);
  // Loading a device does not change the service deductions or award a price-rank reward.
  const busy = { ...cold, audit, bill, carW: cold.carW.map(() => 3000) };
  assertEquals(scoreQuarters(busy).points, -360);
  // An audit of another version is not read.
  const dated = scoreQuarters({ ...cold, audit: auditOf({ version: OPPORTUNITY_AUDIT_VERSION + 1 }), bill });
  assertEquals([dated.auditPending, dated.complete, dated.points], [true, false, -288]);

  const stored = storedScore({ ...comfortSeries(() => 30, () => 300), audit, bill });
  assertEquals([stored.sum, stored.points, stored.physical_failed], [0, -72, false]);
  assertEquals([stored.grid_sek, stored.wear_sek, stored.credit_sek], [100, 2, 30]);
  assertEquals([stored.audit.knownSek, stored.audit.findingCount, stored.audit.violations], [5, 0, 0]);
  assertEquals(isStale(stored), false);
  assertEquals(isStale(stored, { pool_low: { threshold: 2 } }), true);
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
