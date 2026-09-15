/** Executable, bounded finite bridge/suffix family. No native writes or continuous-optimum claim. */
import { batterySupplyScopeSchema, proportionalSupply, SOLAR_ATTRIBUTION } from "./battery-supply.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { compileBatteryPolicy } from "./battery-policy.ts";
import {
  type Equipment,
  type HouseholdCandidate,
  type HouseholdProblem,
  parseHouseholdProblem,
} from "./household-case.ts";
import {
  createHouseholdScorer,
  emptyObjective,
  HOUSEHOLD_SCORER_VERSION,
  type Objective,
  reconcileObjective,
  scoreElectricityInterval,
} from "./household-score.ts";
import { totalUtility } from "./store-value.ts";

export const BATTERY_EXECUTION_LIMITS = {
  policy_bytes: 128000,
  cells: 64,
  operations: 12,
  interval_evaluations: 40_000_000,
} as const;
const finite = z.number().finite().min(-1e12).max(1e12);
const nonnegative = finite.nonnegative();
const physical = nonnegative.max(1e6);
const price = finite.min(-1e6).max(1e6);
const id = z.string().min(1).max(128);
const timestamp = z.number().finite().int().nonnegative().max(
  Number.MAX_SAFE_INTEGER,
);
const range = z.tuple([physical, physical]).refine(
  ([a, b]) => a <= b,
  "unordered range",
);
const identitySchema = z.object({
  policy_id: id,
  revision: timestamp,
  battery_id: id,
  intent_revision: id,
  plant_revision: id,
  scope_revision: id,
  external_scenario_revision: id,
  tariff_revision: id,
  response_model_revision: z.literal("pv-first-v1"),
  catalog_revision: id,
}).strict();
const validitySchema = z.object({
  from_ms: timestamp,
  refresh_after_ms: timestamp,
  until_ms: timestamp,
  boundary_ms: timestamp,
}).strict();
const domainSchema = z.object({
  energy_kwh: range,
  pv_w: range,
  residual_load_w: range,
}).strict();
const permissionsSchema = z.object({
  available: z.boolean(),
  grid_charge_allowed: z.boolean(),
  battery_export_allowed: z.boolean(),
  export_reserve_kwh: physical,
  export_price_eligible: z.boolean(),
  minimum_export_price_sek_per_kwh: price,
  price_revision: id,
}).strict();
export const executionOperationSchema = z.object({
  id,
  operation: z.enum([
    "self_consumption",
    "solar_charge",
    "supply_house",
    "grid_charge",
    "export",
    "hold",
  ]),
  charge_limit_w: physical,
  discharge_limit_w: physical,
}).strict().refine((op) => {
  if (
    ["hold", "supply_house", "export"].includes(op.operation) &&
    op.charge_limit_w !== 0
  ) return false;
  if (
    ["hold", "solar_charge", "grid_charge"].includes(op.operation) &&
    op.discharge_limit_w !== 0
  ) return false;
  return (!["solar_charge", "grid_charge"].includes(op.operation) ||
    op.charge_limit_w > 0) &&
    (!["supply_house", "export"].includes(op.operation) ||
      op.discharge_limit_w > 0);
}, "incompatible semantic ceilings");
const absoluteSchema = z.object({
  weight: nonnegative,
  energy: finite,
  previous_import: finite,
  constant: finite,
}).strict();
const polynomial = z.tuple([finite, finite, finite]);
const coefficientSchema = z.object({
  polynomial,
  absolute_terms: z.array(absoluteSchema).max(0),
}).strict();
const costSchema = z.object({
  import_sek: coefficientSchema,
  export_sek: coefficientSchema,
  wear_sek: coefficientSchema,
  shaping_sek: coefficientSchema,
  ramp_sek: z.object({
    polynomial,
    absolute_terms: z.array(absoluteSchema).max(2),
  }).strict(),
  terminal_sek: coefficientSchema,
}).strict();
const cellSchema = z.object({
  id,
  witness_id: id,
  domain: z.object({
    energy_kwh: range,
    previous_import_w: range,
    inequalities: z.array(
      z.object({ energy: finite, previous_import: finite, maximum: finite })
        .strict(),
    ).max(8),
  }).strict(),
  cost: costSchema,
}).strict();
const basePolicySchema = z.object({
  schema: z.literal("battery-execution-policy-v2"),
  supply_scope: batterySupplyScopeSchema,
  solar_attribution: z.literal(SOLAR_ATTRIBUTION),
  profile: z.literal("finite-continuation-v1"),
  view: z.literal("executable"),
  identity: identitySchema,
  actuals_origin_ms: timestamp,
  validity: validitySchema,
  domain: domainSchema,
  plant: z.object({
    cutoff_kwh: physical,
    capacity_kwh: physical.positive(),
    charge_max_w: physical,
    discharge_max_w: physical,
    charge_efficiency: finite.positive().max(1),
    discharge_efficiency: finite.positive().max(1),
    import_limit_w: physical,
    export_limit_w: physical,
    wear_basis: z.enum(["ac_throughput", "discharged_storage"]),
    wear_sek_per_kwh: physical,
  }).strict(),
  permissions: permissionsSchema,
  economics: z.object({
    import_sek_per_kwh: price,
    export_sek_per_kwh: price,
    shaping_sek_per_kwh_per_kw: physical,
    ramp_sek_per_kw: physical,
  }).strict(),
  reference_id: id,
  operations: z.array(executionOperationSchema).min(1).max(
    BATTERY_EXECUTION_LIMITS.operations,
  ),
  continuation: z.object({
    representation: z.literal("piecewise-quadratic-absolute-v1"),
    coordinate_order: z.tuple([
      z.literal("energy_kwh"),
      z.literal("previous_import_w"),
    ]),
    cells: z.array(cellSchema).min(1).max(BATTERY_EXECUTION_LIMITS.cells),
  }).strict(),
  quality: z.object({
    assurance: z.literal("exact-scoring-within-published-family"),
    scorer_revision: z.literal(HOUSEHOLD_SCORER_VERSION),
    compiler_revision: z.literal("execution-v2"),
    family_id: id,
    source_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    numeric_tolerance_sek: z.literal(1e-7),
    search_exhaustive_in_declared_graph: z.boolean(),
    search_pruned_prefixes: nonnegative.int().max(40_000_000),
    heldout_count: z.literal(0),
    heldout_max_regret_sek: z.null(),
    certified_regret_bound_sek: z.null(),
  }).strict(),
}).strict();
// Preserve tuples while restoring required Zod fields under this repository's non-strict TS config.
type RequiredFields<T> = T extends object
  ? { [K in keyof T]-?: RequiredFields<T[K]> }
  : T;
