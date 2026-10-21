import { baselineFixture } from '../src/lib/home-baseline/fixture.ts';
import { prepareHomeBaseline } from '../src/lib/home-baseline/model.ts';
import { compareModels } from '../src/lib/home-baseline/model-comparison.ts';
import { createWasmReplayPlanner } from '../supabase/functions/_shared/planner-wasm/core.ts';

// Synthetic 31-day household, using the real engine; no network or customer data.
// Pass an older Wasm path to compare speed and complete calculation checksums.
const path = Deno.args[0] ?? new URL('../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url);
const engine = createWasmReplayPlanner(Deno.readFileSync(path));
for (let run = 1; run <= 3; run++) {
  const began = performance.now();
  const input = prepareHomeBaseline(baselineFixture({ start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z' }));
  let solveMs = 0, projectMs = 0, projects = 0;
  const compared = compareModels(input, {
    solve(p) { const at = performance.now(); const result = engine.solve(p); solveMs += performance.now() - at; return result; },
    project(p, commands) { const at = performance.now(); const result = engine.project(p, commands); projectMs += performance.now() - at; projects++; return result; },
  });
  const totalMs = performance.now() - began;
  // Performance and artifact identities change; every physical/financial value must match.
  const stable = { ...compared, result: { ...compared.result, projectionMs: 0 }, scheduler: { ...compared.scheduler, engine: null } };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable)));
  const checksum = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  console.log(JSON.stringify({ run, quarters: input.problem.slots.length, solves: compared.scheduler.solves, projects,
    totalMs: Math.round(totalMs), solveMs: Math.round(solveMs), projectMs: Math.round(projectMs), checksum }));
}
