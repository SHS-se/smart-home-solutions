import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { OPTIMISATION_MODEL_VERSION, type OptimisationPlan } from "./planner/energy-optimisation.ts";
import { ENERGY_PLANNING_PROTOCOL, type EnergyPlanningInput, type EnergyPlanningContinuation } from "./energy-planning-protocol.ts";
import { energyPlanningStep, assembleOptimisationPlan, createPlanningBudget } from "./energy-planning-step.ts";
import { buildThermalProjection, type ProjectionZoneInput } from "./thermal-training.ts";
import { storedPlan, expandStoredPlan } from "./stored-plan.ts";
import { sha256Hex } from "./ha-device-auth.ts";
import { describeThrown } from "./ha-api-contract.ts";
import { priceEstimateRows } from "./price-estimate-record.ts";

export const PLANNING_EXCHANGE_VERSION = 2;
const SLICE_MS = 900;

type PublishedPlan = OptimisationPlan & { thermal_projection?: NonNullable<ReturnType<typeof buildThermalProjection>> };

type ReceiptIdentity = {
  job_id: string;
  snapshot_id: string;
  source_hash?: string;
  exchange?: Record<string, unknown>;
};
export type PlanningReceipt = ReceiptIdentity & (
  | { state: "pending"; pending: true; retry_after_ms: number }
  | { state: "published"; pending: false; plan: PublishedPlan; plan_id: string }
  | { state: "superseded"; pending: false }
  | { state: "failed"; pending: false; code: string; detail: string }
);
export interface PlanningContext {
  request_id: string;
  integration_version: string | null;
  thermal_zones: ProjectionZoneInput[];
  fixed_revision: number;
  observed_replan_request_id: string | null;
  replan_request_id: string | null;
  exchange: Record<string, unknown>;
}
interface PreparedPlanningJob {
  homeId: string; customerId: string; snapshotId: string; sourceHash: string;
  input: EnergyPlanningInput; context: PlanningContext;
}
interface ClaimedJob {
  id: string; home_id: string; customer_id: string; snapshot_id: string;
  protocol: number; fence: number; step: number; phase: "solving" | "assembling";
  input: EnergyPlanningInput;
  context: PlanningContext & { model_version: string };
  continuation: Omit<EnergyPlanningContinuation, "completed" | "rankings">;
  completed: EnergyPlanningContinuation["completed"];
  rankings: EnergyPlanningContinuation["rankings"];
}
export class PlanningJobError extends Error {
  constructor(readonly code: string, message: string, readonly status = 500) {
    super(message); this.name = "PlanningJobError";
  }
}

/** Owns the complete household job lifecycle; callers never coordinate phases. */
export class PlanningJobs {
  constructor(private readonly db: SupabaseClient) {}