export type BatteryExecutionPolicy = RequiredFields<
  z.infer<typeof basePolicySchema>
>;
export type ExecutionOperation = RequiredFields<
  z.infer<typeof executionOperationSchema>
>;
export type ExecutionCell =
  BatteryExecutionPolicy["continuation"]["cells"][number];
type Battery = Extract<Equipment, { kind: "battery" }>;
type Action = Extract<
  HouseholdCandidate["actions"][string][number],
  { kind: "battery" }
>;
type CostKey = keyof ExecutionCell["cost"];
const costKeys: CostKey[] = [
  "import_sek",
  "export_sek",
  "wear_sek",
  "shaping_sek",
  "ramp_sek",
  "terminal_sek",
];
const unique = (values: string[]) => new Set(values).size === values.length;
const sorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const EPS = 1e-7;
const PHYSICAL_EPS = 1e-9;
function polynomialAt(p: { 0: number; 1: number; 2: number }, energy: number) {
  return p[0] + p[1] * energy + p[2] * energy ** 2;
}

export const batteryExecutionPolicySchema = basePolicySchema.superRefine(
  (raw, ctx) => {
    const p = raw as BatteryExecutionPolicy;
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const v = p.validity, b = p.plant;
    if (
      !(p.actuals_origin_ms <= v.from_ms && v.from_ms <= v.refresh_after_ms &&
        v.refresh_after_ms < v.until_ms && v.until_ms <= v.boundary_ms &&
        v.boundary_ms === (Math.floor(v.from_ms / 900000) + 1) * 900000)
    ) fail("invalid quarter validity");
    if (
      !(b.cutoff_kwh < b.capacity_kwh &&
        p.domain.energy_kwh[0] >= b.cutoff_kwh &&
        p.domain.energy_kwh[1] <= b.capacity_kwh &&
        p.permissions.export_reserve_kwh >= b.cutoff_kwh &&
        p.permissions.export_reserve_kwh <= b.capacity_kwh)
    ) fail("invalid physical energy domain/reserve");
    if (p.permissions.price_revision !== p.identity.tariff_revision) {
      fail(
        "price revision mismatch",
      );
    }
    if (
      !unique(p.operations.map((o) => o.id)) ||
      !unique(
        p.operations.map((o) =>
          JSON.stringify([o.operation, o.charge_limit_w, o.discharge_limit_w])
        ),
      ) ||
      !p.operations.some((o) => o.id === p.reference_id)
    ) fail("duplicate operations or missing reference");
    if (
      p.operations.some((o) =>
        o.charge_limit_w > b.charge_max_w ||
        o.discharge_limit_w > b.discharge_max_w
      )
    ) fail("operation exceeds plant ceiling");
    if (
      p.quality.search_exhaustive_in_declared_graph !==
        (p.quality.search_pruned_prefixes === 0)
    ) fail("inconsistent search evidence");
    if (!unique(p.continuation.cells.map((c) => c.id))) fail("duplicate cells");
    for (const cell of p.continuation.cells) {
      const [lo, hi] = cell.domain.energy_kwh;
      if (
        lo < b.cutoff_kwh || hi > b.capacity_kwh ||
        cell.domain.previous_import_w[1] > b.import_limit_w
      ) fail("cell outside physical domain");
      for (
        const key of [
          "wear_sek",
          "shaping_sek",
          "ramp_sek",
          "terminal_sek",
        ] as const
      ) {
        const poly = cell.cost[key].polynomial;
        const points = [lo, hi];
        if (poly[2] > 0) {
          points.push(
            Math.max(lo, Math.min(hi, -poly[1] / (2 * poly[2]))),
          );
        }
        // Conservative: nonnegative polynomial plus nonnegative absolute terms.
        if (points.some((e) => polynomialAt(poly, e) < -EPS)) {
          fail(
            `negative ${key}`,
          );
        }
      }
    }
    if (bytes(p) > BATTERY_EXECUTION_LIMITS.policy_bytes) {
      fail(
        "policy byte limit exceeded",
      );
    }
  },
);

