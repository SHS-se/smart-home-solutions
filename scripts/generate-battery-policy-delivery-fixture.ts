/** Synthetic exchange fixture; never physical/native commissioning evidence. */
import { mixedModeSnapshot } from "./generate-ha-plan-fixture.ts";
import { generateOptimisationPlanWithBatteryProjection } from "../supabase/functions/_shared/energy-optimisation.ts";
import {
  buildBatteryPolicyRequest,
  canonicalHash,
  type StoredBatteryGeneration,
} from "../supabase/functions/_shared/battery-policy-exchange.ts";
import { compileBatteryExecutionPolicy } from "../supabase/functions/_shared/battery-execution-policy.ts";

export function policyExchangeFixture() {
  const snapshot = mixedModeSnapshot();
  snapshot.operating_scope.modes.$battery = "control_verification";
  const now = Date.parse(snapshot.captured_at);
  const result = generateOptimisationPlanWithBatteryProjection(
    snapshot,
    new Date(now),
  );
  if (result.battery_projection.status !== "ready") {
    throw new Error(JSON.stringify(result.battery_projection));
  }
  const p = result.battery_projection;
  const battery = p.problem.plant.equipment[0];
  if (battery.kind !== "battery") throw new Error("battery required");
  const request = {
    api_version: 1 as const,
    request_id: "test-delivery-request",
    plan_id: result.plan.plan_id,
    snapshot_id: snapshot.snapshot_id,
    purpose: "verification" as const,
    native_context: {
      config_revision: "test-config",
      catalog_revision: "test-catalog",
      evidence_id: "test-only-response-declaration",
      response_model_revision: "pv-first-v1" as const,
      energy_basis: "usable_kwh_above_min_soc" as const,
      source_cut_ms: now,
      valid_until_ms: Date.parse(p.problem.intervals[0].end),
      supply_scope: { kind: "whole_house" as const },
      operations: [{
        id: "hold",
        operation: "hold" as const,
        charge_limit_w: 0,
        discharge_limit_w: 0,
      }, {
        id: "supply",
        operation: "supply_house" as const,
        charge_limit_w: 0,
        discharge_limit_w: 4000,
      }, {
        id: "charge",
        operation: "grid_charge" as const,
        charge_limit_w: 4000,
        discharge_limit_w: 0,
      }],
      reference_id: "hold",
      domain: {
        energy_kwh: [battery.state_kwh.min, battery.state_kwh.max],
        pv_w: [0, 10000],
        residual_load_w: [0, 10000],
      },
      future_permissions: p.problem.intervals.map((i) => ({
        start: i.start,
        available: true,
        grid_charge_allowed: true,
        battery_export_allowed: false,
      })),
    },
  };
  const stored: StoredBatteryGeneration = {
    plan_id: result.plan.plan_id,
    snapshot_id: snapshot.snapshot_id,
    plan: result.plan,
    battery_projection: p,
    ha_ack_status: "accepted",
    fixed_plan_revision: 0,
    fixed_plan_generation_revision: 0,
  };
  return { now, stored, request };
}
export function policyDeliveryFixture() {
  const { now, stored, request } = policyExchangeFixture();
  const built = buildBatteryPolicyRequest(stored, request, now);
  if (built.status !== "ready") throw new Error(JSON.stringify(built));
  const compiled = compileBatteryExecutionPolicy(built.request);
  if (compiled.status !== "compiled") throw new Error(JSON.stringify(compiled));
  return {
    synthetic: true,
    now,
    request,
    delivery: {
      schema: "battery-policy-delivery-v1",
      request_id: request.request_id,
      plan_id: request.plan_id,
      snapshot_id: request.snapshot_id,
      purpose: "verification",
      control_authority: false,
      status: "delivered",
      policy: compiled.policy,
      outlook: compiled.outlook,
      native_context: request.native_context,
      context_hash: canonicalHash(request.native_context),
      energy_basis: "usable_kwh_above_min_soc",
      energy_origin_kwh: built.energy_origin_kwh,
    },
  };
}
if (import.meta.main) {
  await Deno.writeTextFile(
    "contracts/ha-api/fixtures/battery-policy-delivery.json",
    JSON.stringify(policyDeliveryFixture(), null, 2) + "\n",
  );
}
