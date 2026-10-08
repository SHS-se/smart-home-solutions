// User-approved private TEST lane. Service credentials are held only in memory.
import { z } from "zod";
import { assertEquals } from "@std/assert";
import { loadWasmCandidate, readyProblem } from "../bench/wasm-planner.ts";
import { solveOutcome } from "../supabase/functions/_shared/planner-wasm/core.ts";
import { loadCase } from "../src/lib/planner-bench/case.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import type { CriteriaOverrides } from "../src/lib/planner-bench/types.ts";
import type { ReadyProblem } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { syntheticReadyProblem } from "./planner-synthetic.fixture.ts";
import { PROBE_PROJECT, testProbeServiceKey } from "./planner-probe-auth.ts";

const [input, output] = Deno.args;
if (!input || !output) {
  throw new Error(
    "Usage: deno task probe:planner-hosted <export.json> <report.json>",
  );
}
const project = PROBE_PROJECT;
const serviceKey = await testProbeServiceKey();

let workloads: { name: string; problem: ReadyProblem }[];
if (input === "--synthetic") {
  workloads = [{ name: "synthetic-72h", problem: syntheticReadyProblem() }];
} else {
  const data: {
    cases: { name: string; dataset: unknown; recorded: unknown }[];
    rules: CriteriaOverrides;
  } = JSON.parse(await Deno.readTextFile(input));
  workloads = data.cases.map((c) => ({
    name: c.name,
    problem: readyProblem(
      loadCase(c.dataset, c.recorded),
      HOUSEHOLD,
      data.rules,
    ),
  }));
}
const root = new URL("..", import.meta.url).pathname;
const planner = await loadWasmCandidate(root);
const build = JSON.parse(
  await Deno.readTextFile(
    `${root}/supabase/functions/_shared/planner-wasm/artifact.json`,
  ),
);
const responseSchema = z.object({
  qualification: z.literal("test_live_candidate"),
  build: z.object({ wasm_sha256: z.string(), source_sha256: z.string() }),
  outcome: solveOutcome,
  cold: z.boolean(),
  cold_compile_ms: z.number(),
  solve_elapsed_ms: z.number(),
  handler_preencode_ms: z.number(),
  wasm_memory_bytes: z.number(),
  input_bytes: z.number(),
  output_bytes: z.number(),
});
type Sample = z.infer<typeof responseSchema> & {
  name: string;
  repeat: number;
  request_elapsed_ms: number;
};
const samples: Sample[] = [];
for (const scenario of workloads) {
  const p = scenario.problem;
  const local = planner.plan(p);
  for (let repeat = 0; repeat < 2; repeat++) {
    const started = performance.now();
    const response = await fetch(
      `https://${project}.supabase.co/functions/v1/energy-planner-probe`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(p),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) {
      const diagnostic = await response.json().catch(() => ({}));
      const code = typeof diagnostic.code === "string"
        ? diagnostic.code
        : "unspecified";
      const message = typeof diagnostic.message === "string"
        ? diagnostic.message.slice(0, 300)
        : typeof diagnostic.error === "string"
        ? diagnostic.error.slice(0, 300)
        : "";
      throw new Error(
        `TEST probe returned HTTP ${response.status} (${code}) ${message}; no result qualified.`,
      );
    }
    const raw = await response.text();
    const request_elapsed_ms = performance.now() - started;
    const remote = responseSchema.parse(JSON.parse(raw));
    assertEquals(remote.build.wasm_sha256, build.wasm_sha256);
    assertEquals(remote.build.source_sha256, build.source_sha256);
    assertEquals(
      remote.outcome,
      local.outcome,
      `${scenario.name}: hosted/local parity`,
    );
    samples.push({
      name: scenario.name,
      repeat,
      request_elapsed_ms,
      ...remote,
    });
    console.log(
      JSON.stringify({
        name: scenario.name,
        repeat,
        cold: remote.cold,
        request_elapsed_ms: Math.round(request_elapsed_ms),
        solve_elapsed_ms: Math.round(remote.solve_elapsed_ms),
        wasm_memory_bytes: remote.wasm_memory_bytes,
      }),
    );
  }
}
await Deno.writeTextFile(
  output,
  JSON.stringify(
    {
      project,
      qualification: "test_live_candidate",
      version: planner.version,
      cpu_qualification: "unmeasured_platform_cpu",
      memory_scope: "wasm_instance_high_water_only",
      samples,
    },
    null,
    2,
  ) + "\n",
);
