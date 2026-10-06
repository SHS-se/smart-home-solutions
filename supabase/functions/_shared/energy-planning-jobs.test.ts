import { assertEquals, assertRejects, assert } from "jsr:@std/assert@1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { PlanningJobs, PlanningJobError, type PlanningReceipt } from "./energy-planning-jobs.ts";
import { ENERGY_PLANNING_PROTOCOL, type EnergyPlanningContinuation } from "./energy-planning-protocol.ts";
import { OPTIMISATION_MODEL_VERSION, generateOptimisationPlanWithBatteryProjection } from "./planner/energy-optimisation.ts";
import { dispatchedEvSnapshot, mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { expandStoredPlan, storedPlan } from "./stored-plan.ts";

const jobId = "11111111-1111-4111-8111-111111111111";
const input = { snapshot: dispatchedEvSnapshot(), now: "2026-08-20T08:55:00.000Z", price_archive: [] };
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

Deno.test("durable owner resumes committed results after a lost commit reply and assembles separately", async () => {
  let phase = "solving", step = 0, fence = 0, published = false;
  let lostCommitReply = false;
  const continuation: EnergyPlanningContinuation = { completed: [], rankings: [] };
  const calls: string[] = [];
  let publication: Record<string, unknown> | null = null;
  const db = createClient("http://localhost:54321", "test-service", {
    auth: { persistSession: false }, global: { fetch: async (url, init) => {
      const name = String(url).split("/").at(-1)!;
      calls.push(name);
      const body = JSON.parse(String(init?.body));
      if (name === "claim_energy_planning_step") return Response.json(published ? null : {
        id: jobId, home_id: jobId, customer_id: jobId, snapshot_id: input.snapshot.snapshot_id,
        phase, step, fence: ++fence, protocol: ENERGY_PLANNING_PROTOCOL, input,
        context: { model_version: OPTIMISATION_MODEL_VERSION, request_id: "request-1", integration_version: "test",
          thermal_zones: [], fixed_revision: 0, observed_replan_request_id: null, replan_request_id: null, exchange: {} },
        continuation: { checkpoint: continuation.checkpoint, ranking_checkpoint: continuation.ranking_checkpoint },
        completed: continuation.completed, rankings: continuation.rankings,
      });
      if (name === "commit_energy_planning_step") {
        assertEquals(body.step, step); assertEquals(body.fence, fence);
        // The durable commit appends deltas; earlier results never appear in
        // the checkpoint body. A network loss happens AFTER it commits.
        assertEquals(body.continuation.completed, undefined);
        assertEquals(body.continuation.rankings, undefined);
        continuation.completed.push(...body.completed);
        continuation.rankings.push(...body.rankings);
        continuation.checkpoint = body.continuation.checkpoint;
        continuation.ranking_checkpoint = body.continuation.ranking_checkpoint;
        phase = body.phase; step++;
        if (!lostCommitReply) {
          lostCommitReply = true;
          return Response.json({ code: "connection_lost", message: "Commit reply lost" }, { status: 503 });
        }
        return Response.json({ state: "pending", pending: true, job_id: jobId });
      }
      if (name === "publish_energy_planning_job") {
        assertEquals(phase, "assembling"); assertEquals(body.step, step);
        publication = body; published = true;
        return Response.json({ state: "published", pending: false, job_id: jobId });
      }
      // Noncritical forecast/estimate archive writes.
      return Response.json(null);
    } },
  });
  const jobs = new PlanningJobs(db);
  await assertRejects(() => jobs.advance(jobId), PlanningJobError, "Commit reply lost");
  assert(lostCommitReply); assert(step > 0);
  for (let count = 0; !published && count < 100; count++) await jobs.advance(jobId);
  assert(published);
  const current = publication!.current as { plan: Parameters<typeof expandStoredPlan>[0] };
  const expected = generateOptimisationPlanWithBatteryProjection(input.snapshot, new Date(input.now), []);
  assertEquals(wire(expandStoredPlan(current.plan)), wire(expected.plan));
  const publishAt = calls.indexOf("publish_energy_planning_job");
  assert(publishAt > 0);
  assertEquals(calls[publishAt - 1], "claim_energy_planning_step");
  assert(!calls.includes("fail_energy_planning_job"));
  const before = calls.length;
  await jobs.advance(jobId); // duplicate wake cannot republish
  assertEquals(calls.slice(before), ["claim_energy_planning_step"]);
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