  private async rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(name, body);
    if (error) {
      const conflict = error.code === "22023" || error.code === "40001";
      throw new PlanningJobError(conflict ? "planning_submission_conflict" : "planning_storage_failed", error.message, conflict ? 409 : 500);
    }
    return data as T;
  }

  private delivery(receipt: PlanningReceipt | null): PlanningReceipt | null {
    if (!receipt) return null;
    if (receipt.state === "published") receipt = { ...receipt, plan: expandStoredPlan(receipt.plan) };
    const { exchange, source_hash: _hash, ...delivery } = receipt;
    return { ...exchange, ...delivery };
  }

  async accept(prepared: PreparedPlanningJob): Promise<PlanningReceipt> {
    const receipt = await this.rpc<PlanningReceipt>("accept_energy_planning_job", {
      home_id: prepared.homeId, customer_id: prepared.customerId,
      snapshot_id: prepared.snapshotId, source_hash: prepared.sourceHash,
      input: prepared.input, context: { ...prepared.context, model_version: OPTIMISATION_MODEL_VERSION },
      protocol: ENERGY_PLANNING_PROTOCOL,
    });
    return this.delivery(receipt)!;
  }

  async findSnapshot(homeId: string, snapshotId: string, sourceHash: string): Promise<PlanningReceipt | null> {
    const receipt = await this.rpc<PlanningReceipt | null>("read_energy_planning_job", {
      p_home_id: homeId, p_snapshot_id: snapshotId,
    });
    if (receipt && receipt.source_hash !== sourceHash) {
      throw new PlanningJobError("planning_snapshot_conflict", "Snapshot identity was reused with different input", 409);
    }
    return this.delivery(receipt);
  }

  async readSubmissionForHome(homeId: string, snapshotId: string): Promise<PlanningReceipt | null> {
    return this.delivery(await this.rpc<PlanningReceipt | null>("read_energy_planning_job", {
      p_home_id: homeId, p_snapshot_id: snapshotId,
    }));
  }

  async readForHome(homeId: string, jobId: string): Promise<PlanningReceipt | null> {
    return this.delivery(await this.rpc<PlanningReceipt | null>("read_energy_planning_job", {
      p_home_id: homeId, p_job_id: jobId,
    }));
  }

  async advance(jobId: string): Promise<void> {
    const loadStarted = performance.now();
    const job = await this.rpc<ClaimedJob | null>("claim_energy_planning_step", { p_job_id: jobId });
    if (!job) return;
    const identity = { job_id: job.id, fence: job.fence, step: job.step };
    const started = performance.now();
    const continuation = { ...job.continuation, completed: job.completed, rankings: job.rankings };
    console.info("[ENERGY-PLANNING-JOB] started", {
      ...identity, request_id: job.context.request_id, phase: job.phase,
      stage: continuation.checkpoint?.next ?? "replay",
      auctions: job.completed.length, rankings: job.rankings.length,
      load_ms: Math.round(started - loadStarted), memory: Deno.memoryUsage(),
    });
    if (job.protocol !== ENERGY_PLANNING_PROTOCOL || job.context.model_version !== OPTIMISATION_MODEL_VERSION) {
      await this.rpc("fail_energy_planning_job", { ...identity, code: "planner_upgraded", detail: "Planner version changed while the job was running. Request a new replan." });
      return;
    }
    try {
      if (job.phase === "solving") {
        const result = energyPlanningStep(job.input, continuation, createPlanningBudget(SLICE_MS));
        const { completed, rankings, done, ...cursor } = result;
        const computed = performance.now();
        const receipt = await this.rpc<PlanningReceipt | null>("commit_energy_planning_step", {
          ...identity, completed, rankings, continuation: cursor,
          phase: done ? "assembling" : "solving",
        });
        console.info("[ENERGY-PLANNING-JOB] checkpoint committed", {
          ...identity, phase: done ? "assembling" : "solving", committed: receipt !== null,
          finished: completed.length, ranked: rankings.length,
          compute_ms: Math.round(computed - started), commit_ms: Math.round(performance.now() - computed),
          memory: Deno.memoryUsage(),
        });
        return;
      }
      const planned = assembleOptimisationPlan(job.input, job.completed, job.rankings);
      let generated: PublishedPlan = planned.plan;
      const snapshot = job.input.snapshot;
      if (job.context.thermal_zones.length) {
        const slots = generated.plans.priority.slots;
        const projection = buildThermalProjection(snapshot.slots.map(slot => slot.start),
          snapshot.outdoor_temperature_c as number[], job.context.thermal_zones.map(zone => ({
            ...zone, planned_power_w: slots.map(slot => slot.room_heating_w?.[zone.key] ?? 0),
          })), snapshot.solar_irradiance_w_per_m2 ?? null);
        if (projection) generated = { ...generated, thermal_projection: projection };
      }
      const inputHash = await sha256Hex(JSON.stringify(snapshot));
      const ack = { generation_request_id: job.context.request_id,
        plan_schema_version: generated.schema_version, ha_ack_status: "pending",
        ha_acknowledged_at: null, ha_integration_version: job.context.integration_version,
        ha_ack_request_id: null, ha_ack_error: null };
      const current = {
        ...ack, fixed_plan_generation_revision: job.context.fixed_revision, replan_error: null,
        home_id: job.home_id, customer_id: job.customer_id, snapshot_id: snapshot.snapshot_id,
        plan_id: generated.plan_id, input_hash: inputHash, captured_at: snapshot.captured_at,
        issued_at: generated.issued_at, valid_until: generated.valid_until, binding_until: generated.binding_until,
        status: generated.status, model_version: generated.model_version, snapshot,
        plan: storedPlan(generated), battery_projection: planned.battery_projection,
        updated_at: new Date().toISOString(),
      };
      const run = { ...ack, id: generated.plan_id, customer_id: job.customer_id,
        home_id: job.home_id, snapshot_id: snapshot.snapshot_id, input_hash: inputHash,
        issued_at: generated.issued_at, status: generated.status, model_version: generated.model_version,
        summary: compactPlanSummary(generated), validation_errors: generated.validation_errors };
      const assembled = performance.now();
      const receipt = await this.rpc<{ state: PlanningReceipt["state"] } | null>("publish_energy_planning_job", { ...identity, current, run });
      console.info("[ENERGY-PLANNING-JOB] publication finished", {
        ...identity, request_id: job.context.request_id, state: receipt?.state ?? "lost_lease",
        assembly_ms: Math.round(assembled - started), publish_ms: Math.round(performance.now() - assembled),
        memory: Deno.memoryUsage(),
      });
      if (receipt?.state === "published") {
        try { await this.archive(job, generated); }
        catch (error) { console.error("[ENERGY-PLANNING-JOB] archive failed", { job_id: job.id, detail: describeThrown(error) }); }
      }
    } catch (error) {
      // Storage/transport failures leave the leased checkpoint recoverable. A
      // deterministic planner error is terminal and scoped to this job only.
      if (error instanceof PlanningJobError) throw error;
      const detail = describeThrown(error);
      console.error("[ENERGY-PLANNING-JOB] failed", { ...identity, phase: job.phase, detail });
      await this.rpc("fail_energy_planning_job", {
        ...identity, code: job.phase === "assembling" ? "assembly_failed" : "invalid_snapshot", detail,
      });
    }
  }

  private async archive(job: ClaimedJob, plan: OptimisationPlan): Promise<void> {
    const snapshot = job.input.snapshot;
    const estimates = priceEstimateRows({ homeId: job.home_id, timezone: snapshot.timezone,
      issuedAt: plan.issued_at, slots: snapshot.slots,
      shadowImportSekPerKwh: plan.price_outlook?.shadow_import_sek_per_kwh, basis: plan.price_outlook?.level_basis });
    if (estimates.length) {
      const { error } = await this.db.from("energy_price_estimate_days").upsert(estimates, { onConflict: "home_id,issued_on,target_day" });
      if (error) console.error("[ENERGY-PLANNING-JOB] price estimate archive failed", { job_id: job.id, code: error.code });
    }
    const issuedAt = new Date(snapshot.captured_at);
    const bucket = new Date(issuedAt);
    bucket.setUTCHours(Math.floor(bucket.getUTCHours() / 6) * 6, 0, 0, 0);
    const outdoor = snapshot.outdoor_temperature_c;
    const { error } = await this.db.from("energy_optimisation_forecast_runs").upsert({
      customer_id: job.customer_id, home_id: job.home_id, issued_at: issuedAt.toISOString(), issued_bucket: bucket.toISOString(),
      horizon_start: snapshot.slots[0]?.start ?? snapshot.captured_at, slot_minutes: snapshot.slot_minutes, slot_count: snapshot.slots.length,
      series: {
        pv_forecast_w: snapshot.slots.map(slot => slot.pv_forecast_w),
        base_load_forecast_w: snapshot.slots.map(slot => slot.base_load_forecast_w),
        outdoor_temperature_c: snapshot.slots.map((_, index) => outdoor?.[index] ?? null),
        import_price_sek_per_kwh: snapshot.slots.map(slot => slot.import_price_sek_per_kwh),
        export_price_sek_per_kwh: snapshot.slots.map(slot => slot.export_price_sek_per_kwh),
      }, sources: snapshot.sources,
    }, { onConflict: "home_id,issued_bucket", ignoreDuplicates: true });
    if (error) console.error("[ENERGY-PLANNING-JOB] forecast archive failed", { job_id: job.id, code: error.code });
  }
}

const compactPlanSummary = (
  plan: OptimisationPlan,
) => ({
  binding_until: plan.binding_until,
  valid_until: plan.valid_until,
  policy: plan.policy,
  sources: plan.sources,
  pv_calibration: plan.pv_calibration,
  battery: plan.battery,
  grid: plan.grid,
  services: plan.services,
  device_models: plan.device_models.map((model) => ({
    key: model.key,
    name: model.name,
    statistic_id: model.statistic_id,
    category: model.category,
    suggested_load_type: model.suggested_load_type,
    load_type: model.load_type,
    planning_role: model.planning_role,
    control_type: model.control_type,
    active_power_w: model.active_power_w,
    profile_sample_count: model.profile_sample_count,
    forecast_method: model.forecast_method,
  })),
  service_requirement_sample_days: plan.service_requirement_sample_days,
  plans: Object.fromEntries(
    Object.entries(plan.plans).map(([key, value]) => [key, {
      status: value.status,
      validation_errors: value.validation_errors,
      summary: value.summary,
      service_slots: value.service_slots,
      service_currents_a: value.service_currents_a,
      service_inhibited_slots: value.service_inhibited_slots,
    }]),
  ),
});
