import { cpuMixedRoomPlanningSource } from "../../../tests/planner-handler-cpu.fixture.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { captureRulesPlanningInput } from "./rules-planning-capture.ts";
import { prepareCapturedRulesInput, executeRulesPlanning } from "./rules-planning-execution.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { EnergyPlanningError, generateRemoteRulesPlan, RULES_PLANNING_PROTOCOL } from "./rules-planning-client.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import { MAX_PLANNING_BODY_BYTES } from "./planning-transport-limits.ts";
import { createPlannerProbe } from "./planner-wasm/probe.ts";
import { SOLVER_BASE64 } from "./planner-wasm/solver-bytes.ts";
import artifact from "./planner-wasm/artifact.json" with { type: "json" };
import runtime from "./planner-wasm/runtime-config.json" with { type: "json" };

const connection = { url: "https://planner.test", planningSecret: "private", requestId: "test-request" };
function input() {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  snapshot.captured_at = snapshot.slots[0].start;
  snapshot.comfort = { ev: { target_km: 300 } };
  return captureRulesPlanningInput({ snapshot, now: snapshot.captured_at,
    resolved_price_outlook: { shaped: true, observed_days: 1, effective_days: 1,
      level_sek_per_kwh: 1, shadow_import_sek_per_kwh: snapshot.slots.map(() => 1) } }, null, resolveRulePolicy());
}
Deno.test("transport prepares and solves the same capture in separate authenticated worker calls", async () => {
  let calls = 0;
  const fetcher: typeof fetch = (url, init) => {
    calls++;
    assertEquals(new Headers(init?.headers).get("x-shs-planning-secret"), connection.planningSecret);
    return handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  };
  const prepared = input();
  const result = await generateRemoteRulesPlan(prepared, connection, fetcher);
  assertEquals(calls, 2);
  assertEquals(result, JSON.parse(JSON.stringify(executeRulesPlanning(prepared))));
  assertEquals(result.plan.snapshot_id, prepared.snapshot.snapshot_id);
  assertEquals(result.plan.plans.priority.slots.length, 8);
});
Deno.test("one-shot transport refuses mismatched protocol or request identity without replay", async () => {
  for (const response of [{ protocol: 8, request_id: connection.requestId },
    { protocol: RULES_PLANNING_PROTOCOL, request_id: "wrong-request" }]) {
    let calls = 0;
    await assertRejects(() => generateRemoteRulesPlan(input(), connection, () => {
      calls++; return Promise.resolve(Response.json(response));
    }), Error, "mismatch");
    assertEquals(calls, 1);
  }
});
Deno.test("one-shot transport fails once on an unreachable worker and expired deadline", async () => {
  let calls = 0;
  const offline: typeof fetch = () => { calls++; return Promise.reject(new Error("offline")); };
  await assertRejects(() => generateRemoteRulesPlan(input(), connection, offline), Error, "could not be reached");
  assertEquals(calls, 1);
  await assertRejects(() => generateRemoteRulesPlan(input(), { ...connection, deadline: -1 }, offline), Error, "deadline");
  assertEquals(calls, 1);
});
Deno.test("one-shot worker requires its private secret and rejects auction protocol", async () => {
  const call = (protocol: number, secret: string) => handleEnergyPlanningStep(new Request(`${connection.url}/solve`, {
    method: "POST", headers: { "x-shs-planning-secret": secret }, body: JSON.stringify({ protocol, input: input() }),
  }), connection.planningSecret);
  assertEquals((await call(RULES_PLANNING_PROTOCOL, "wrong")).status, 401);
  assertEquals((await call(8, connection.planningSecret)).status, 409);
});

Deno.test("private TEST probe executes the complete handler and returns an output digest", async () => {
  const probe = createPlannerProbe(SOLVER_BASE64, artifact, runtime.recipe, "private", "https://vxqpgbzseckgceopitpm.supabase.co");
  const response = await probe(new Request("https://probe.test", { method: "POST",
    headers: { authorization: "Bearer private" },
    body: JSON.stringify({ mode: "handler", stage: "solve", protocol: RULES_PLANNING_PROTOCOL, input: prepareCapturedRulesInput(input()) }) }));
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.slots, 8);
  assertEquals(result.build, artifact);
  const local = await handleEnergyPlanningStep(new Request("https://probe.test/plan", { method: "POST",
    headers: { "x-shs-planning-secret": "private", "x-request-id": "handler-probe" },
    body: JSON.stringify({ protocol: RULES_PLANNING_PROTOCOL, stage: "solve", input: prepareCapturedRulesInput(input()) }) }), "private");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify((await local.json()).result)));
  assertEquals(result.result_sha256, Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""));
});

