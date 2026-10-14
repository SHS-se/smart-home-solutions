/** Run separately from parallel unit tests: measure the complete cold worker,
 * including Wasm compilation, hot-water refinement, materialization and JSON.
 * Process CPU is a local regression gate, not a hosted platform measurement.
 *
 * CI runners differ by almost 2× in speed while samples on one runner agree
 * within ~5%, so raw milliseconds would pass or fail by which machine a job
 * lands on. The gate therefore also times a fixed reference workload that
 * shares no planner code, and scales the planner's median CPU to the baseline
 * machine below. Samples run one after another in fresh processes: concurrent
 * samples would share CPU cores and caches and add the noise this removes.
 */
import { cpuUsage } from "node:process";
import { assert, assertEquals } from "@std/assert";
import { cpuPlanningInput } from "../tests/planner-handler-cpu.fixture.ts";
import { RULES_PLANNING_PROTOCOL } from "../supabase/functions/_shared/rules-planning-client.ts";
import { handleEnergyPlanningStep } from "../supabase/functions/_shared/energy-planning-worker.ts";

const RUNS = 3;
// Budget in baseline-machine milliseconds. Reserve at least 500 ms below the
// hosted two-second CPU ceiling for host differences and transport. The native
// work and projection tests also bound work deterministically.
const BUDGET_MS = 1500;
// Median reference CPU on the baseline machine (Apple M-series, 2026-10-14),
// where the cold worker used ≈1,000 ms. Re-measure only with the reference.
const BASELINE_REFERENCE_MS = 340;
const REFERENCE_ROUNDS = 400;

type Sample = { cpu_ms: number; elapsed_ms: number };

const measure = async (work: () => Promise<unknown> | unknown): Promise<Sample> => {
  const before = cpuUsage();
  const started = performance.now();
  await work();
  const used = cpuUsage(before);
  return { cpu_ms: (used.user + used.system) / 1000, elapsed_ms: performance.now() - started };
};

/** Plan once in this process, failing on an incomplete plan. */
async function planSample(): Promise<Sample> {
  const input = cpuPlanningInput();
  let response!: Response, body!: { result: { plan: { status: string; plans: { priority: { slots: unknown[] } } } } };
  const sample = await measure(async () => {
    response = await handleEnergyPlanningStep(new Request("https://cpu.test/plan", {
      method: "POST", headers: { "x-shs-planning-secret": "cpu-test", "x-request-id": "cpu-regression" },
      body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, input }),
    }), "cpu-test");
    body = await response.json();
  });
  assertEquals(response.status, 200, JSON.stringify(body));
  assertEquals(body.result.plan.status, "ready");
  assertEquals(body.result.plan.plans.priority.slots.length, 288);
  return sample;
}

/** Fixed single-threaded JIT work (allocation, sorting, JSON, float loops). */
function reference(rounds: number): number {
  let seed = 1;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let total = 0;
  for (let round = 0; round < rounds; round++) {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ value: random(), weight: Math.sin(i) }));
    rows.sort((a, b) => a.value - b.value);
    const copy: typeof rows = JSON.parse(JSON.stringify(rows));
    const series = new Float64Array(4096);
    for (let k = 0; k < series.length; k++) series[k] = Math.exp(-k / 512) * copy[k % copy.length].weight;
    for (let k = 1; k < series.length; k++) series[k] += series[k - 1] * .5;
    total += copy.reduce((sum, row) => sum + row.value * row.weight, 0) + series[series.length - 1];
  }
  return total;
}

async function referenceSample(): Promise<Sample> {
  let total = 0;
  const sample = await measure(() => { total = reference(REFERENCE_ROUNDS); });
  assert(Number.isFinite(total));
  return sample;
}

/** A fresh process, so every sample pays module loading and compilation. */
async function coldSample(kind: "plan" | "reference"): Promise<Sample> {
  const { code, stdout } = await new Deno.Command(Deno.execPath(), {
    // No V8 code cache: a later sample must not reuse an earlier one's compilation.
    args: ["run", "--no-check", "--sloppy-imports", "--allow-read", "--no-code-cache", import.meta.filename!, `--${kind}`],
    stdout: "piped", stderr: "inherit",
  }).output();
  const lines = new TextDecoder().decode(stdout).trim().split("\n");
  assertEquals(code, 0, lines.join("\n"));
  return JSON.parse(lines.at(-1)!);
}

async function cpuModel(): Promise<string> {
  // Through a subprocess: --allow-read alone does not open /proc in Deno 2.
  const run = async (command: string, args: string[]) => {
    try {
      const { success, stdout } = await new Deno.Command(command, { args, stdout: "piped", stderr: "null" }).output();
      return success ? new TextDecoder().decode(stdout) : "";
    } catch {
      return "";
    }
  };
  const info = await run("cat", ["/proc/cpuinfo"]);
  const model = /^model name\s*:\s*(.+)$/m.exec(info)?.[1];
  if (model) return `${model.trim()} × ${info.match(/^processor\s*:/gm)?.length ?? "?"}`;
  return (await run("sysctl", ["-n", "machdep.cpu.brand_string"])).trim() || "unknown";
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

if (Deno.args.includes("--plan")) {
  console.log(JSON.stringify(await planSample()));
} else if (Deno.args.includes("--reference")) {
  console.log(JSON.stringify(await referenceSample()));
} else {
  console.log(JSON.stringify({ cpu_model: await cpuModel() }));
  const plans: number[] = [], references: number[] = [];
  // Interleave so a drifting machine affects both measurements alike.
  for (let run = 1; run <= RUNS; run++) {
    const ref = await coldSample("reference");
    const plan = await coldSample("plan");
    references.push(ref.cpu_ms);
    plans.push(plan.cpu_ms);
    console.log(JSON.stringify({ run, reference_cpu_ms: ref.cpu_ms, plan_cpu_ms: plan.cpu_ms, plan_elapsed_ms: plan.elapsed_ms }));
  }
  const speed = BASELINE_REFERENCE_MS / median(references);
  const scaled = median(plans) * speed;
  console.log(JSON.stringify({ median_plan_cpu_ms: median(plans), median_reference_cpu_ms: median(references), speed_vs_baseline: speed, baseline_plan_cpu_ms: scaled }));
  assert(scaled < BUDGET_MS, `Complete cold planning worker used ${scaled.toFixed(1)} baseline ms CPU (median ${median(plans).toFixed(1)} ms on this machine, ${speed.toFixed(2)}× baseline speed); budget is ${BUDGET_MS} ms`);
}
