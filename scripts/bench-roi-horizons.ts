import { ROI_SCENARIOS, roiBenchmarkInput, type RoiScenario } from './roi-benchmark-scenarios.ts';
import { replayScheduler, type ReplayEngine } from '../src/lib/home-baseline/scheduler-replay.ts';
import { createWasmReplayPlanner } from '../supabase/functions/_shared/planner-wasm/core.ts';
import { modeledBill, seriesService } from '../src/lib/home-baseline/model-comparison.ts';

// Experimental copies are temporary: production replay remains daily with 72h horizons.
// Usage: deno run --no-check --sloppy-imports --allow-read --allow-write scripts/bench-roi-horizons.ts SCENARIO MODE [WASM]
// MODE: 72h, month, month-daily, month-scaled. Returns retain required post-withdrawal replans.
const scenario = Deno.args[0] as RoiScenario, mode = Deno.args[1];
if (!ROI_SCENARIOS.includes(scenario)
  || !['72h', 'month', 'month-daily', 'month-scaled'].includes(mode)) throw new Error('Choose a documented scenario and horizon mode');
const wasm = Deno.args[2] ?? new URL('../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url);
const engine = createWasmReplayPlanner(Deno.readFileSync(wasm));
const original = new URL('../src/lib/home-baseline/scheduler-replay.ts', import.meta.url);
let source = await Deno.readTextFile(original);
const replace = (from: string, to: string) => {
  if (source.split(from).length !== 2) throw new Error(`Replay instrumentation anchor changed: ${from}`);
  source = source.replace(from, to);
};
replace('export function replayScheduler(input: BaselineInput, engine: ReplayEngine) {',
  'export function replayScheduler(input: BaselineInput, engine: ReplayEngine, experiment: { daily: boolean; scaled: boolean }) {');
replace('currentDay !== day', '(experiment.daily && currentDay !== day)');
replace('problem.slots.slice(i, i + 288)', 'problem.slots.slice(i)');
replace('horizon.end_credit = problemEndCredit(horizon);',
  'horizon.end_credit = problemEndCredit(horizon); if (experiment.scaled) horizon.work_grant *= Math.max(1, horizon.slots.length / 288); horizon.work_grant = Math.ceil(horizon.work_grant);');
source = source.replace(/from '([^']+)'/g, (_, path: string) => `from '${new URL(path, original).href}'`);
const directory = await Deno.makeTempDir({ prefix: 'roi-horizon-' });
try {
  const path = `${directory}/replay.ts`;
  await Deno.writeTextFile(path, source);
  const experimental = await import(new URL(`file://${path}`).href) as {
    replayScheduler: (input: ReturnType<typeof roiBenchmarkInput>, engine: ReplayEngine, options: { daily: boolean; scaled: boolean }) => ReturnType<typeof replayScheduler>;
  };
  const input = roiBenchmarkInput(scenario);
  let solveMs = 0, projectMs = 0, calls = 0, wasmMemoryBytes = 0;
  const work: { slots: number; used: number; limit: number; evaluations: number; termination: string }[] = [];
  const timed = {
    solve(p: Parameters<typeof engine.solve>[0]) {
      // Keep representative problems for the separate native-stage profiler.
      if (calls++ === 0 || calls === 10) writeProblem(p, calls);
      const began = performance.now(), result = engine.solve(p); solveMs += performance.now() - began;
      wasmMemoryBytes = Math.max(wasmMemoryBytes, result.wasm_memory_bytes);
      if (result.outcome.kind === 'selected') {
        const s = result.outcome.selection;
        work.push({ slots: p.slots.length, used: s.work_used, limit: p.work_grant, evaluations: s.evaluations, termination: s.termination });
      }
      return result;
    },
    project(p: Parameters<typeof engine.project>[0], commands: Parameters<typeof engine.project>[1]) {
      const began = performance.now(), result = engine.project(p, commands); projectMs += performance.now() - began; return result;
    },
  };
  const began = performance.now();
  try {
    const result = mode === '72h' ? replayScheduler(input, timed)
      : experimental.replayScheduler(input, timed, { daily: mode === 'month-daily', scaled: mode === 'month-scaled' });
    const durationMs = performance.now() - began;
    const stable = { series: result.series, commands: result.commands, ledger: result.ledger, poolStates: result.poolStates };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable)));
    const checksum = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    console.log(JSON.stringify({ scenario, mode, durationMs, solveMs, projectMs, wasmMemoryBytes, solves: result.solves, work,
      ledger: result.ledger, bill: modeledBill(input, result), service: seriesService(input, result.series), checksum }));
    await Deno.writeTextFile(`/tmp/roi-horizon-${scenario}-${mode}.json`, JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ scenario, mode, durationMs: performance.now() - began, solveMs, projectMs, calls, error: String(error), work }));
    Deno.exitCode = 1;
  }
} finally {
  await Deno.remove(directory, { recursive: true });
}

function writeProblem(problem: Parameters<typeof engine.solve>[0], call: number) {
  Deno.writeTextFileSync(`/tmp/roi-problem-${scenario}-${mode}-${call}.json`, JSON.stringify(problem));
}
