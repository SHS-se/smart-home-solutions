/** Run separately from parallel unit tests: measure the complete cold worker,
 * including Wasm compilation, hot-water refinement, materialization and JSON.
 * Process CPU is a local regression gate, not a hosted platform measurement.
 *
 * One cold process varies by almost 2× on CI runners, so the gate takes the
 * median of RUNS fresh processes, one after another: concurrent samples would
 * share CPU cores and caches and add the very noise the median removes.
 */
import { cpuUsage } from "node:process";
import { assert, assertEquals } from "@std/assert";
import { cpuPlanningInput } from "../tests/planner-handler-cpu.fixture.ts";
import { RULES_PLANNING_PROTOCOL } from "../supabase/functions/_shared/rules-planning-client.ts";
import { handleEnergyPlanningStep } from "../supabase/functions/_shared/energy-planning-worker.ts";

const RUNS = 3;
// Reserve at least 500 ms below the hosted two-second CPU ceiling for host
// differences and transport. The native work and projection tests also bound
// work deterministically, independently of machine speed.
const BUDGET_MS = 1500;

type Sample = { cpu_ms: number; elapsed_ms: number; slots: number };

/** Plan once in this process and return its CPU, failing on an incomplete plan. */
async function sample(): Promise<Sample> {
  const input = cpuPlanningInput();
  const before = cpuUsage();
  const started = performance.now();
  const response = await handleEnergyPlanningStep(new Request("https://cpu.test/plan", {
    method: "POST", headers: { "x-shs-planning-secret": "cpu-test", "x-request-id": "cpu-regression" },
    body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, input }),
  }), "cpu-test");
  const body = await response.json();
  const used = cpuUsage(before);
  const result = { cpu_ms: (used.user + used.system) / 1000, elapsed_ms: performance.now() - started, slots: input.problem.slots.length };
  assertEquals(response.status, 200, JSON.stringify(body));
  assertEquals(body.result.plan.status, "ready");
  assertEquals(body.result.plan.plans.priority.slots.length, 288);
  return result;
}

/** A fresh process, so every sample pays Wasm compilation and module loading. */
async function coldSample(): Promise<Sample> {
  const { code, stdout } = await new Deno.Command(Deno.execPath(), {
    // No V8 code cache: a later sample must not reuse an earlier one's compilation.
    args: ["run", "--no-check", "--sloppy-imports", "--allow-read", "--no-code-cache", import.meta.filename!, "--sample"],
    stdout: "piped", stderr: "inherit",
  }).output();
  const lines = new TextDecoder().decode(stdout).trim().split("\n");
  assertEquals(code, 0, lines.join("\n"));
  return JSON.parse(lines.at(-1)!);
}

if (Deno.args.includes("--sample")) {
  console.log(JSON.stringify(await sample()));
} else {
  const samples: Sample[] = [];
  for (let run = 1; run <= RUNS; run++) {
    samples.push(await coldSample());
    console.log(JSON.stringify({ run, ...samples.at(-1) }));
  }
  const median = samples.map(s => s.cpu_ms).sort((a, b) => a - b)[Math.floor(RUNS / 2)];
  console.log(JSON.stringify({ median_cpu_ms: median }));
  assert(median < BUDGET_MS, `Complete cold planning worker used a median ${median.toFixed(1)} ms CPU over ${RUNS} runs; budget is ${BUDGET_MS} ms`);
}
