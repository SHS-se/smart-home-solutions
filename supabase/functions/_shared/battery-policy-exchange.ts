import { conversionSchema } from "./battery-conversion.ts";
/** Device-authenticated delivery boundary. Compiling economics grants no control authority. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { type BatteryProjection } from "./battery-dispatch-projection.ts";
import {
  batterySupplyScopeSchema,
  proportionalSupply,
  SOLAR_ATTRIBUTION,
} from "./battery-supply.ts";
import {
  type BatteryExecutionRequest,
  compileBatteryExecutionPolicy,
  executionOperationSchema,
} from "./battery-execution-policy.ts";
import { parseHouseholdProblem } from "./household-case.ts";
import type { OptimisationPlan } from "./energy-optimisation.ts";

const id = z.string().min(1).max(128);
const power = z.number().finite().min(0).max(1e6);
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.tuple([power, power]).refine(([a, b]) => a <= b);
export const nativePolicyContextSchema = z.object({
  config_revision: id,
  catalog_revision: id,
  evidence_id: id,
  response_model_revision: z.enum(["pv-first-v1", "pv-first-dc-v2"]),
  conversion: conversionSchema.optional(),
  energy_basis: z.literal("usable_kwh_above_min_soc"),
  source_cut_ms: stamp,
  valid_until_ms: stamp,
  supply_scope: batterySupplyScopeSchema,
  operations: z.array(executionOperationSchema).min(1).max(12),
  reference_id: id,
  domain: z.object({ energy_kwh: range, pv_w: range, residual_load_w: range })
    .strict(),
  future_permissions: z.array(
    z.object({
      start: z.string().datetime(),
      available: z.boolean(),
      grid_charge_allowed: z.boolean(),
      battery_export_allowed: z.boolean(),
    }).strict(),
  ).min(1).max(288),
}).strict();
export const batteryPolicyExchangeSchema = z.object({
  api_version: z.literal(1),
  request_id: id,
  plan_id: z.string().uuid(),
  snapshot_id: z.string().uuid(),
  purpose: z.literal("verification"),
  native_context: nativePolicyContextSchema.nullable(),
}).strict();
export interface StoredBatteryGeneration {
  plan_id: string;
  snapshot_id: string;
  ha_ack_status: string;
  plan: OptimisationPlan;
  battery_projection: BatteryProjection | null;
  fixed_plan_revision: number;
  fixed_plan_generation_revision: number;
}
export const canonicalHash = (value: unknown): string => {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
      ? Object.fromEntries(
        Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map((
          [k, x],
        ) => [k, canonical(x)]),
      )
      : v;
  return `sha256:${
    createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
  }`;
};
const blocked = (...reasons: string[]) => ({
  status: "blocked" as const,
  reasons,
});

/** No timestamp rebasing: the source cut still belongs to the real generation. */
export function buildBatteryPolicyRequest(
  stored: StoredBatteryGeneration,
  input: unknown,
  now: number,
):
  | {
    status: "ready";
    request: BatteryExecutionRequest;
    energy_origin_kwh: number;
    context_hash: string;
  }
  | { status: "blocked"; reasons: string[] } {
  const parsed = batteryPolicyExchangeSchema.safeParse(input);
  if (!parsed.success) return blocked("invalid_request");
  const body = parsed.data;
  if (
    body.plan_id !== stored.plan_id ||
    body.snapshot_id !== stored.snapshot_id ||
    stored.plan.plan_id !== stored.plan_id ||
    stored.plan.snapshot_id !== stored.snapshot_id
  ) return blocked("superseded_plan");
  if (stored.ha_ack_status !== "accepted") {
    return blocked("plan_not_acknowledged");
  }
  if (
    stored.fixed_plan_generation_revision !== stored.fixed_plan_revision ||
    stored.plan.fixed_plan
  ) return blocked("fixed_plan_authority");
  const p = stored.battery_projection;
  if (!p) return blocked("projection_unavailable");
  if (p.status === "unsupported") return blocked(...p.reasons);
  if (
    p.provenance.snapshot_id !== stored.snapshot_id ||
    p.provenance.issued_at !== stored.plan.issued_at ||
    stored.plan.status !== "ready"
  ) return blocked("projection_source_mismatch");
  if (p.provenance.branch === "priority" || !p.provenance.operating_scope) {
    return blocked("operating_scope_required");
  }
  const mode = p.provenance.operating_scope.modes.$battery;
  if (
    (p.provenance.branch === "execution" && mode !== "controlling") ||
    (p.provenance.branch === "battery_verification" &&
      mode !== "control_verification")
  ) return blocked("battery_mode_mismatch");
  const problem = parseHouseholdProblem(p.problem);
  const from = Date.parse(problem.intervals[0].start),
    boundary = Date.parse(problem.intervals[0].end);
  if (
    !Number.isSafeInteger(now) || now < from || now >= boundary ||
    now >= Date.parse(stored.plan.valid_until)
  ) return blocked("source_quarter_expired");
  const c = body.native_context;
  if (!c) return blocked("native_context_required");
  if (c.evidence_id.startsWith("synthetic")) {
    return blocked("native_model_evidence_required");
  }
  if (c.source_cut_ms !== from || c.valid_until_ms <= now) {
    return blocked("native_context_expired_or_different_cut");
  }
  if ((c.response_model_revision === "pv-first-dc-v2") !== !!c.conversion) {
    return blocked("conversion_model_basis_mismatch");
  }
  const b = problem.plant.equipment[0];
  if (b?.kind !== "battery" || !stored.plan.battery) {
    return blocked("battery_source_missing");
  }
  if (
    c.domain.energy_kwh[0] < b.state_kwh.min ||
    c.domain.energy_kwh[1] > b.state_kwh.max
  ) return blocked("energy_domain_outside_plant");
  if (
    c.future_permissions.length !== problem.intervals.length ||
    c.future_permissions.some((perm, i) =>
      perm.start !== problem.intervals[i].start
    )
  ) return blocked("future_permissions_mismatch");
  if (c.conversion) {
    b.conversion = c.conversion as NonNullable<typeof b.conversion>;
  }
  const originalExport = [...b.export_allowed];
  for (let i = 0; i < problem.intervals.length; i++) {
    b.available[i] = b.available[i] && c.future_permissions[i].available;
    b.grid_charge_allowed[i] = b.grid_charge_allowed[i] &&
      c.future_permissions[i].grid_charge_allowed;
    b.export_allowed[i] = b.export_allowed[i] &&
      c.future_permissions[i].battery_export_allowed;
  }
  const scope = c.supply_scope;
  const sourcePlan = mode === "controlling"
    ? stored.plan.execution_plan
    : stored.plan;
  if (
    c.response_model_revision === "pv-first-dc-v2" &&
    canonicalHash(scope) !==
      canonicalHash(sourcePlan?.battery_supply_scope ?? null)
  ) return blocked("planner_supply_scope_mismatch");
  const configured = Object.keys(p.provenance.operating_scope.device_owners)
    .sort();
  if (
    scope.kind === "selected" &&
    scope.planned_device_keys.some((key) => !configured.includes(key))
  ) return blocked("unknown_planned_supply_member");
  const bounds: number[] = [];
  for (let i = 0; i < problem.intervals.length; i++) {
    const row = p.provenance.final_demand[i];
    if (!row) return blocked("partition_unavailable");
    const components = { ...row.device_loads_w };
    for (
      const [key, demand] of Object.entries(
        p.provenance.operating_scope.external_demands,
      )
    ) {
      if (key in components) return blocked("overlapping_partition");
      components[key] = i === 0 && demand.recent_observation
        ? demand.recent_observation.average_w
        : demand.forecast_w_by_slot[i];
    }
    if (
      configured.some((key) => !(key in components)) ||
      Object.keys(components).some((key) => !configured.includes(key)) ||
      Object.values(components).some((w) => !Number.isFinite(w) || w < 0)
    ) return blocked("partition_unavailable");
    const base = row.house_w -
      Object.values(components).reduce((a, b) => a + b, 0);
    // Match the projection reconciliation tolerance; never hide real excess.
    if (base < -1e-6) return blocked("partition_exceeds_house");
    const gross = scope.kind === "whole_house"
      ? row.house_w
      : scope.kind === "none"
      ? 0
      : (scope.include_base ? Math.max(0, base) : 0) +
        scope.planned_device_keys.reduce((a, key) => a + components[key], 0);
    bounds.push(
      proportionalSupply(
        row.house_w,
        problem.plant.pv_w[i],
        Math.min(row.house_w, gross),
      )
        .houseSupplyBoundW,
    );
  }
  const contextHash = canonicalHash(c),
    tariff = canonicalHash(problem.economics);
  const identity = {
    policy_id: canonicalHash({ source: p, context: c }),
    revision: now,
    battery_id: b.id,
    intent_revision: problem.identity.intent_revision,
    plant_revision: canonicalHash({
      plant: problem.plant,
      config: c.config_revision,
    }),
    scope_revision: canonicalHash({
      ...(c.response_model_revision === "pv-first-dc-v2"
        ? { native: c.catalog_revision }
        : {}),
      operating: p.provenance.operating_scope,
      supply: scope,
      config: c.config_revision,
    }),
    external_scenario_revision: canonicalHash(p.provenance.final_demand),
    tariff_revision: tariff,
    response_model_revision: c.response_model_revision,
    catalog_revision: c.catalog_revision,
  };
  const until = Math.min(boundary, c.valid_until_ms);
  const energyOrigin = stored.plan.battery.min_soc *
    stored.plan.battery.capacity_kwh;
  const request: BatteryExecutionRequest = {
    problem,
    identity,
    supply_scope: scope as BatteryExecutionRequest["supply_scope"],
    solar_attribution: SOLAR_ATTRIBUTION,
    future_supply_bound_w: bounds,
    validity: {
      from_ms: from,
      boundary_ms: boundary,
      until_ms: until,
      refresh_after_ms: Math.max(from, until - 60_000),
    },
    domain: c.domain as BatteryExecutionRequest["domain"],
    permissions: {
      available: b.available[0],
      grid_charge_allowed: b.grid_charge_allowed[0],
      battery_export_allowed: b.export_allowed[0],
      export_price_eligible: originalExport[0],
      price_revision: tariff,
      export_reserve_kwh: Math.max(
        0,
        stored.plan.policy.battery_export_reserve_soc *
            stored.plan.battery.capacity_kwh - energyOrigin,
      ),
      minimum_export_price_sek_per_kwh:
        stored.plan.policy.battery_export_min_price_sek_per_kwh,
    },
    operations: c.operations as BatteryExecutionRequest["operations"],
    reference_id: c.reference_id,
    projection: {
      view: "executable",
      scope_revision: identity.scope_revision,
      external_scenario_revision: identity.external_scenario_revision,
      configured_participant_ids: problem.plant.residual_loads.map((l) => l.id),
      participants: problem.plant.residual_loads.map((l) => ({
        id: l.id,
        basis: "expected_behaviour",
      })),
    },
    search: {
      energy_levels_kwh: [],
      retained_per_level: 2,
      max_interval_evaluations: 1_000_000,
    },
  };
  return {
    status: "ready",
    request,
    energy_origin_kwh: energyOrigin,
    context_hash: contextHash,
  };
}

