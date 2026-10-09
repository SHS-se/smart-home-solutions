import { SHORT_GAP_PRICE_TOLERANCE } from './short-gaps.ts';
import { EARLY_CHARGE_PRICE_TOLERANCE } from './early-charge.ts';
import { assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { OPPORTUNITY_AUDIT_VERSION, OPPORTUNITY_RULES, type OpportunityAudit } from './opportunities.ts';
import { planSeries } from './series.fixture.ts';
import { DEFAULT_SERVICE_GUARD } from './service.ts';
import { planStats, suiteStats } from './stats.ts';
import {
  CriteriaError, REMOVED_RULE_KEYS,
  criteriaErrors, criteriaFingerprint, distinctScoreRuns, economicPoints, ENERGY_TIMING_SCORES, evBatterySupplyW, flexibleGridSupplyW, isStale, resolveRules, runScore, scoreQuarters, serviceGuard,
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

Deno.test('a modeled future adverse reheating day credits one episode and preserves the separate overheating rule', () => {
  const hot = (price: (day: number) => number, solar: (day: number) => number) => {
    const series = comfortSeries(() => 32.1, () => 300);
    series.importPrice = series.importPrice.map((_, i) => price(Math.floor(i / 96)));
    series.solarW = series.solarW.map((_, i) => solar(Math.floor(i / 96)));
    return scoreQuarters(series, { cheap_buy: { enabled: false }, cheapest_buy: { enabled: false } });
  };
  // The same every day: nothing to hold the heat for. The last day has no next day and is not judged.
  const waste = hot(() => 1, () => 1000);
  assertEquals([waste.quarters[0], waste.quarters[287]], [{ score: -1, fired: ['pool_hot'] }, { score: 0, fired: [] }]);
  assertEquals([waste.counts.pool_hot, waste.counts.pool_buffer, waste.sum, waste.passed], [192, undefined, -192, true]);
  // Dearer on the second day only: day one is a buffer, day two is not.
  const dearer = hot(day => day === 1 ? 2 : 1, () => 1000);
  assertEquals([dearer.quarters[0], dearer.quarters[96]], [{ score: 1, fired: ['pool_buffer'] }, { score: 0, fired: ['pool_hot', 'pool_buffer'] }]);
  assertEquals(dearer.sum, 1);
  // Less sun the next day counts the same; a difference within the margin does not.
  assertEquals(hot(() => 1, day => day === 0 ? 1000 : 500).quarters[0].fired, ['pool_buffer']);
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
  assertEquals(criteriaErrors({ cheap_buy: { points: 2, threshold: 0.3 }, cheapest_buy: { points: 1 } }), []);
  assertEquals(criteriaErrors({ cheapest_buy: { points: 0 } }).length, 1);
    assertEquals(criteriaErrors({ pool_low: { points: -0.5 } }).length, 1);
  assertEquals(criteriaErrors({ ev_low: { threshold: Number.NaN }, ev_short: { threshold: -5 } }).length, 2);
  assertEquals(criteriaErrors({ pool_warm: { points: -1 } }), ['Unknown rule "pool_warm".']);
  const series = comfortSeries(() => 28.5, () => 300);
  assertThrows(() => scoreQuarters(series, { pool_low: { points: 3 } }), CriteriaError);
  assertThrows(() => resolveRules({ ev_low: { threshold: Number.POSITIVE_INFINITY } }), CriteriaError);
  // The quarter-by-quarter money rules were replaced by the opportunity audit. An override left under their
  // names is not an error and not applied: it changes neither the rules nor the fingerprint.
  assertEquals(REMOVED_RULE_KEYS, ['solar_spill', 'idle_battery', 'dear_buy', 'dearest_buy', 'estimated_buy', 'unplugged_charge']);
  const left = { solar_spill: { points: -1, threshold: 90 }, idle_battery: { enabled: false } };
  assertEquals(criteriaErrors(left), []);
  assertEquals(resolveRules(left).map(r => r.key), ['pool_low', 'pool_cold', 'pool_hot', 'pool_buffer', 'pool_restart', 'ev_low', 'ev_short', 'cheap_buy', 'cheapest_buy', 'dear_load', 'dearest_load', 'base_load_dear_import', 'base_load_dearest_import', 'missed_cheap_quarter', 'arbitrage_no_export', 'arbitrage_not_full', 'large_load_overlap', 'ev_from_home_battery', 'ev_short_gap', 'pool_short_gap', 'early_grid_charge']);
  assertEquals(scoreQuarters(series, left).sum, scoreQuarters(series).sum);
  assertEquals(criteriaFingerprint({ ...left, pool_low: { threshold: 2 } }), criteriaFingerprint({ pool_low: { threshold: 2 } }));
  assertEquals(serviceGuard({ pool_low: { threshold: 0.5, enabled: false }, ev_short: { threshold: 120 } }), { pool: [0.5, 2], ev: [50, 120] });
});

Deno.test('flexible load in a cheap quarter gains a point, in a very cheap one two, and never both', () => {
  const series = comfortSeries(() => 30, () => 300);
  // Prices rise through the plan; the pool runs for the first 40 quarters, then once late at a dear price.
  series.importPrice = series.importPrice.map((_, i) => 1 + i / 1000);
  series.poolW = series.poolW.map((_, i) => i < 40 || i === 200 ? 3000 : 0);
  const score = scoreQuarters(series);
  // The cheapest tenth is 28.8 quarters: 29 at +2, the next 11 at +1, the dear one nothing.
  assertEquals([score.counts.cheapest_buy, score.counts.cheap_buy], [29, 11]);
  assertEquals([score.quarters[0].score, score.quarters[30].score, score.quarters[200].score], [2, 1, 0]);
  assertEquals([score.sum, score.points], [69, 69]);
  // Without the very cheap rule, the cheap one covers those quarters too.
  assertEquals(scoreQuarters(series, { cheapest_buy: { enabled: false } }).sum, 40);
});

Deno.test('flexible load bought in a dear quarter loses a point, in a very dear one two, and never both', () => {
  const series = comfortSeries(() => 30, () => 300);
  // Prices rise through the plan; the car charges once at a middling price, then through the last 40 quarters.
  series.importPrice = series.importPrice.map((_, i) => 1 + i / 1000);
  series.carW = series.carW.map((_, i) => i === 150 || i >= 248 ? 3000 : 0);
  series.gridImportW = series.carW.map(w => w + 400);
  const score = scoreQuarters(series);
  // The dearest tenth is 28.8 quarters: 29 at −2, the 11 before them at −1, the middling one nothing.
  assertEquals([score.counts.dearest_load, score.counts.dear_load, score.counts.cheap_buy], [29, 11, undefined]);
  assertEquals([score.quarters[287].score, score.quarters[250].score, score.quarters[150].score], [-2, -1, 0]);
  assertEquals([score.sum, score.points], [-69, -69]);
  // Without the very dear rule, the dear one covers those quarters too.
  assertEquals(scoreQuarters(series, { dearest_load: { enabled: false } }).sum, -40);
  // Only what is bought counts: with the sun or the battery carrying all but 499 W of it, the charging loses nothing.
  series.gridImportW = series.carW.map(w => w ? 499 : 0);
  assertEquals(scoreQuarters(series).sum, 0);
  series.gridImportW = series.carW.map(w => w ? 500 : 0);
  assertEquals(scoreQuarters(series).sum, -69);
  // Below the flexible threshold nothing is counted, however dear the quarter and however much the house imports.
  series.carW = series.carW.map(w => w ? 400 : 0);
  series.gridImportW = series.carW.map(() => 5000);
  assertEquals(scoreQuarters(series).sum, 0);
  // Where every quarter costs the same, each is as cheap as it is dear, and the two cancel.
  series.importPrice = series.importPrice.map(() => 1);
  series.carW = series.carW.map(() => 3000);
  assertEquals([scoreQuarters(series).sum, scoreQuarters(series).quarters[0].fired], [0, ['cheapest_buy', 'dearest_load']]);
});

Deno.test('dear-price rules exclude battery-supplied flexible demand even when base load imports from the grid', () => {
  const s = planSeries([
    // Screenshot regression: the battery covers the pool while the house still imports 610 W.
    slot(0, { pool_w: 3764, load_w: 5884, pv_w: 664, battery_discharge_w: 4610, grid_import_w: 610 }),
    slot(1, { pool_w: 3000, load_w: 4000, pv_w: 500, battery_discharge_w: 2500, grid_import_w: 1000 }),
    slot(2, { pool_w: 3000, load_w: 4000, pv_w: 500, battery_discharge_w: 2500.1, grid_import_w: 999.9 }),
    // Discharge exported to the grid is unavailable to flexible demand.
    slot(3, { pool_w: 3000, battery_discharge_w: 5000, grid_export_w: 5000, grid_import_w: 500 }),
    // Simultaneous charging and discharging are netted against total flexible demand.
    slot(4, { battery_charge_w: 3000, battery_discharge_w: 3000, grid_import_w: 500 }),
    slot(5, { battery_charge_w: 3000, battery_discharge_w: 1000, grid_import_w: 2500 }),
    slot(6, { ev_w: 3000, load_w: 3500, battery_discharge_w: 3000, grid_import_w: 500 }),
    slot(7, { pool_w: 2000, ev_w: 2000, battery_charge_w: 1000, battery_discharge_w: 5000, grid_import_w: 9000 }),
    // Stored decimal powers at the boundary must not slip below it through subtraction noise.
    slot(8, { pool_w: 3000.1, ev_w: 2000.1, battery_charge_w: 1000.1, battery_discharge_w: 5500.3, grid_import_w: 1000 }),
    slot(9, { pool_w: 3000, pv_w: 4000, grid_import_w: 0 }),
    slot(10, { pool_w: 3000, battery_discharge_w: 0, grid_import_w: 500 }),
  ], null);
  s.importPrice.fill(2);
  assertEquals(s.start.map((_, i) => flexibleGridSupplyW(s, i)), [0, 500, 499.9, 500, 0, 2000, 0, 0, 500, 0, 500]);
  const events = (key: string, overrides = {}) => scoreQuarters(s, overrides).quarters.flatMap((q, i) => q.fired.includes(key) ? [i] : []);
  assertEquals(events('dearest_load'), [1, 3, 5, 8, 10]);
  assertEquals(events('dear_load', { dearest_load: { enabled: false } }), [1, 3, 5, 8, 10]);
  assertEquals(events('dear_load'), []);
});

Deno.test('EV battery supply is charged only after battery exports and other household demand', () => {
  const series = planSeries([
    // Battery supplies base load and pool while grid or solar supplies the EV: allowed.
    slot(0, { load_w: 9000, pool_w: 3000, ev_w: 4000, battery_discharge_w: 5000 }),
    // One tenth of a watt beyond non-EV demand counts; no arbitrary minimum EV load.
    slot(1, { load_w: 9000, pool_w: 3000, ev_w: 4000, battery_discharge_w: 5000.1 }),
    slot(2, { load_w: 9000, pool_w: 3000, ev_w: 4000, battery_discharge_w: 9000 }),
    // Hot water is already included in total household consumption, not added a second time.
    slot(3, { load_w: 9000, boiler_expected_w: 2000, ev_w: 4000, battery_discharge_w: 6000 }),
    // Battery export alongside EV charging does not mean the battery supplies the EV.
    slot(4, { load_w: 9000, ev_w: 4000, battery_discharge_w: 5000, battery_export_w: 3000, grid_export_w: 3000 }),
    // Simultaneous charging is netted out before attributing battery supply.
    slot(5, { load_w: 9000, ev_w: 4000, battery_discharge_w: 6000, battery_charge_w: 1000 }),
    slot(6, { load_w: 5000, ev_w: 0, battery_discharge_w: 6000 }),
    slot(7, { load_w: 9000, ev_w: 4000, pv_w: 9000, battery_discharge_w: 1000, grid_export_w: 1000 }),
    // Fractional stored powers at the exact allowance must not fire from floating-point subtraction noise.
    slot(8, { load_w: 9000.3, ev_w: 4000.2, battery_discharge_w: 5000.1 }),
  ], null);
  assertEquals(series.start.map((_, i) => evBatterySupplyW(series, i)), [0, 0.1, 4000, 1000, 0, 0, 0, 0, 0]);
  const score = scoreQuarters(series);
  assertEquals(score.counts.ev_from_home_battery, 3);
  assertEquals(score.quarters.flatMap((q, i) => q.fired.includes('ev_from_home_battery') ? [i] : []), [1, 2, 3]);
  assertEquals(scoreQuarters(series, { ev_from_home_battery: { enabled: false } }).sum, score.sum + 3);
  assertEquals(scoreQuarters(series, { ev_from_home_battery: { threshold: 1000 } }).counts.ev_from_home_battery, 1);
  assertEquals(scoreQuarters(series, { ev_from_home_battery: { points: -2 } }).sum, score.sum - 3);
});

/** An audit as evaluate.ts attaches it: nothing found unless said otherwise. */
const auditOf = (over: Partial<OpportunityAudit> = {}): OpportunityAudit => ({
  version: OPPORTUNITY_AUDIT_VERSION, lane: 'told/nominal', status: 'complete', reason: null, guard: DEFAULT_SERVICE_GUARD,
  overlap: { thresholdW: 2000, overlappingQuarters: [], moves: [] },
  shortGaps: { priceTolerance: { pool: SHORT_GAP_PRICE_TOLERANCE, ev: SHORT_GAP_PRICE_TOLERANCE }, candidates: [], gaps: [] },
  earlyCharge: { priceTolerance: EARLY_CHARGE_PRICE_TOLERANCE, candidates: [], moves: [] },
  scaleSek: 40, originalCostSek: 50, improvedCostSek: 50, avoidableSek: 0, knownSek: 0, hindsightSek: 0, wearSek: 0,
  trials: 1, limitReached: false, findings: [], violations: [],
  rules: Object.fromEntries(OPPORTUNITY_RULES.map(r => [r.key, { findings: 0, kwh: 0, knownSek: 0, hindsightSek: 0, knownQuarters: [] }])) as OpportunityAudit['rules'],
  applicability: Object.fromEntries(OPPORTUNITY_RULES.map(r => [r.key, { applicable: true, reason: 'test' }])) as OpportunityAudit['applicability'],
  ...over,
});

Deno.test('case points add raw comfort and, where energy timing scores, each known-price quarter once per economic rule', () => {
  const cold = comfortSeries(() => 28.5, () => 300);
  const worst = scoreQuarters(cold);
  assertEquals(worst.sum, -288);
  assertEquals([worst.audit, worst.economicPoints, worst.complete], [null, null, false]);
  assertEquals(worst.points, -288);
  assertThrows(() => storedScore(cold), Error, 'opportunity audit');

  const audit = auditOf({ knownSek: 5, hindsightSek: 30, avoidableSek: 35 });
  audit.rules.battery_price_spread.knownQuarters = [4, 5, 8];
  audit.rules.export_before_import.knownQuarters = [8, 12];
  const audited = scoreQuarters({ ...cold, audit });
  // Five changed quarters: evidence in kronor, and five points only where energy timing scores.
  const taken = ENERGY_TIMING_SCORES ? -5 : 0;
  assertEquals([economicPoints(audit), audited.economicPoints, audited.points, audited.complete], [taken, taken, -288 + taken, true]);
  // Hindsight savings have no points.
  assertEquals(scoreQuarters({ ...cold, audit: auditOf({ hindsightSek: 30, avoidableSek: 30 }) }).economicPoints, 0);
  // An audit of another version is not read.
  const dated = scoreQuarters({ ...cold, audit: auditOf({ version: OPPORTUNITY_AUDIT_VERSION + 1 }) });
  assertEquals([dated.auditPending, dated.economicPoints], [true, null]);

  const stored = storedScore({ ...comfortSeries(() => 30, () => 300), audit });
  assertEquals([stored.sum, stored.economic_points, stored.physical_failed], [0, taken, false]);
  assertEquals(stored.points, taken);
  assertEquals([stored.audit.knownSek, stored.audit.findingCount, stored.audit.violations], [5, 0, 0]);
  assertEquals(isStale(stored), false);
  assertEquals(isStale(stored, { pool_low: { threshold: 2 } }), true);
  assertEquals(isStale({ ...stored, version: 2 }), true);
  assertEquals(isStale({ ...stored, audit: { ...stored.audit, version: OPPORTUNITY_AUDIT_VERSION + 1 } }), true);
  // A score stored by the comfort-only scorer has no audit at all.
  const { audit: _audit, economic_points: _economic, physical_failed: _failed, ...v2 } = stored;
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
  assertAlmostEquals(suite.cost_per_kwh!, 1.2);
  assertEquals(suite.pool_min_c, 28);
  assertEquals(suite.export_price, 0.5);
});
