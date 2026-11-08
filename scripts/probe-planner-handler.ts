/** Private TEST qualification of both complete workers. Never publishes a plan. */
import { assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import { cpuPlanningInput, cpuVaryingRoomPlanningSource, cpuVaryingRoomTargetPlanningSource } from "../tests/planner-handler-cpu.fixture.ts";
import { captureRulesPlanningInput } from "../supabase/functions/_shared/rules-planning-capture.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import { handleEnergyPlanningStep } from "../supabase/functions/_shared/energy-planning-worker.ts";
import type { RoomPreparationProgress } from "../supabase/functions/_shared/rules-room-services.ts";
import { RULES_PLANNING_PROTOCOL } from "../supabase/functions/_shared/rules-planning-client.ts";
import artifact from "../supabase/functions/_shared/planner-wasm/artifact.json" with { type: "json" };
import { PROBE_PROJECT, testProbeServiceKey } from "./planner-probe-auth.ts";

const secret = await testProbeServiceKey();
const cases = [
  { name: "native thermostats", stage: "prepare", input: captureRulesPlanningInput(cpuVaryingRoomPlanningSource(), null, resolveRulePolicy()) },
  { name: "room relay targets", stage: "prepare", input: captureRulesPlanningInput(cpuVaryingRoomTargetPlanningSource(), null, resolveRulePolicy()) },
  { name: "household solve", stage: "solve", input: cpuPlanningInput() },
] as const;
for (const { name, stage, input } of cases) {
  let progress: RoomPreparationProgress | undefined;
  do {
    const request = { protocol: RULES_PLANNING_PROTOCOL, stage, input, room_progress: progress };
    const local = await handleEnergyPlanningStep(new Request("https://probe.test/plan", {
      method: "POST", headers: { "x-shs-planning-secret": "local", "x-request-id": "handler-probe" },
      body: JSON.stringify(request),
    }), "local");
    assertEquals(local.status, 200);
    const body = await local.json();
    const product = body.room_progress ?? (stage === "prepare" ? body.prepared : body.result);
    const expected = createHash("sha256").update(JSON.stringify(product)).digest("hex");
    for (let repeat = 0; repeat < 3; repeat++) {
      const response = await fetch(`https://${PROBE_PROJECT}.supabase.co/functions/v1/energy-planner-probe`, {
        method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "handler", ...request }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await response.text();
      assertEquals(response.status, 200, `TEST ${name} handler failed: HTTP ${response.status}, ${text.slice(0, 500)}`);
      const result = JSON.parse(text);
      assertEquals(result.build.wasm_sha256, artifact.wasm_sha256);
      assertEquals(result.build.source_sha256, artifact.source_sha256);
      assertEquals(result.stage, stage);
      assertEquals(result.slots, 288);
      assertEquals(result.model_version, input.model_version);
      assertEquals(result.next_room, body.room_progress?.next_room ?? null);
      assertEquals(result.result_sha256, expected, "Hosted complete handler must match local output exactly");
      console.log(JSON.stringify({ repeat, name, stage, next_room: result.next_room, project: PROBE_PROJECT,
        handler_elapsed_ms: result.handler_elapsed_ms, response_bytes: result.response_bytes, slots: result.slots, parity: "exact" }));
    }
    progress = body.room_progress;
  } while (progress);
}
