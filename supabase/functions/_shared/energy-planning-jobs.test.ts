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

Deno.test("two-function owner downloads input once and publishes once without checkpoint writes", async () => {
  let published = false;
  const calls: string[] = [];
  let publication: Record<string, unknown> | null = null;
  const db = createClient("http://localhost:54321", "test-service", {
    auth: { persistSession: false }, global: { fetch: async (url, init) => {
      const name = String(url).split("/").at(-1)!;
      calls.push(name);
      const body = JSON.parse(String(init?.body));
      if (name === "claim_energy_planning_job") return Response.json(published ? null : {
        id: jobId, home_id: jobId, customer_id: jobId, snapshot_id: input.snapshot.snapshot_id,
        fence: 1, protocol: ENERGY_PLANNING_PROTOCOL, input, deadline_at: new Date(Date.now()+10_000).toISOString(),
        context: { model_version: OPTIMISATION_MODEL_VERSION, request_id: "request-1", integration_version: "test",
          thermal_zones: [], fixed_revision: 0, observed_replan_request_id: null, replan_request_id: null, exchange: {} },
      });
      if (name === "publish_energy_planning_job") {
        publication = body; published = true;
        return Response.json({ state: "published", pending: false, job_id: jobId, snapshot_id: input.snapshot.snapshot_id });
      }
      return Response.json(null); // noncritical archives
    } },
  });
  const jobs = new PlanningJobs(db);
  const connection = { url: "https://planner.test", planningSecret: "test-secret", deadline: performance.now()+10_000 };
  const fetcher: typeof fetch = (url, init) => handleEnergyPlanningStep(new Request(url, init), connection.planningSecret);
  const receipt = await jobs.execute(jobId, connection, fetcher);
  assert(receipt?.state === "published");
  const current = publication!.current as { plan: Parameters<typeof expandStoredPlan>[0] };
  const expected = generateOptimisationPlanWithBatteryProjection(input.snapshot, new Date(input.now), []);
  assertEquals(wire(expandStoredPlan(current.plan)), wire(expected.plan));
  assertEquals(wire(receipt.plan), wire(expected.plan));
  assertEquals(calls.slice(0, 2), ["claim_energy_planning_job", "publish_energy_planning_job"]);
  assertEquals(calls.filter(name => name === "claim_energy_planning_job").length, 1);
  assert(!calls.includes("commit_energy_planning_step"));
  const before = calls.length;
  assertEquals(await jobs.execute(jobId, connection, fetcher), null);
  assertEquals(calls.slice(before), ["claim_energy_planning_job"]);
});

Deno.test("expired request is terminal without issuing a solve or publication", async () => {
  const calls: string[] = [];
  const db = createClient("http://localhost:54321", "test-service", {
    auth: { persistSession: false }, global: { fetch: async (url, init) => {
      const name = String(url).split("/").at(-1)!; calls.push(name);
      if (name === "claim_energy_planning_job") return Response.json({
        id: jobId, home_id: jobId, customer_id: jobId, input,
        protocol: ENERGY_PLANNING_PROTOCOL, fence: 1, deadline_at: new Date(Date.now()-1).toISOString(),
        context: { model_version: OPTIMISATION_MODEL_VERSION, request_id: "request-1" },
      });
      const body = JSON.parse(String(init?.body));
      assertEquals(body.code, "planning_deadline_exceeded");
      return Response.json({ job_id: jobId, snapshot_id: input.snapshot.snapshot_id,
        pending: false, state: "failed", code: body.code, detail: body.detail });
    } },
  });
  const receipt = await new PlanningJobs(db).execute(jobId, { url: "https://planner.test", planningSecret: "secret", deadline: performance.now()-1 },
    () => { throw new Error("No solve after deadline"); });
  assert(receipt?.state === "failed");
  assertEquals(receipt.code, "planning_deadline_exceeded");
  assertEquals(calls, ["claim_energy_planning_job", "fail_energy_planning_job"]);
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