const requestSchema = z.object({
  supply_scope: batterySupplyScopeSchema,
  solar_attribution: z.literal(SOLAR_ATTRIBUTION),
  // Explicit future permissions, computed from the same partition/scopes as the
  // planner. Their length and physical balance are checked below.
  future_supply_bound_w: z.array(physical),
  problem: z.unknown(),
  identity: identitySchema,
  validity: validitySchema,
  domain: domainSchema,
  permissions: permissionsSchema,
  reference_id: id,
  operations: z.array(executionOperationSchema).min(1).max(
    BATTERY_EXECUTION_LIMITS.operations,
  ),
  projection: z.object({
    view: z.literal("executable"),
    scope_revision: id,
    external_scenario_revision: id,
    configured_participant_ids: z.array(id).max(32),
    participants: z.array(
      z.object({ id, basis: z.enum(["measured_base", "expected_behaviour"]) })
        .strict(),
    ).max(32),
  }).strict(),
  search: z.object({
    energy_levels_kwh: z.array(nonnegative).max(32),
    retained_per_level: finite.int().min(1).max(8),
    max_interval_evaluations: finite.int().min(1).max(
      BATTERY_EXECUTION_LIMITS.interval_evaluations,
    ),
  }).strict(),
}).strict();
export type BatteryExecutionRequest =
  & Omit<RequiredFields<z.infer<typeof requestSchema>>, "problem">
  & { problem: HouseholdProblem };
export type ExecutionConditions = {
  at_ms: number;
  energy_kwh: number;
  pv_w: number;
  residual_load_w: number;
  previous_import_w: number;
  eligible_load_w?: number;
};
const conditionsSchema = z.object({
  at_ms: timestamp,
  energy_kwh: physical,
  pv_w: physical,
  residual_load_w: physical,
  previous_import_w: physical,
  eligible_load_w: physical.optional(),
}).strict();
export type ExecutionCurrentResponse = { eligible: false; reason: string } | {
  eligible: true;
  current: Objective;
  energy_end_kwh: number;
  terminal_import_w: number;
  possible_import_w: number;
  possible_export_w: number;
};

/** Native PV First response. Only physical capacity/cutoff cause saturation. */
export function evaluateExecutionCurrent(
  policy: BatteryExecutionPolicy,
  operation: ExecutionOperation,
  conditions: ExecutionConditions,
): ExecutionCurrentResponse {
  const reject = (reason: string): ExecutionCurrentResponse => ({
    eligible: false,
    reason,
  });
  if (!conditionsSchema.safeParse(conditions).success) {
    return reject("invalid_conditions");
  }
  if (
    !executionOperationSchema.safeParse(operation).success ||
    !policy.operations.some((o) =>
      o.id === operation.id && o.operation === operation.operation &&
      o.charge_limit_w === operation.charge_limit_w &&
      o.discharge_limit_w === operation.discharge_limit_w
    )
  ) return reject("unknown_operation");
  const c = conditions,
    p = policy.plant,
    perm = policy.permissions,
    op = operation.operation;
  if (
    c.at_ms < policy.validity.from_ms || c.at_ms >= policy.validity.until_ms
  ) return reject("outside_validity");
  if (
    (["energy_kwh", "pv_w", "residual_load_w"] as const).some((k) =>
      c[k] < policy.domain[k][0] || c[k] > policy.domain[k][1]
    )
  ) return reject("outside_domain");
  if (!perm.available && op !== "hold") return reject("battery_unavailable");
  if (op === "grid_charge" && !perm.grid_charge_allowed) {
    return reject("grid_charge_not_allowed");
  }
  if (op === "export") {
    if (!perm.battery_export_allowed) {
      return reject("battery_export_not_allowed");
    }
    if (
      !perm.export_price_eligible ||
      policy.economics.export_sek_per_kwh <
        perm.minimum_export_price_sek_per_kwh
    ) return reject("export_price_ineligible");
    if (c.energy_kwh <= perm.export_reserve_kwh) {
      return reject("export_reserve");
    }
  }
  const surplus = Math.max(0, c.pv_w - c.residual_load_w),
    deficit = Math.max(0, c.residual_load_w - c.pv_w);
  const charge = op === "grid_charge"
    ? operation.charge_limit_w
    : ["self_consumption", "solar_charge"].includes(op)
    ? Math.min(operation.charge_limit_w, surplus)
    : 0;
  const discharge = op === "export"
    ? operation.discharge_limit_w
    : ["self_consumption", "supply_house"].includes(op)
    ? Math.min(operation.discharge_limit_w, deficit)
    : 0;
  if (policy.supply_scope.kind === "selected" && c.eligible_load_w === undefined) {
    return reject("scope_measurements_unavailable");
  }
  const eligible = policy.supply_scope.kind === "whole_house" ? c.residual_load_w :
    policy.supply_scope.kind === "none" ? 0 : c.eligible_load_w!;
  if (eligible > c.residual_load_w) return reject("unreconciled_supply_measurements");
  const bound = proportionalSupply(c.residual_load_w, c.pv_w, eligible).houseSupplyBoundW;
  // A native operation remains exactly the commissioned target. Reject it when
  // it would exceed scope; never pretend that a clipped model changed hardware.
  if (Math.min(discharge, deficit) > bound + EPS) return reject("native_operation_exceeds_supply_scope");
  const hours = (policy.validity.boundary_ms - c.at_ms) / 3600000;
  const rate =
    (charge * p.charge_efficiency - discharge / p.discharge_efficiency) / 1000;
  if (!Number.isFinite(rate)) return reject("numeric_overflow");
  if (
    op === "export" && c.energy_kwh + rate * hours < perm.export_reserve_kwh
  ) return reject("export_reserve_crossing");
  const activeHours = rate > 0
    ? Math.min(hours, (p.capacity_kwh - c.energy_kwh) / rate)
    : rate < 0
    ? Math.min(hours, (p.cutoff_kwh - c.energy_kwh) / rate)
    : hours;
  const segments = [{ hours: activeHours, charge, discharge }, {
    hours: hours - activeHours,
    charge: 0,
    discharge: 0,
  }].filter((s) => s.hours > 0);
  const result = emptyObjective();
  let energy = c.energy_kwh, previous = c.previous_import_w;
  for (const s of segments) {
    if (s.charge > p.charge_max_w || s.discharge > p.discharge_max_w) {
      return reject("power_limit");
    }
    if (!perm.grid_charge_allowed && s.charge > surplus) {
      return reject("native_grid_charge_not_allowed");
    }
    if (!perm.battery_export_allowed && s.discharge > deficit) {
      return reject("native_battery_export_not_allowed");
    }
    const net = c.residual_load_w + s.charge - s.discharge - c.pv_w;
    const imported = Math.max(0, net), exported = Math.max(0, -net);
    if (imported > p.import_limit_w || exported > p.export_limit_w) {
      return reject("grid_limit");
    }
    const account = scoreElectricityInterval({
      ...policy.economics,
      hours: s.hours,
      import_w: imported,
      export_w: exported,
      previous_import_w: previous,
    });
    account.wear_sek = (p.wear_basis === "discharged_storage"
      ? s.discharge / p.discharge_efficiency : s.charge + s.discharge) / 1000 * s.hours * p.wear_sek_per_kwh;
    for (const key of costKeys) result[key] += account[key];
    energy +=
      (s.charge * p.charge_efficiency - s.discharge / p.discharge_efficiency) /
      1000 * s.hours;
    if (energy < p.cutoff_kwh - EPS || energy > p.capacity_kwh + EPS) {
      return reject("state_limit");
    }
    previous = imported;
  }
  const current = reconcileObjective(result);
  if (Object.values(current).some((value) => !Number.isFinite(value))) {
    return reject("numeric_overflow");
  }
  return {
    eligible: true,
    current,
    energy_end_kwh: Math.max(p.cutoff_kwh, Math.min(p.capacity_kwh, energy)),
    terminal_import_w: previous,
    possible_import_w: op === "grid_charge" ? operation.charge_limit_w : 0,
    possible_export_w: op === "export" ? operation.discharge_limit_w : 0,
  };
}

