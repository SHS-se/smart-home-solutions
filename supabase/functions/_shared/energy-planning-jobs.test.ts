import { assertEquals, assertRejects, assert } from "jsr:@std/assert@1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { PlanningJobs, PlanningJobError, type PlanningReceipt } from "./energy-planning-jobs.ts";
import { ENERGY_PLANNING_PROTOCOL } from "./energy-planning-protocol.ts";
import { OPTIMISATION_MODEL_VERSION, generateOptimisationPlanWithBatteryProjection } from "./planner/energy-optimisation.ts";
import { dispatchedEvSnapshot, mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { handleEnergyPlanningStep } from "./energy-planning-worker.ts";
import { expandStoredPlan, storedPlan } from "./stored-plan.ts";

const jobId = "11111111-1111-4111-8111-111111111111";
const input = { snapshot: dispatchedEvSnapshot(), now: "2026-08-20T08:55:00.000Z", price_archive: [] };
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const connection = { url: "https://planner.test", planningSecret: "test-secret" };
const context = { model_version: OPTIMISATION_MODEL_VERSION, request_id: "request-1", integration_version: "test",
  thermal_zones: [], fixed_revision: 0, observed_replan_request_id: null, replan_request_id: null, exchange: {} };

function memoryJobs(options: { steps?: number; lostCommit?: boolean; lostPublication?: boolean; claimed?: boolean } = {}) {
  let phase = "solving";
  let fence = 0;
  let steps = options.steps ?? 0;
  let owned = options.claimed ?? false;
  let continuation = { completed: [], rankings: [] } as import("./energy-planning-protocol.ts").EnergyPlanningContinuation;
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
      if (name === "claim_energy_planning_batch") {
        assertEquals(body.p_home_id, jobId);
        if (owned || receipt.state !== "pending") return Response.json(null);
        owned = true; fence++;
        return Response.json({ id: jobId, home_id: jobId, customer_id: jobId, snapshot_id: input.snapshot.snapshot_id,
          fence, steps, phase, protocol: ENERGY_PLANNING_PROTOCOL });
      }
      if (name === "load_energy_planning_batch") {
        assertEquals(body.p_fence, fence);
        return Response.json({ input, context, continuation });
      }
      if (name === "commit_energy_planning_batch") {
        assertEquals(body.steps, steps); assertEquals(body.fence, fence);
        assertEquals(body.home_id, jobId); assert(body.calls <= 8);
        steps += body.calls; phase = body.phase;
        continuation = { completed: [...continuation.completed, ...body.completed],
          rankings: [...continuation.rankings, ...body.rankings], ...body.continuation };
        owned = false;
        if (options.lostCommit) { options.lostCommit = false; return Response.json({ message: "reply lost", code: "XX000" }, {status: 500}); }
        return Response.json(receipt);
      }
      if (name === "publish_energy_planning_job") {
        assertEquals(phase, "assembling"); assertEquals(body.steps, steps);
        publication = body; owned = false;
        receipt = { job_id: jobId, snapshot_id: input.snapshot.snapshot_id, state: "published", pending: false,
          plan_id: body.current.plan_id, plan: body.current.plan };
        if (options.lostPublication) return Response.json({ message: "reply lost", code: "XX000" }, {status: 500});
        const { plan: _plan, ...publicationReceipt } = receipt;
        return Response.json(publicationReceipt); // SQL deliberately omits the full plan.
      }
      if (name === "fail_energy_planning_job") {
        owned = false;
        receipt = { job_id: jobId, snapshot_id: input.snapshot.snapshot_id,
          state: "failed", pending: false, code: body.code, detail: body.detail };
        return Response.json(receipt);
      }
      return Response.json([]); // Noncritical archives.
    } },
  });
  return { jobs: new PlanningJobs(db), calls, publication: () => publication, phase: () => phase,
    steps: () => steps, continuation: () => continuation };
}