export interface BatteryExchangePorts {
  authenticate(
    request: Request,
  ): Promise<{ homeId: string; subscriptionActive: boolean } | null>;
  load(homeId: string): Promise<StoredBatteryGeneration | null>;
  compile: (
    request: BatteryExecutionRequest,
  ) => Promise<ReturnType<typeof compileBatteryExecutionPolicy>>;
  now(): number;
}
/** Auth is a port for tests; production uses the existing device authentication. */
export async function handleBatteryPolicyExchange(
  request: Request,
  ports: BatteryExchangePorts,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const auth = await ports.authenticate(request);
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!auth.subscriptionActive) {
    return Response.json({ error: "subscription_inactive" }, { status: 402 });
  }
  if (Number(request.headers.get("content-length")) > 128_000) {
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 128_000) {
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = batteryPolicyExchangeSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const body = parsed.data;
  const reply = (outcome: object) =>
    Response.json({
      schema: "battery-policy-delivery-v1",
      request_id: body.request_id,
      plan_id: body.plan_id,
      snapshot_id: body.snapshot_id,
      purpose: "verification",
      control_authority: false,
      ...outcome,
    });
  const stored = await ports.load(auth.homeId);
  if (!stored) return reply(blocked("projection_unavailable"));
  const built = buildBatteryPolicyRequest(stored, body, ports.now());
  if (built.status === "blocked") return reply(built);
  const result = await ports.compile(built.request);
  // Compilation may outlive the source or a concurrent plan/configuration change.
  const latest = await ports.load(auth.homeId);
  if (!latest || canonicalHash(latest) !== canonicalHash(stored)) {
    return reply(blocked("superseded_plan"));
  }
  if (ports.now() >= built.request.validity.until_ms) {
    return reply(blocked("source_quarter_expired"));
  }
  if (result.status === "rejected") {
    return reply(blocked(`compile_refused:${result.reason}`));
  }
  return reply({
    status: "delivered",
    policy: result.policy,
    context_hash: built.context_hash,
    energy_basis: "usable_kwh_above_min_soc",
    energy_origin_kwh: built.energy_origin_kwh,
    native_context: body.native_context,
  });
}
