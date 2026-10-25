/** Private TEST qualification of both complete workers. Never publishes a plan. */
import { assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import { cpuPlanningInput, cpuVaryingRoomPlanningSource } from "../tests/planner-handler-cpu.fixture.ts";
import { captureRulesPlanningInput } from "../supabase/functions/_shared/rules-planning-capture.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import { handleEnergyPlanningStep } from "../supabase/functions/_shared/energy-planning-worker.ts";
import { RULES_PLANNING_PROTOCOL } from "../supabase/functions/_shared/rules-planning-client.ts";
import artifact from "../supabase/functions/_shared/planner-wasm/artifact.json" with { type: "json" };
import { PROBE_PROJECT, testProbeServiceKey } from "./planner-probe-auth.ts";

const secret = await testProbeServiceKey();
const cases = [
  { stage: "prepare", input: captureRulesPlanningInput(cpuVaryingRoomPlanningSource(), null, resolveRulePolicy()) },
  { stage: "solve", input: cpuPlanningInput() },
] as const;
for (const { stage, input } of cases) {
  const local = await handleEnergyPlanningStep(new Request("https://probe.test/plan", {
    method: "POST", headers: { "x-shs-planning-secret": "local", "x-request-id": "handler-probe" },
    body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage, input }),
  }), "local");
  assertEquals(local.status, 200);
  const body = await local.json();
  const expected = createHash("sha256").update(JSON.stringify(stage === "prepare" ? body.prepared : body.result)).digest("hex");
  for (let repeat = 0; repeat < 3; repeat++) {
    const response = await fetch(`https://${PROBE_PROJECT}.supabase.co/functions/v1/energy-planner-probe`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "handler", protocol: RULES_PLANNING_PROTOCOL, stage, input }),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    assertEquals(response.status, 200, `TEST ${stage} handler failed: HTTP ${response.status}, ${JSON.stringify(result)}`);
    assertEquals(result.build.wasm_sha256, artifact.wasm_sha256);
    assertEquals(result.build.source_sha256, artifact.source_sha256);
    assertEquals(result.stage, stage);
    assertEquals(result.slots, 288);
    assertEquals(result.model_version, input.model_version);
    assertEquals(result.result_sha256, expected, "Hosted complete handler must match local output exactly");
    console.log(JSON.stringify({ repeat, stage, project: PROBE_PROJECT, handler_elapsed_ms: result.handler_elapsed_ms,
      response_bytes: result.response_bytes, slots: result.slots, parity: "exact" }));
  }
}
