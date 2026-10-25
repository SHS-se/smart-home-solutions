import { assert, assertEquals } from "@std/assert";
import { dispatchedEvSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import { generateRulesPlan } from "./rules-planner.ts";
import { RULES_PLANNING_PROTOCOL } from "./rules-planning-client.ts";

type StageEvent = {
  event: string; request_id: string; sequence: number; stage: string;
  phase: "start" | "complete" | "failed"; elapsed_ms: number; duration_ms?: number; cold?: boolean;
};

async function captureWorker(body: string) {
  const messages: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => { if (typeof args[0] === "string") messages.push(args[0]); };
  try {
    const response = await handleEnergyPlanningStep(new Request("https://worker.test/plan", {
      method: "POST", headers: { "x-shs-planning-secret": "secret", "x-request-id": "trace-request" }, body,
    }), "secret");
    const stages = messages.filter(message => message.startsWith("{"))
      .map(message => JSON.parse(message) as StageEvent).filter(event => event.event === "energy_planning_stage");
    return { response, stages, messages };
  } finally {
    console.info = original;
  }
}

Deno.test("worker traces cold and warm Rust solves separately from surrounding work without changing plans", async () => {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const input = rulesFixtureInput(snapshot);
  const body = JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage: "solve", input });
  const cold = await captureWorker(body);
  const warm = await captureWorker(body);
  const expected = JSON.parse(JSON.stringify(generateRulesPlan(input)));
  for (const { response, stages, messages } of [cold, warm]) {
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { protocol: RULES_PLANNING_PROTOCOL, stage: "solve", request_id: "trace-request", result: expected });
    const active: string[] = [];
    for (const [i, event] of stages.entries()) {
      assertEquals(event.request_id, "trace-request");
      assertEquals(event.sequence, i + 1);
      assert(event.elapsed_ms >= 0);
      if (event.phase === "start") active.push(event.stage);
      else {
        assertEquals(event.phase, "complete");
        assertEquals(active.pop(), event.stage);
        assert(event.duration_ms! >= 0);
      }
    }
    assertEquals(active, []);
    const starts = stages.filter(event => event.phase === "start").map(event => event.stage);
    for (const stage of ["request_read", "request_parse", "plan_generation", "wasm_initialise", "solve",
      "wasm_instantiate", "wasm_input_encode", "wasm_input_allocate", "wasm_execute", "wasm_output_decode",
      "hot_water_refinement", "selected_plan_materialize", "baseline_projection", "plan_assemble", "response_encode"]) {
      assert(starts.includes(stage), `Missing ${stage}`);
    }
    assertEquals(stages.filter(event => event.stage === "wasm_execute" && event.phase === "start").length, 1,
      "Baseline quarters must not flood the function log");
    assert(messages.every(message => !message.includes("secret") && !message.includes("Contract EV") && !message.includes("source_entity_ids")));
  }
  assertEquals(cold.stages.find(event => event.stage === "wasm_initialise")?.cold, true);
  assert(cold.stages.some(event => event.stage === "wasm_compile"));
  assertEquals(warm.stages.find(event => event.stage === "wasm_initialise")?.cold, false);
  assert(!warm.stages.some(event => event.stage === "wasm_compile"));
});

Deno.test("worker records the active failing stage and preserves its error response", async () => {
  const malformed = await captureWorker("{");
  assertEquals(malformed.response.status, 400);
  assertEquals((await malformed.response.json()).error, "invalid_snapshot");
  assertEquals(malformed.stages.at(-1)?.phase, "failed");
  assertEquals(malformed.stages.at(-1)?.stage, "request_parse");

  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  const input = { ...rulesFixtureInput(snapshot), model_version: "obsolete" };
  const rejected = await captureWorker(JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage: "solve", input }));
  assertEquals(rejected.response.status, 400);
  assertEquals((await rejected.response.json()).detail, "Prepared rules planner version changed");
  assertEquals(rejected.stages.at(-1)?.stage, "plan_generation");
  assertEquals(rejected.stages.at(-1)?.phase, "failed");
  assert(!rejected.stages.some(event => event.stage === "wasm_execute"));
});
