import { assertEquals, assertRejects, assert } from "jsr:@std/assert@1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { PlanningJobs, PlanningJobError, planningCompletionBasis, type PlanningReceipt } from "./energy-planning-jobs.ts";
import { RULES_PLANNING_PROTOCOL } from "./rules-planning-client.ts";
import { RULES_MODEL_VERSION, generateRulesPlan, prepareRulesPlanningInput } from "./rules-planner.ts";
import { resolveRulePolicy } from "./planner-wasm/rule-policy.ts";
import { dispatchedEvSnapshot, mixedModeSnapshot, rulesFixturePlan } from "../../../scripts/generate-ha-plan-fixture.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import { expandStoredPlan, storedPlan } from "./stored-plan.ts";

const jobId = "11111111-1111-4111-8111-111111111111";
const snapshot = dispatchedEvSnapshot();
snapshot.captured_at = snapshot.slots[0].start;
snapshot.slots = snapshot.slots.slice(0, 8).map(s => ({ ...s, pv_forecast_w: 0 }));
snapshot.comfort = {ev:{target_km:300}};
const input = prepareRulesPlanningInput({ snapshot, now: snapshot.captured_at, price_archive: [], resolved_price_outlook: {
  shaped: true, observed_days: 1, effective_days: 1, level_sek_per_kwh: 1.5,
  shadow_import_sek_per_kwh: snapshot.slots.map(() => 1.5),
} }, null, resolveRulePolicy());
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const connection = { url: "https://planner.test", planningSecret: "test-secret" };
const context = { model_version: RULES_MODEL_VERSION, request_id: "request-1", integration_version: "test",
  reference_plan_id: null, fixed_revision: 0, observed_replan_request_id: null, replan_request_id: null,
  completion_basis: "home_assistant_ack" as const, exchange: {} };

Deno.test("only the exact TEST server origin completes on publication", () => {
  assertEquals(planningCompletionBasis("https://vxqpgbzseckgceopitpm.supabase.co"), "publication");
  assertEquals(planningCompletionBasis("https://vxqpgbzseckgceopitpm.supabase.co/"), "publication");
  for (const url of ["", "http://localhost:54321", "http://vxqpgbzseckgceopitpm.supabase.co",
    "https://production.supabase.co", "https://vxqpgbzseckgceopitpm.supabase.co.attacker.example",
    "https://vxqpgbzseckgceopitpm.supabase.co/path"]) {
    assertEquals(planningCompletionBasis(url), "home_assistant_ack");
  }
});

function memoryJobs(options: { lostPublication?: boolean; claimed?: boolean; supersededPublication?: boolean; obsolete?:boolean } = {}) {
  let fence = 0;
  let owned = options.claimed ?? false;
  let receipt: PlanningReceipt = { job_id: jobId, snapshot_id: input.snapshot.snapshot_id,
    state: "pending", pending: true, retry_after_ms: 1 };
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  let publication: Record<string, unknown> | undefined;
  const db = createClient("http://localhost:54321", "test-service", {
    auth: { persistSession: false }, global: { fetch: async (url, init) => {
      const name = String(url).split("/").at(-1)!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ name, body });
      if (name === "read_energy_planning_job") return Response.json(body.p_home_id === jobId
        ? { ...receipt, ...(body.p_snapshot_id ? { exchange: {
          device_configuration: [{ key: "ev", control_type: "amps" }],
          home_configuration: { battery: { included: true } },
        } } : {}) } : null);
      if (name === "claim_energy_planning_attempt") {
        assertEquals(body.p_home_id, jobId);
        if (owned || receipt.state !== "pending") return Response.json(null);
        owned = true; fence++;
        return Response.json({ id: jobId, home_id: jobId, customer_id: jobId, snapshot_id: input.snapshot.snapshot_id,
          fence, protocol: options.obsolete ? 8 : RULES_PLANNING_PROTOCOL });
      }
      if (name === "load_energy_planning_attempt") {
        assertEquals(body.p_fence, fence);
        return Response.json({ input, context });
      }
      if (name === "publish_energy_planning_job") {
        assertEquals(body.fence, fence);
        assertEquals(body.home_id, jobId);
        assertEquals(body.steps, undefined);
        if (options.supersededPublication) {
          receipt = {job_id:jobId,snapshot_id:snapshot.snapshot_id,state:"superseded",pending:false};
          return Response.json(receipt);
        }
        publication = body; owned = false;
        receipt = { job_id: jobId, snapshot_id: input.snapshot.snapshot_id, state: "published", pending: false,
          plan_id: body.current.plan_id, plan: body.current.plan };
        if (options.lostPublication) return Response.json({ message: "reply lost", code: "XX000" }, {status: 500});
        const { plan: _plan, ...publicationReceipt } = receipt;
        return Response.json(publicationReceipt);
      }
      if (name === "fail_energy_planning_job") {
        assertEquals(body.fence, fence);
        owned = false;
        receipt = { job_id: jobId, snapshot_id: input.snapshot.snapshot_id,
          state: "failed", pending: false, code: body.code, detail: body.detail };
        return Response.json(receipt);
      }
      assert(!name.includes("batch"), "The live job must never touch an auction batch");
      return Response.json([]);
    } },
  });
  return { jobs: new PlanningJobs(db), calls, publication: () => publication };
}
const realWorker: typeof fetch = (url, init) => handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);

