import { assert, assertEquals } from '@std/assert';
import { createWasmPlanner } from '../supabase/functions/_shared/planner-wasm/core.ts';
import type { ReadyProblem } from '../supabase/functions/_shared/planner-wasm/ready-problem.ts';
import fixture from './ev-readiness-overnight.fixture.json' with {type:'json'};
const core = createWasmPlanner(await Deno.readFile(new URL('../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url)));

Deno.test('a synthetic overnight scenario buys range now while preserving accepted unrelated commands', () => {
  const p = structuredClone(fixture.problem) as ReadyProblem;
  const result = core.solve(p).outcome;
  assert(result.kind === 'selected', result.kind);
  const {commands, quarters} = result.selection;
  const energy = quarters.slice(0, fixture.night_quarters).reduce((v,q) => v + q.ev_w * .25 / 1000, 0);
  assert(energy > 10, `The synthetic night must charge useful energy; got ${energy} kWh`);
  assertEquals(commands.findIndex(c => c.ev_amps > 0), 5);
  for (let i=0;i<5;i++) assertEquals(commands[i], p.accepted![i]);
  assert(quarters.every(q => q.ev_kwh! <= p.car_policy!.limit_kwh + 1e-8));
  // A new, low-SOC capture must not receive another day of readiness grace.
  const retry = core.solve(structuredClone(p)).outcome;
  assert(retry.kind === 'selected');
  assertEquals(retry.selection.commands, commands);
});