/** Exact evaluation only on a published closed domain; holes never extrapolate. */
export function evaluateExecutionContinuation(
  policy: BatteryExecutionPolicy,
  energy: number,
  previousImport: number,
): { witness_id: string; cell_id: string; objective: Objective } | null {
  if (!Number.isFinite(energy) || !Number.isFinite(previousImport)) return null;
  const candidates = policy.continuation.cells.flatMap((cell) => {
    const d = cell.domain;
    if (
      energy < d.energy_kwh[0] - PHYSICAL_EPS ||
      energy > d.energy_kwh[1] + PHYSICAL_EPS ||
      previousImport < d.previous_import_w[0] - PHYSICAL_EPS ||
      previousImport > d.previous_import_w[1] + PHYSICAL_EPS
    ) {
      return [];
    }
    // Clip only numerical boundary noise inward; never extrapolate a cell.
    const e = Math.max(d.energy_kwh[0], Math.min(d.energy_kwh[1], energy));
    const p = Math.max(
      d.previous_import_w[0],
      Math.min(d.previous_import_w[1], previousImport),
    );
    if (
      d.inequalities.some((q) =>
        q.energy * e + q.previous_import * p > q.maximum + PHYSICAL_EPS
      )
    ) return [];
    const objective = emptyObjective();
    for (const key of costKeys) {
      const term = cell.cost[key];
      objective[key] = polynomialAt(term.polynomial, e) +
        term.absolute_terms.reduce(
          (sum, t) =>
            sum +
            t.weight *
              Math.abs(
                t.energy * e + t.previous_import * p +
                  t.constant,
              ),
          0,
        );
    }
    return [{
      witness_id: cell.witness_id,
      cell_id: cell.id,
      objective: reconcileObjective(objective),
    }];
  });
  if (!candidates.length) return null;
  const best = Math.min(...candidates.map((c) => c.objective.total_sek));
  return candidates.filter((c) => c.objective.total_sek <= best + EPS).sort((
    a,
    b,
  ) => a.cell_id < b.cell_id ? -1 : a.cell_id > b.cell_id ? 1 : 0)[0];
}

class Rejection extends Error {}
const requireCondition = (condition: boolean, reason: string) => {
  if (!condition) throw new Rejection(reason);
};
function emptyCost(): ExecutionCell["cost"] {
  return Object.fromEntries(
    costKeys.map((key) => [key, { polynomial: [0, 0, 0], absolute_terms: [] }]),
  ) as unknown as ExecutionCell["cost"];
}
function makeCell(
  witness: string,
  index: number,
  lo: number,
  hi: number,
  importLimit: number,
): ExecutionCell {
  return {
    id: `${witness}-cell-${index}`,
    witness_id: witness,
    domain: {
      energy_kwh: [lo, hi],
      previous_import_w: [0, importLimit],
      inequalities: [],
    },
    cost: emptyCost(),
  };
}
function action(
  charge: number,
  discharge: number,
  pv: number,
  load: number,
): Action {
  return {
    kind: "battery",
    charge_w: charge,
    discharge_w: discharge,
    solar_charge_w: Math.min(charge, pv),
    export_w: Math.max(0, discharge - load),
  };
}