Deno.test("durable owner resumes a job beyond the old lifetime and call cap, assembles in a fresh request", async () => {
  // Six hundred successful 900ms slices represent far more than120 seconds.
  // They are observable progress, not a reason to reject valid unfinished work.
  const state = memoryJobs({ steps: 600 });
  let workerCalls = 0;
  const fetcher: typeof fetch = (url, init) => {
    workerCalls++;
    return handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  };
  let receipt: PlanningReceipt | null = null;
  for (let request = 0; request < 30; request++) {
    const assembling = state.phase() === "assembling";
    const before = workerCalls;
    receipt = await state.jobs.advanceForHome(jobId, { jobId }, connection, fetcher);
    if (assembling) assertEquals(workerCalls, before, "assembly must not invoke a worker");
    if (receipt?.state !== "pending") break;
  }
  assert(receipt?.state === "published");
  const expected = generateOptimisationPlanWithBatteryProjection(input.snapshot, new Date(input.now), []);
  assertEquals(wire(receipt.plan), wire(expected.plan));
  const current = state.publication()!.current as { plan: Parameters<typeof expandStoredPlan>[0] };
  assertEquals(wire(expandStoredPlan(current.plan)), wire(expected.plan));
  assert(state.steps() > 600);
  assertEquals(state.calls.filter(call => call.name === "read_energy_planning_job").length, 2,
    "successful omitted-plan publication must use the verified locally assembled plan");
});

Deno.test("lost checkpoint and publication replies recover without failing or appending twice", async () => {
  const state = memoryJobs({ lostCommit: true, lostPublication: true });
  const fetcher: typeof fetch = (url, init) => handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  let receipt: PlanningReceipt | null = null;
  for (let request = 0; request < 30; request++) {
    receipt = await state.jobs.advanceForHome(jobId, { snapshotId: input.snapshot.snapshot_id }, connection, fetcher);
    assertEquals((receipt as Record<string, unknown>).device_configuration, [{ key: "ev", control_type: "amps" }]);
    assertEquals((receipt as Record<string, unknown>).home_configuration, { battery: { included: true } });
    if (receipt?.state !== "pending") break;
  }
  assert(receipt?.state === "published");
  assert(!state.calls.some(call => call.name === "fail_energy_planning_job"));
  const before = state.steps();
  const delivered = await state.jobs.advanceForHome(jobId, { jobId }, connection, fetcher);
  assert(delivered?.state === "published");
  assertEquals(state.steps(), before);
  const expected = generateOptimisationPlanWithBatteryProjection(input.snapshot, new Date(input.now), []).plan;
  assertEquals(wire(delivered.plan), wire(expected));
});

Deno.test("an existing claimant and a different home never load or compute the job", async () => {
  const state = memoryJobs({ claimed: true });
  const noWorker: typeof fetch = () => { throw new Error("another owner holds the job"); };
  const receipt = await state.jobs.advanceForHome(jobId, { jobId }, connection, noWorker);
  assert(receipt?.pending);
  assertEquals(await state.jobs.advanceForHome("other-home", { jobId }, connection, noWorker), null);
  assert(!state.calls.some(call => call.name === "load_energy_planning_batch"));
});

Deno.test("real worker failures remain terminal without checkpointing them", async () => {
  const state = memoryJobs();
  const receipt = await state.jobs.advanceForHome(jobId, { jobId }, connection,
    () => Promise.resolve(Response.json({ error: "cpu_limit" }, { status: 546 })));
  assert(receipt?.state === "failed");
  assert(!state.calls.some(call => call.name === "commit_energy_planning_batch"));
});

Deno.test("delivery scopes the job, expands schema9 and rejects conflicting snapshot identity", async () => {
  const snapshot = mixedModeSnapshot();
  const full = generateOptimisationPlanWithBatteryProjection(snapshot, new Date(snapshot.captured_at), []).plan;
  assertEquals(full.schema_version, 9);
  assertEquals(storedPlan(full).execution_plan, undefined);
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
