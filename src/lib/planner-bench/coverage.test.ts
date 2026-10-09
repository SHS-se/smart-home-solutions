import { assertEquals } from '@std/assert';
import { resultState, runCoverage } from './coverage.ts';
import { evaluate } from './evaluate.ts';
import { plannerRulesFingerprint } from './score.ts';
import { plan, world } from './world.fixture.ts';
import type { BenchResultSummary, PlanRecord } from './types.ts';
const c = world();
c.recorded.actual = { base_load_w: c.base_load_forecast_w, solar_w: c.solar_forecast_w };
const record: PlanRecord = { status: 'ready', generation: 'unit', valuation: { scale: 1, pool: 'none', ev: 'none', battery: 'none' }, decisions: plan(), beliefs: { import_sek_per_kwh: c.recorded.prices.import_sek_per_kwh, grid_cost_sek: null }, curves: [] };
const value = evaluate(c, record, {});
const scenario = { id: 'case', revision: 'basis', dataset: c, recorded_at: c.recorded.recorded_at };
const summary: BenchResultSummary = { ...value, sha: 'sha', scenario_id: scenario.id, lane: 'told/nominal', status: 'ok', error: null, cpu_ms: 0, case_revision: 'basis', has_record: true, has_evaluation: true };

Deno.test('suite totals require every recorded case, while pending cases are excluded identically', () => {
  const second = { ...scenario, id: 'second' };
  const results = new Map([[scenario.id, summary]]);
  assertEquals(runCoverage([scenario, second], results, {}).score, null);
  assertEquals(runCoverage([scenario, { ...second, recorded_at: null }], results, {}).score, value.score.points);
  assertEquals(resultState({ ...second, recorded_at: null }, summary, {}), 'waiting');
  results.set(second.id, { ...summary, scenario_id: second.id });
  assertEquals(runCoverage([scenario, second], results, {}).score, value.score.points * 2);
});

Deno.test('current evaluation versions do not bless results from a different case revision', () => {
  assertEquals(resultState(scenario, { ...summary, case_revision: 'previous' }, {}), 'inputs-changed');
  assertEquals(resultState(scenario, { ...summary, case_revision: null }, {}), 'inputs-changed');
  assertEquals(resultState(scenario, { ...summary, referee_version: 0 }, {}), 'needs-rescore');
  assertEquals(resultState(scenario, { ...summary, status: 'error', has_record: false }, {}), 'error');
  assertEquals(resultState(scenario, undefined, {}), 'missing');
});

Deno.test('rescoring cannot make rule-driven decisions optimized under earlier rules current', () => {
  const solved = { ...summary, planner_generation: 'ready-wasm-v3', planner_rules: plannerRulesFingerprint({}), planner_criteria: '{}' };
  assertEquals(resultState(scenario, solved, {}), 'scored');
  const rules = { pool_restart: { points: -1 } };
  assertEquals(resultState(scenario, { ...solved, ...evaluate(c, record, rules) }, rules), 'inputs-changed');
  assertEquals(resultState(scenario, { ...solved, planner_rules: null }, {}), 'inputs-changed');
  assertEquals(resultState(scenario, { ...solved, planner_criteria: null }, {}), 'inputs-changed');
  // Historical code owns its defaults, independently of the current evaluator.
  assertEquals(resultState(scenario, { ...solved, planner_rules: plannerRulesFingerprint({ pool_restart: { enabled: false } }) }, {}), 'scored');
  assertEquals(resultState(scenario, solved, { solar_spill: { threshold: 1 } }), 'inputs-changed');
});

Deno.test('complete coverage remains correct beyond 1000 cases without a partial sum', () => {
  const cases = Array.from({ length: 1203 }, (_, i) => ({ ...scenario, id: String(i) }));
  const results = new Map(cases.map(c => [c.id, { ...summary, scenario_id: c.id }]));
  assertEquals(runCoverage(cases, results, {}).score, 1203 * value.score.points);
  results.delete('1001');
  const partial = runCoverage(cases, results, {});
  assertEquals([partial.ready, partial.scored, partial.score], [1203, 1202, null]);
});

Deno.test('points from another scorer, rule set or case revision never stand in for a run score', () => {
  const old = { ...summary, score: { ...summary.score!, version: 24, points: 123 },
    referee_version: 0, planner_generation: 'ready-wasm-v3', planner_criteria: '{"pool_restart":{"points":-1}}' };
  const coverage = runCoverage([scenario], new Map([[scenario.id, old]]), {});
  assertEquals([coverage.score, coverage.scored, coverage.scores.get(scenario.id)], [null, 0, null]);
});
