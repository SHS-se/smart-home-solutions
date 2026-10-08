import { assertEquals, assertRejects } from "@std/assert";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { prepareRulesPlanningInput } from "./rules-planner.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { generateRemoteRulesPlan, RULES_PLANNING_PROTOCOL } from "./rules-planning-client.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";

const connection = { url: "https://planner.test", planningSecret: "private", requestId: "test-request" };
function input() {
  const snapshot = dispatchedEvSnapshot();
  snapshot.slots = snapshot.slots.slice(0, 8);
  snapshot.captured_at = snapshot.slots[0].start;
  snapshot.comfort = { ev: { target_km: 300 } };
  return prepareRulesPlanningInput({ snapshot, now: snapshot.captured_at,
    resolved_price_outlook: { shaped: true, observed_days: 1, effective_days: 1,
      level_sek_per_kwh: 1, shadow_import_sek_per_kwh: snapshot.slots.map(() => 1) } }, null, resolveRulePolicy());
}
Deno.test("one-shot transport returns the complete rules plan in one authenticated worker call", async () => {
  let calls = 0;
  const fetcher: typeof fetch = (url, init) => {
    calls++;
    assertEquals(new Headers(init?.headers).get("x-shs-planning-secret"), connection.planningSecret);
    return handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  };
  const prepared = input();
  const result = await generateRemoteRulesPlan(prepared, connection, fetcher);
  assertEquals(calls, 1);
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
