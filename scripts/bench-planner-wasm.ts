// Nonpublishing qualification: the independent referee sees recorded outcomes;
// the solver receives only the separately prepared causal problem.
import { loadWasmCandidate, readyProblem } from '../bench/wasm-planner.ts';
import { loadCase } from '../src/lib/planner-bench/case.ts';
import { evaluate } from '../src/lib/planner-bench/evaluate.ts';
import { HOUSEHOLD } from '../src/lib/planner-bench/household.ts';
import { scoreQuarters } from '../src/lib/planner-bench/score.ts';
import type { CriteriaOverrides } from '../src/lib/planner-bench/types.ts';

const [input, output] = Deno.args;
if (!input || !output) {
  throw new Error('Usage: deno task bench:planner-wasm <export.json> <report.json>');
}
const data: {
  cases: { name: string; dataset: unknown; recorded: unknown }[];
  rules: CriteriaOverrides;
} = JSON.parse(await Deno.readTextFile(input));
const root = new URL('..', import.meta.url).pathname;
const planner = await loadWasmCandidate(root);
const results: (ReturnType<typeof evaluate> & {
  name: string;
  preparation_ms: number;
  elapsed_ms: number;
  wasm_memory_bytes: number;
  record: ReturnType<typeof planner.plan>['record'];
  solver: ReturnType<typeof planner.plan>['outcome'];
  quarters: ReturnType<typeof scoreQuarters>['quarters'];
})[] = [];
for (const scenario of data.cases) {
  const c = loadCase(scenario.dataset, scenario.recorded);
  const preparedAt = performance.now();
  const problem = readyProblem(c, HOUSEHOLD, data.rules);
  const preparation_ms = performance.now() - preparedAt;
  const { record, elapsed_ms, outcome, wasm_memory_bytes } = planner.plan(problem);
  const evaluated = evaluate(c, record, data.rules);
  const quarters = scoreQuarters(evaluated.series, data.rules).quarters;
  results.push({
    name: scenario.name,
    preparation_ms,
    elapsed_ms,
    wasm_memory_bytes,
    record,
    solver: outcome,
    ...evaluated,
    quarters,
  });
  console.log(
    JSON.stringify({
      name: scenario.name,
      elapsed_ms: Math.round(elapsed_ms),
      points: evaluated.score.points,
      violations: evaluated.outcome.violations.length,
      counts: evaluated.score.counts,
    }),
  );
}
const report = {
  qualification: 'test_live_candidate',
  version: planner.version,
  artifact_bytes: planner.artifact_bytes,
  cold_compile_ms: planner.cold_compile_ms,
  total: results.reduce((sum, r) => sum + r.score.points, 0),
  solve_elapsed_ms: results.reduce((sum, r) => sum + r.elapsed_ms, 0),
  max_solve_elapsed_ms: Math.max(...results.map((r) => r.elapsed_ms)),
  results,
};
await Deno.writeTextFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: undefined }));