Deno.test("durable owner solves and atomically publishes in one fenced exchange without a ledger", async () => {
  const state = memoryJobs();
  let workerCalls = 0;
  const receipt = await state.jobs.advanceForHome(jobId, { jobId }, connection, (url, init) => {
    workerCalls++;
    return realWorker(url, init);
  });
  assert(receipt?.state === "published");
  assertEquals(workerCalls, 1);
  const expected = generateRulesPlan(input);
  assertEquals(wire(receipt.plan), wire(expected.plan));
  const current = state.publication()!.current as { plan: Parameters<typeof expandStoredPlan>[0]; ha_ack_status:string; generation_request_id:string };
  assertEquals(wire(expandStoredPlan(current.plan)), wire(expected.plan));
  assertEquals(current.ha_ack_status, "pending", "Cloud publication is not HA completion");
  assertEquals(current.generation_request_id, context.request_id);
  assertEquals(state.calls.filter(call => call.name === "read_energy_planning_job").length, 1,
    "Verified omitted-plan publication returns the locally computed exact plan");
  assert(!state.calls.some(call => call.name.includes("batch")));
});

Deno.test("lost atomic publication reply recovers exact receipt and does not recompute terminal job", async () => {
  const state = memoryJobs({ lostPublication: true });
  let workers = 0;
  const fetcher:typeof fetch = (url,init) => { workers++; return realWorker(url,init); };
  const receipt = await state.jobs.advanceForHome(jobId, { snapshotId: input.snapshot.snapshot_id }, connection, fetcher);
  assert(receipt?.state === "published");
  assertEquals((receipt as Record<string, unknown>).device_configuration, [{ key: "ev", control_type: "amps" }]);
  assertEquals((receipt as Record<string, unknown>).home_configuration, { battery: { included: true } });
  assert(!state.calls.some(call => call.name === "fail_energy_planning_job"));
  const delivered = await state.jobs.advanceForHome(jobId, { jobId }, connection, fetcher);
  assert(delivered?.state === "published");
  assertEquals(workers, 1);
  assertEquals(state.calls.filter(call => call.name === "publish_energy_planning_job").length, 1);
  assertEquals(wire(delivered.plan), wire(generateRulesPlan(input).plan));
});

Deno.test("an existing claimant and a different home never load or compute the job", async () => {
  const state = memoryJobs({ claimed: true });
  const noWorker: typeof fetch = () => { throw new Error("another owner holds the job"); };
  const receipt = await state.jobs.advanceForHome(jobId, { jobId }, connection, noWorker);
  assert(receipt?.pending);
  assertEquals(await state.jobs.advanceForHome("other-home", { jobId }, connection, noWorker), null);
  assert(!state.calls.some(call => call.name === "load_energy_planning_attempt"));
});

Deno.test("real complete-worker failures remain terminal and never publish partial results", async () => {
  const state = memoryJobs();
  const receipt = await state.jobs.advanceForHome(jobId, { jobId }, connection,
    () => Promise.resolve(Response.json({ error: "cpu_limit" }, { status: 546 })));
  assert(receipt?.state === "failed");
  assert(!state.calls.some(call => call.name === "publish_energy_planning_job"));
});

Deno.test("a superseded fence returns storage authority instead of the locally computed plan", async () => {
  const state = memoryJobs({supersededPublication:true});
  const receipt = await state.jobs.advanceForHome(jobId, {jobId}, connection, realWorker);
  assertEquals(receipt?.state, "superseded");
  assertEquals(state.publication(), undefined);
  assert(!state.calls.some(call => call.name === "fail_energy_planning_job"));
});

Deno.test("an old protocol job fails explicitly before invoking the rules worker", async () => {
  const state = memoryJobs({obsolete:true});
  const receipt = await state.jobs.advanceForHome(jobId, {jobId}, connection, () => {throw new Error("must not compute obsolete input");});
  assert(receipt?.state === "failed");
  assertEquals(receipt.code,"planner_upgraded");
});

Deno.test("delivery preserves distinct schema9 execution forecast and rejects conflicting snapshot identity", async () => {
  const full = rulesFixturePlan(mixedModeSnapshot());
  assertEquals(full.schema_version, 9);
  assert(storedPlan(full).execution_plan, "Different actual-demand trajectory cannot be discarded as a duplicate");
  const requests: Record<string, unknown>[] = [];
  const receipt: PlanningReceipt = { job_id: jobId, snapshot_id: full.snapshot_id,
    state: "published", pending: false, plan: storedPlan(full), plan_id: full.plan_id,
    source_hash: "source", exchange: { actual_slots_accepted: 4 } };
  const db = createClient("http://localhost:54321", "test-service", {
    auth: { persistSession: false }, global: { fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      return Response.json(body.p_home_id === jobId ? receipt : null);
    } },
  });
  const jobs = new PlanningJobs(db);
  const result = await jobs.findSnapshot(jobId, full.snapshot_id, "source");
  assert(result?.state === "published");
  assertEquals(result.plan, full);
  assertEquals(result?.source_hash, undefined);
  assertEquals((result as Record<string, unknown>).actual_slots_accepted, 4);
  await assertRejects(() => jobs.findSnapshot(jobId, full.snapshot_id, "changed"), PlanningJobError, "reused");
  assertEquals(await jobs.readForHome("other-home", jobId), null);
  assertEquals(requests.at(-1), { p_home_id: "other-home", p_job_id: jobId });
});