/** Remove the current interval and set the declared future initial energy. */
export function executionFutureProblem(
  problem: HouseholdProblem,
  anchor: number,
): HouseholdProblem {
  const b = problem.plant.equipment[0] as Battery;
  return {
    ...structuredClone(problem),
    identity: {
      ...problem.identity,
      actuals_watermark: problem.intervals[1].start,
    },
    intervals: problem.intervals.slice(1),
    plant: {
      ...problem.plant,
      pv_w: problem.plant.pv_w.slice(1),
      residual_loads: problem.plant.residual_loads.map((l) => ({
        ...l,
        power_w: l.power_w.slice(1),
      })),
      equipment: [{
        ...b,
        state_kwh: { ...b.state_kwh, initial: anchor },
        available: b.available.slice(1),
        grid_charge_allowed: b.grid_charge_allowed.slice(1),
        export_allowed: b.export_allowed.slice(1),
      }],
    },
    economics: {
      ...problem.economics,
      initial_import_w: null,
      import_sek_per_kwh: problem.economics.import_sek_per_kwh.slice(1),
      export_sek_per_kwh: problem.economics.export_sek_per_kwh.slice(1),
    },
  };
}
function exportAllowed(
  request: BatteryExecutionRequest,
  b: Battery,
  index: number,
): boolean {
  const p = request.permissions;
  return b.export_allowed[index] &&
    request.problem.economics.export_sek_per_kwh[index] >=
      p.minimum_export_price_sek_per_kwh;
}
function nativeSuffixFeasible(
  request: BatteryExecutionRequest,
  candidate: HouseholdCandidate,
  states: number[],
): boolean {
  const source = request.problem, b = source.plant.equipment[0] as Battery;
  if (candidate.pv_curtail_w.some((w) => w !== 0)) return false;
  return candidate.actions[b.id].every((raw, j) => {
    const a = raw as Action, i = j + 1;
    const load = source.plant.residual_loads.reduce(
        (sum, l) => sum + l.power_w[i],
        0,
      ),
      pv = source.plant.pv_w[i];
    if (
      !b.available[i] &&
      a.charge_w + a.discharge_w > 0
    ) return false;
    if (
      !b.grid_charge_allowed[i] &&
      a.charge_w > Math.max(0, pv - load)
    ) return false;
    if (Math.min(a.discharge_w, Math.max(0, load - pv)) > request.future_supply_bound_w[i] + EPS) return false;
    if (a.discharge_w > Math.max(0, load - pv)) {
      if (
        !exportAllowed(request, b, i) ||
        states[j] <= request.permissions.export_reserve_kwh ||
        states[j + 1] < request.permissions.export_reserve_kwh
      ) return false;
    }
    return true;
  });
}

