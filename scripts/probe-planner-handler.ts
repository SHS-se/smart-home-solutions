/** Private TEST qualification of the complete worker. Never publishes a plan. */
import { assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import { cpuPlanningInput } from "../tests/planner-handler-cpu.fixture.ts";
import { handleEnergyPlanningStep } from "../supabase/functions/_shared/energy-planning-worker.ts";
import { RULES_PLANNING_PROTOCOL } from "../supabase/functions/_shared/rules-planning-client.ts";
import artifact from "../supabase/functions/_shared/planner-wasm/artifact.json" with { type: "json" };
import { PROBE_PROJECT, testProbeServiceKey } from "./planner-probe-auth.ts";

const input = cpuPlanningInput();
const local = await handleEnergyPlanningStep(new Request("https://probe.test/plan", {
  method: "POST", headers: { "x-shs-planning-secret": "local", "x-request-id": "handler-probe" },
  body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, input }),
}), "local");
assertEquals(local.status, 200);
const expected = createHash("sha256").update(JSON.stringify((await local.json()).result)).digest("hex");
const secret = await testProbeServiceKey();
for (let repeat = 0; repeat < 3; repeat++) {
  const response = await fetch(`https://${PROBE_PROJECT}.supabase.co/functions/v1/energy-planner-probe`, {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ mode: "handler", protocol: RULES_PLANNING_PROTOCOL, input }),
    signal: AbortSignal.timeout(8000),
  });
  const result = await response.json();
  assertEquals(response.status, 200, `Complete TEST handler failed: HTTP ${response.status}, ${JSON.stringify(result)}`);
  assertEquals(result.build.wasm_sha256, artifact.wasm_sha256);
  assertEquals(result.build.source_sha256, artifact.source_sha256);
  assertEquals(result.slots, 288);
  assertEquals(result.model_version, input.model_version);
  assertEquals(result.result_sha256, expected, "Hosted complete handler must match local output exactly");
  console.log(JSON.stringify({ repeat, project: PROBE_PROJECT, handler_elapsed_ms: result.handler_elapsed_ms,
    response_bytes: result.response_bytes, slots: result.slots, parity: "exact" }));
}