Deno.test("private TEST probe accepts worker-sized captures and bounds the streamed body", async () => {
  const probe = createPlannerProbe(SOLVER_BASE64, artifact, runtime.recipe, "private", "https://vxqpgbzseckgceopitpm.supabase.co");
  const body = JSON.stringify({ mode: "handler", stage: "solve", protocol: RULES_PLANNING_PROTOCOL,
    input: prepareCapturedRulesInput(input()) });
  const request = (value: string) => new Request("https://probe.test", { method: "POST",
    headers: { authorization: "Bearer private" }, body: value });
  // JSON whitespace tests transport size independently of planner complexity.
  const response = await probe(request(body + " ".repeat(600_000)));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).slots, 8);
  const oversized = await probe(request(" ".repeat(MAX_PLANNING_BODY_BYTES + 1)));
  assertEquals(oversized.status, 413);
  assertEquals(await oversized.json(), { error: "probe_payload_too_large" });
});

Deno.test("transport rejects crossed stage responses and never solves a different capture", async () => {
  for (const corrupt of ["stage", "snapshot", "model"] as const) {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      const response = await handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
      const body = await response.json();
      if (corrupt === "stage") body.stage = "solve";
      else if (corrupt === "snapshot") body.prepared.snapshot.snapshot_id = "other";
      else body.prepared.model_version = "other";
      return Response.json(body);
    };
    await assertRejects(() => generateRemoteRulesPlan(input(), connection, fetcher), Error,
      corrupt === "stage" ? "mismatch" : "invalid prepared input");
    assertEquals(calls, 1);
  }
});

Deno.test("transport shares its deadline across preparation and solve without publishing partial work", async () => {
  let calls = 0;
  const deadline = performance.now() + 30;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    const response = await handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
    // A valid but delayed prepare reply cannot renew the request's deadline.
    await new Promise(resolve => setTimeout(resolve, 40));
    return response;
  };
  await assertRejects(() => generateRemoteRulesPlan(input(), { ...connection, deadline }, fetcher), Error, "deadline");
  assertEquals(calls, 1);
});

Deno.test("separate worker stages preserve mixed-room, household and hot-water ordering exactly", async () => {
  const source = cpuMixedRoomPlanningSource();
  const capture = captureRulesPlanningInput(source, null, resolveRulePolicy());
  const before = structuredClone(capture);
  const expected = executeRulesPlanning(capture);
  const phases: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const submitted = JSON.parse(String(init?.body));
    phases.push(submitted.stage);
    if (submitted.stage === "prepare") {
      assertEquals("problem" in submitted.input, false);
      assertEquals("rooms" in submitted.input, false);
    } else {
      assertEquals(Object.keys(submitted.input.rooms.commands).length, 4);
    }
    return await handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  };
  const result = await generateRemoteRulesPlan(capture, connection, fetcher);
  assertEquals(phases, ["prepare", "solve"]);
  assertEquals(result, JSON.parse(JSON.stringify(expected)));
  assertEquals(capture, before);
});

Deno.test("worker failures preserve retry, recapture and terminal disposition across HTTP", async () => {
  for (const [status, code, disposition] of [[429, "busy", "retry"], [546, "cpu_limit", "retry"],
    [400, "invalid_snapshot", "terminal"], [401, "unauthorized", "terminal"],
    [503, "planner_not_configured", "terminal"], [409, "planner_upgraded", "recapture"]] as const) {
    const error = await assertRejects(() => generateRemoteRulesPlan(input(), connection,
      () => Promise.resolve(Response.json({error: code}, {status}))), EnergyPlanningError);
    assertEquals(error.code, code);
    assertEquals(error.disposition, disposition);
  }
});