/** Analytic bridge: powers, grid flow and source attribution are affine on each split. */
function bridgeCells(
  request: BatteryExecutionRequest,
  anchor: number,
  witness: string,
  constant: Objective,
  firstTailImport: number | null,
): ExecutionCell[] {
  const source = request.problem,
    b = source.plant.equipment[0] as Battery,
    perm = request.permissions;
  const pv = source.plant.pv_w[1],
    load = source.plant.residual_loads.reduce(
      (sum, l) => sum + l.power_w[1],
      0,
    );
  const deficit = Math.max(0, load - pv),
    surplus = Math.max(0, pv - load),
    h = 0.25;
  const cc = 1000 / h / b.charge_efficiency,
    dc = 1000 / h * b.discharge_efficiency;
  // E=A direction; charge=PV attribution; net=0; discharge=deficit native export guard.
  const points = sorted(
    [
      b.state_kwh.min,
      b.state_kwh.max,
      anchor,
      anchor - pv / cc,
      anchor - surplus / cc,
      anchor + deficit / dc,
      perm.export_reserve_kwh,
    ]
      .filter((e) => e >= b.state_kwh.min && e <= b.state_kwh.max),
  );
  const cells: ExecutionCell[] = [];
  for (let j = 0; j < points.length - 1; j++) {
    let lo = points[j], hi = points[j + 1];
    const middle = (lo + hi) / 2, charging = middle < anchor;
    // [constant, E coefficient] of each physical power, in W.
    const c = charging ? [cc * anchor, -cc] : [0, 0];
    const d = charging ? [0, 0] : [-dc * anchor, dc];
    const net = [load - pv + c[0] - d[0], c[1] - d[1]];
    let possible = true;
    const at = (p: number[], e: number) => p[0] + p[1] * e;
    const limit = (p: number[], maximum: number) => {
      if (p[1] > 0) hi = Math.min(hi, (maximum - p[0]) / p[1]);
      else if (p[1] < 0) lo = Math.max(lo, (maximum - p[0]) / p[1]);
      else if (p[0] > maximum) possible = false;
    };
    const available = b.available[1];
    limit(c, available ? b.charge_max_w : 0);
    limit(d, available ? b.discharge_max_w : 0);
    if (request.future_supply_bound_w[1] < deficit) limit(d, request.future_supply_bound_w[1]);
    if (!b.grid_charge_allowed[1]) {
      limit(c, surplus);
    }
    if (!exportAllowed(request, b, 1) || anchor < perm.export_reserve_kwh) {
      limit(d, deficit);
    } else if (at(d, middle) > deficit) {
      lo = Math.max(lo, perm.export_reserve_kwh);
    }
    limit(net, source.plant.grid.import_limit_w);
    limit([-net[0], -net[1]], source.plant.grid.export_limit_w);
    if (!possible || lo > hi) continue;
    const imports = at(net, middle) > 0 ? net : [0, 0],
      exports = at(net, middle) < 0 ? [-net[0], -net[1]] : [0, 0];
    const cell = makeCell(
      witness,
      cells.length,
      lo,
      hi,
      source.plant.grid.import_limit_w,
    );
    for (const key of costKeys) cell.cost[key].polynomial[0] = constant[key];
    const addLinear = (key: CostKey, p: number[], factor: number) => {
      cell.cost[key].polynomial[0] += p[0] * factor;
      cell.cost[key].polynomial[1] += p[1] * factor;
    };
    addLinear(
      "import_sek",
      imports,
      h / 1000 * source.economics.import_sek_per_kwh[1],
    );
    addLinear(
      "export_sek",
      exports,
      h / 1000 * source.economics.export_sek_per_kwh[1],
    );
    addLinear(
      "wear_sek",
      b.wear_basis === "discharged_storage"
        ? [d[0] / b.discharge_efficiency, d[1] / b.discharge_efficiency]
        : [c[0] + d[0], c[1] + d[1]],
      h / 1000 * b.wear_sek_per_kwh,
    );
    const shaping = 0.5 * source.economics.shaping_sek_per_kwh_per_kw * h /
      1_000_000;
    cell.cost.shaping_sek.polynomial[0] += shaping * imports[0] ** 2;
    cell.cost.shaping_sek.polynomial[1] += shaping * 2 * imports[0] *
      imports[1];
    cell.cost.shaping_sek.polynomial[2] += shaping * imports[1] ** 2;
    const weight = source.economics.ramp_sek_per_kw / 1000;
    cell.cost.ramp_sek.absolute_terms.push({
      weight,
      energy: imports[1],
      previous_import: -1,
      constant: imports[0],
    });
    if (firstTailImport !== null) {
      cell.cost.ramp_sek.absolute_terms.push({
        weight,
        energy: -imports[1],
        previous_import: 0,
        constant: firstTailImport - imports[0],
      });
    }
    cells.push(cell);
  }
  return cells;
}

/** No future electricity interval: retain exact piecewise-quadratic terminal utility. */
function terminalCells(request: BatteryExecutionRequest): ExecutionCell[] {
  const b = request.problem.plant.equipment[0] as Battery,
    terminal = request.problem.economics.terminal[0];
  const curve = terminal?.curve;
  const points = sorted(
    [
      b.state_kwh.min,
      b.state_kwh.max,
      ...(curve?.points.map((p) => p.at) ?? []),
    ].filter((e) => e >= b.state_kwh.min && e <= b.state_kwh.max),
  );
  return points.slice(0, -1).map((lo, index) => {
    const hi = points[index + 1],
      cell = makeCell(
        "terminal",
        index,
        lo,
        hi,
        request.problem.plant.grid.import_limit_w,
      );
    if (curve) {
      const middle = (lo + hi) / 2,
        upper = curve.points.findIndex((p) => p.at >= middle);
      let slope = 0, marginal = 0;
      if (upper === 0) marginal = curve.points[0].sek_per_unit;
      else if (upper > 0) {
        const a = curve.points[upper - 1], b = curve.points[upper];
        slope = (b.sek_per_unit - a.sek_per_unit) / (b.at - a.at);
        marginal = a.sek_per_unit + slope * (lo - a.at);
      }
      const quadratic = slope / 2, linear = marginal - slope * lo;
      cell.cost.terminal_sek.polynomial = [
        totalUtility(curve, lo) - linear * lo - quadratic * lo ** 2,
        linear,
        quadratic,
      ];
    }
    return cell;
  });
}

/** A normal family member: unchanged energy, native idle electricity and exact terminal utility. */
function idleCells(request: BatteryExecutionRequest): ExecutionCell[] {
  const b = request.problem.plant.equipment[0] as Battery;
  const future = executionFutureProblem(request.problem, b.state_kwh.initial);
  const candidate: HouseholdCandidate = {
    id: "idle",
    actions: { [b.id]: future.intervals.map(() => action(0, 0, 0, 0)) },
    pv_curtail_w: future.intervals.map(() => 0),
  };
  const score = createHouseholdScorer(future).score(candidate);
  if (
    score.status !== "scored" ||
    !nativeSuffixFeasible(request, candidate, score.trajectory.state[b.id])
  ) return [];
  return terminalCells(request).map((cell, index) => {
    cell.id = `idle-cell-${index}`;
    cell.witness_id = "idle";
    for (const key of costKeys) {
      if (key !== "terminal_sek") {
        cell.cost[key].polynomial[0] = score.objective[key];
      }
    }
    cell.cost.ramp_sek.absolute_terms.push({
      weight: request.problem.economics.ramp_sek_per_kw / 1000,
      energy: 0,
      previous_import: -1,
      constant: score.trajectory.intervals[0].import_w,
    });
    return cell;
  });
}

function compile(input: unknown): BatteryExecutionPolicy {
  let inputBytes: number;
  try {
    inputBytes = bytes(input);
  } catch {
    throw new Rejection("invalid_json_input");
  }
  requireCondition(inputBytes <= 2_000_000, "input_byte_limit");
  const raw = requestSchema.parse(input);
  // Bound raw collections before the household parser clones them.
  z.object({
    intervals: z.array(z.unknown()).min(1).max(288),
    plant: z.object({
      equipment: z.array(z.unknown()).length(1),
      thermal_stores: z.array(z.unknown()).length(0),
      residual_loads: z.array(z.unknown()).max(32),
    }),
    economics: z.object({
      terminal: z.array(
        z.object({ curve: z.object({ points: z.array(z.unknown()).max(64) }) }),
      ).max(1),
    }),
  }).parse(raw.problem);
  const request = {
    ...raw,
    problem: parseHouseholdProblem(raw.problem),
  } as BatteryExecutionRequest;
  const { problem, identity, permissions, projection, search } = request;
  requireCondition(request.future_supply_bound_w.length === problem.intervals.length &&
    request.future_supply_bound_w.every((bound, i) => bound <= Math.max(0,
      problem.plant.residual_loads.reduce((sum, load) => sum + load.power_w[i], 0) - problem.plant.pv_w[i])),
    "invalid_future_supply_bounds");
  const b = problem.plant.equipment[0];
  requireCondition(
    b.kind === "battery" && !problem.economics.services.length &&
      !problem.economics.completed_event_ids.length,
    "unsupported_scope",
  );
  if (b.kind !== "battery") throw new Rejection("unsupported_scope");
  const from = Date.parse(problem.intervals[0].start),
    boundary = (Math.floor(from / 900000) + 1) * 900000;
  requireCondition(
    Date.parse(problem.intervals[0].end) === boundary &&
      problem.intervals.slice(1).every((v) =>
        Date.parse(v.start) % 900000 === 0 &&
        Date.parse(v.end) - Date.parse(v.start) === 900000
      ),
    "unsupported_interval_subdivision",
  );
  requireCondition(
    request.validity.from_ms === from &&
      request.validity.boundary_ms === boundary,
    "source_validity_mismatch",
  );
  requireCondition(
    identity.battery_id === b.id &&
      identity.intent_revision === problem.identity.intent_revision,
    "source_identity_mismatch",
  );
  requireCondition(
    permissions.available === b.available[0] &&
      permissions.grid_charge_allowed === b.grid_charge_allowed[0] &&
      permissions.battery_export_allowed === b.export_allowed[0],
    "source_permissions_mismatch",
  );
  const ids = projection.participants.map((p) => p.id),
    configured = projection.configured_participant_ids,
    loads = problem.plant.residual_loads.map((l) => l.id);
  requireCondition(
    unique(ids) && unique(configured) &&
      JSON.stringify([...ids].sort()) ===
        JSON.stringify([...configured].sort()) &&
      JSON.stringify([...ids].sort()) === JSON.stringify([...loads].sort()),
    "projection_participant_mismatch",
  );
  requireCondition(
    projection.scope_revision === identity.scope_revision &&
      projection.external_scenario_revision ===
        identity.external_scenario_revision,
    "projection_revision_mismatch",
  );
  requireCondition(
    search.energy_levels_kwh.every((e) =>
      e >= b.state_kwh.min && e <= b.state_kwh.max
    ),
    "anchor_outside_plant",
  );
  const hash = `sha256:${
    createHash("sha256").update(JSON.stringify(request)).digest("hex")
  }`;
  const policy: BatteryExecutionPolicy = {
    schema: "battery-execution-policy-v2",
    supply_scope: request.supply_scope,
    solar_attribution: request.solar_attribution,
    profile: "finite-continuation-v1",
    view: "executable",
    identity,
    actuals_origin_ms: Date.parse(problem.identity.actuals_watermark),
    validity: request.validity,
    domain: request.domain,
    plant: {
      cutoff_kwh: b.state_kwh.min,
      capacity_kwh: b.state_kwh.max,
      charge_max_w: b.charge_max_w,
      discharge_max_w: b.discharge_max_w,
      charge_efficiency: b.charge_efficiency,
      discharge_efficiency: b.discharge_efficiency,
      import_limit_w: problem.plant.grid.import_limit_w,
      export_limit_w: problem.plant.grid.export_limit_w,
      wear_basis: b.wear_basis,
      wear_sek_per_kwh: b.wear_sek_per_kwh,
    },
    permissions,
    economics: {
      import_sek_per_kwh: problem.economics.import_sek_per_kwh[0],
      export_sek_per_kwh: problem.economics.export_sek_per_kwh[0],
      shaping_sek_per_kwh_per_kw: problem.economics.shaping_sek_per_kwh_per_kw,
      ramp_sek_per_kw: problem.economics.ramp_sek_per_kw,
    },
    reference_id: request.reference_id,
    operations: request.operations,
    continuation: {
      representation: "piecewise-quadratic-absolute-v1",
      coordinate_order: ["energy_kwh", "previous_import_w"],
      cells: [],
    },
    quality: {
      assurance: "exact-scoring-within-published-family",
      scorer_revision: HOUSEHOLD_SCORER_VERSION,
      compiler_revision: "execution-v2",
      family_id: `family-${hash.slice(7, 31)}`,
      source_hash: hash,
      numeric_tolerance_sek: EPS,
      search_exhaustive_in_declared_graph: true,
      search_pruned_prefixes: 0,
      heldout_count: 0,
      heldout_max_regret_sek: null,
      certified_regret_bound_sek: null,
    },
  };
  // Validate authorities/operations before any solve (temporarily provide a structural cell).
  batteryExecutionPolicySchema.parse({
    ...policy,
    continuation: {
      ...policy.continuation,
      cells: [
        makeCell(
          "validation",
          0,
          b.state_kwh.min,
          b.state_kwh.max,
          policy.plant.import_limit_w,
        ),
      ],
    },
  });
  if (problem.intervals.length === 1) {
    policy.continuation.cells = terminalCells(request);
  } else {
    const anchors = sorted([
      b.state_kwh.min,
      b.state_kwh.max,
      b.state_kwh.initial,
      ...search.energy_levels_kwh,
    ]);
    // Every call receives an equal slice of the aggregate budget, including final witness rescore.
    const horizon = problem.intervals.length - 1;
    // One authoritative idle-family score also consumes the aggregate work allowance.
    const budget = Math.floor(
      (search.max_interval_evaluations - horizon) / anchors.length,
    );
    requireCondition(budget > horizon, "aggregate_work_limit");
    policy.continuation.cells = idleCells(request);
    const load = problem.plant.residual_loads.reduce(
      (sum, l) => sum + l.power_w[1],
      0,
    );
    const pv = problem.plant.pv_w[1];
    // The optimizer needs a physically feasible first interval ending at the anchor.
    // Its account is replaced analytically, so use only power required by grid limits.
    const seedCharge = Math.max(
      0,
      pv - load - problem.plant.grid.export_limit_w,
    );
    const seedDischarge = Math.max(
      0,
      load - pv - problem.plant.grid.import_limit_w,
    );
    for (const [index, anchor] of anchors.entries()) {
      const initial = anchor - seedCharge * 0.25 * b.charge_efficiency / 1000 +
        seedDischarge * 0.25 / b.discharge_efficiency / 1000;
      if (initial < b.state_kwh.min || initial > b.state_kwh.max) continue;
      const future = executionFutureProblem(problem, initial);
      const compiled = compileBatteryPolicy({
        problem: future,
        reference_id: "hold",
        alternatives: [{
          id: "hold",
          current: {
            actions: [action(seedCharge, seedDischarge, pv, load)],
            pv_curtail_w: [0],
          },
        }],
        search: {
          ...search,
          pv_curtailment_fractions: [0],
          max_interval_evaluations: budget - horizon,
        },
      });
      if (compiled.status === "rejected") {
        throw new Rejection(`suffix_${compiled.reason}: ${compiled.detail}`);
      }
      if (compiled.status !== "compiled") {
        for (const outcome of compiled.outcomes) {
          policy.quality.search_pruned_prefixes +=
            outcome.search.pruned_prefixes;
          policy.quality.search_exhaustive_in_declared_graph &&=
            outcome.search.exhaustive_in_declared_graph;
        }
        continue;
      }
      const solved = compiled.alternatives[0];
      policy.quality.search_pruned_prefixes += solved.search.pruned_prefixes;
      policy.quality.search_exhaustive_in_declared_graph &&=
        solved.search.exhaustive_in_declared_graph;
      const verified = createHouseholdScorer(future).score(solved.candidate);
      if (verified.status !== "scored") {
        throw new Error("Optimized witness failed authoritative rescore");
      }
      if (
        !nativeSuffixFeasible(
          request,
          solved.candidate,
          verified.trajectory.state[b.id],
        )
      ) continue;
      const constant = emptyObjective();
      // Omit seed bridge account and the original first tail ramp, retain all later ramps and terminal.
      for (const [i, row] of verified.intervals.entries()) {
        if (i === 0) continue;
        for (const key of costKeys) {
          if (key !== "ramp_sek" || i > 1) {
            constant[key] += row.objective[key];
          }
        }
      }
      constant.terminal_sek = verified.closing.terminal_sek;
      policy.continuation.cells.push(
        ...bridgeCells(
          request,
          anchor,
          `anchor-${index}`,
          constant,
          verified.trajectory.intervals[1]?.import_w ?? null,
        ),
      );
      requireCondition(
        policy.continuation.cells.length <= BATTERY_EXECUTION_LIMITS.cells,
        "after_split_cell_limit",
      );
    }
  }
  requireCondition(
    policy.continuation.cells.length > 0,
    "no_native_feasible_continuation",
  );
  requireCondition(
    policy.continuation.cells.length <= BATTERY_EXECUTION_LIMITS.cells,
    "after_split_cell_limit",
  );
  requireCondition(
    bytes(policy) <= BATTERY_EXECUTION_LIMITS.policy_bytes,
    "policy_byte_limit",
  );
  return batteryExecutionPolicySchema.parse(policy) as BatteryExecutionPolicy;
}

/** Public bounded compiler. Malformed/unsupported scope returns a reason; defects throw. */
export function compileBatteryExecutionPolicy(
  request: unknown,
): { status: "compiled"; policy: BatteryExecutionPolicy } | {
  status: "rejected";
  reason: string;
} {
  try {
    return { status: "compiled", policy: compile(request) };
  } catch (error) {
    if (error instanceof Rejection) {
      return { status: "rejected", reason: error.message };
    }
    if (
      error instanceof z.ZodError ||
      error instanceof Error &&
        error.message.startsWith("Invalid household problem:")
    ) return { status: "rejected", reason: `invalid_input: ${error.message}` };
    throw error;
  }
}
