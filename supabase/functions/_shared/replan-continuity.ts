/** Economic continuity is a candidate preference, never actuator or fixed-plan authority. */
import type {
  OptimisationPlan,
  OptimisationSnapshot,
} from "./energy-optimisation.ts";
import {
  type DispatchAuctionSolver,
  type DispatchLimits,
  type DispatchResult,
  type DispatchSlot,
  type DispatchStore,
  scoreDispatch,
} from "./dispatch-plan.ts";
import {
  DispatchPrefixInfeasible,
  dispatchWithPrefix,
  QUARTER_MS,
} from "./fixed-energy-plan.ts";

import type { BatteryOperation } from "./battery-command.ts";

export const REPLAN_DEADBAND_SEK = 0.05;
export interface ReplanReference {
  version: 2;
  source_plan_id: string;
  issued_at: string;
  evaluated_at: string;
  valid_until: string;
  slot_start: string;
  store_keys: string[];
  pool_heat: boolean | null;
  battery: {
    operation: Exclude<BatteryOperation, "self_consumption">;
    charge_w: number;
    discharge_w: number;
  } | null;
}
export interface ReplanDecision {
  source_plan_id: string;
  selected: "proposed" | "direct" | "repaired";
  reason: string;
  proposed_sek: number | null;
  reference_sek: number | null;
  deadband_sek: number;
}
export interface ContinuityProblem {
  slots: DispatchSlot[];
  stores: DispatchStore[];
  limits: DispatchLimits;
  result: DispatchResult;
}
export interface ContinuityCandidate {
  construction: "direct" | "repaired";
  result: DispatchResult;
  objective_sek: number;
}

/** Only the server's last issued plan supplies the reference; freeze it into the replay snapshot. */
export function replanReference(
  previous: OptimisationPlan | null,
  snapshot: OptimisationSnapshot,
  now: Date,
): ReplanReference | null {
  if (
    !previous || previous.status !== "ready" ||
    previous.schema_version !== snapshot.schema_version ||
    previous.plan_id === snapshot.snapshot_id || previous.fixed_plan ||
    previous.mode !== snapshot.mode ||
    ["battery", "pool", "ev"].some((key) =>
      previous.capabilities?.[key as keyof typeof previous.capabilities] !==
        snapshot.capabilities[key as keyof typeof snapshot.capabilities]
    )
  ) return null;
  const current = snapshot.slots.find(s => Date.parse(s.start) + QUARTER_MS > now.getTime());
  const slot = previous.plans?.priority?.slots.find((s) =>
    Date.parse(s.start) === Date.parse(current?.start ?? "")
  );
  if (!slot?.binding || previous.plans.priority.status !== "ready") return null;
  const batteryDispatched = previous.plans.priority.dispatched_devices.includes("battery");
  const command = slot.battery_command;
  // Forecast watts alone cannot preserve which source or destination was authorized.
  if (batteryDispatched && (!command || command.schema_version !== 2 || command.operation === "self_consumption")) return null;
  const reference: ReplanReference = {
    version: 2,
    source_plan_id: previous.plan_id,
    issued_at: previous.issued_at,
    evaluated_at: now.toISOString(),
    valid_until: previous.valid_until,
    slot_start: slot.start,
    store_keys: previous.plans.priority.dispatched_devices,
    pool_heat: previous.plans.priority.dispatched_devices.includes("pool")
      ? slot.pool_w > 0
      : null,
    battery: batteryDispatched && command && command.operation !== "self_consumption"
      ? {
        operation: command.operation,
        charge_w: slot.battery_charge_w,
        discharge_w: slot.battery_discharge_w,
      }
      : null,
  };
  return usableReference(
      reference,
      snapshot.snapshot_id,
      Date.parse(current!.start),
      now.getTime(),
    )
    ? reference
    : null;
}

export function usableReference(
  reference: ReplanReference,
  snapshotId: string,
  start: number,
  now: number,
): boolean {
  return reference.version === 2 && reference.source_plan_id !== snapshotId &&
    typeof reference.source_plan_id === "string" &&
    reference.source_plan_id.length > 0 &&
    Date.parse(reference.issued_at) <= Date.parse(reference.evaluated_at) &&
    Date.parse(reference.evaluated_at) <= now &&
    Date.parse(reference.valid_until) > now &&
    Date.parse(reference.slot_start) === start && start <= now &&
    now < start + QUARTER_MS &&
    Array.isArray(reference.store_keys) &&
    new Set(reference.store_keys).size === reference.store_keys.length &&
    (reference.pool_heat === null ||
      typeof reference.pool_heat === "boolean") &&
    (reference.battery === null || (reference.battery != null &&
      [reference.battery.charge_w, reference.battery.discharge_w].every((w) =>
        typeof w === "number" && Number.isFinite(w) && w >= 0
      ) && batteryOperationMatchesPower(reference.battery)));
}

function batteryOperationMatchesPower(battery: NonNullable<ReplanReference["battery"]>): boolean {
  switch (battery.operation) {
    case "solar_charge":
    case "grid_charge":
      return battery.charge_w > 0 && battery.discharge_w === 0;
    case "supply_house":
    case "export":
      return battery.discharge_w > 0 && battery.charge_w === 0;
    case "hold":
      return battery.charge_w === 0 && battery.discharge_w === 0;
    default:
      return false;
  }
}

/** Generate both a warm trajectory and a repaired one; heuristic suffix noise cannot erase the warm candidate. */
export function continuityCandidates(
  problem: ContinuityProblem,
  reference: ReplanReference,
  solveAuction?: DispatchAuctionSolver,
): {
  candidates: ContinuityCandidate[];
  reason: string;
} {
  const { slots, stores, limits, result } = problem;
  if (
    stores.map((s) => s.key).sort().join("|") !==
      [...reference.store_keys].sort().join("|") ||
    stores.some((s) =>
      (s.key === "battery" && reference.battery === null) ||
      (s.key === "pool" && reference.pool_heat === null)
    )
  ) {
    return { candidates: [], reason: "store_inventory_changed" };
  }
  const direct = {
    power_w: structuredClone(result.power_w),
    discharge_w: structuredClone(result.discharge_w),
  };
  for (const store of stores) {
    if (store.key === "pool") {
      direct.power_w.pool[0] = reference.pool_heat ? store.max_power_w : 0;
    }
    if (store.key === "battery" && reference.battery) {
      direct.power_w.battery[0] = reference.battery.charge_w;
      direct.discharge_w.battery[0] = reference.battery.discharge_w;
    }
  }
  if (
    stores.every((s) =>
      Math.abs(direct.power_w[s.key][0] - result.power_w[s.key][0]) < 0.005 &&
      Math.abs(direct.discharge_w[s.key][0] - result.discharge_w[s.key][0]) <
        0.005
    )
  ) return { candidates: [], reason: "agrees" };
  const candidates: ContinuityCandidate[] = [];
  const add = (
    construction: ContinuityCandidate["construction"],
    allocation: Pick<DispatchResult, "power_w" | "discharge_w">,
  ) => {
    const score = scoreDispatch(slots, stores, limits, allocation);
    if (score.infeasibilities.length || !Number.isFinite(score.total_sek)) {
      return;
    }
    candidates.push({
      construction,
      objective_sek: score.total_sek,
      result: {
        ...allocation,
        state: score.state,
        import_w: score.import_w,
        export_w: score.export_w,
        // Re-scored alternatives do not inherit bids or counterfactuals from another trajectory.
        allocations: slots.map(() => []),
        battery: slots.map(() => null),
        stopped_because: "no_profitable_candidate",
        iterations: 0,
      },
    });
  };
  add("direct", direct);
  const prefix = {
    power_w: Object.fromEntries(
      stores.map((s) => [s.key, [direct.power_w[s.key][0]]]),
    ),
    discharge_w: Object.fromEntries(
      stores.map((s) => [s.key, [direct.discharge_w[s.key][0]]]),
    ),
  };
  try {
    add(
      "repaired",
      dispatchWithPrefix(slots, stores, limits, prefix, 1, solveAuction),
    );
  } catch (error) {
    // A continuation sentinel or unexpected solver defect must reach its caller.
    if (!(error instanceof DispatchPrefixInfeasible)) throw error;
  }
  candidates.sort((a, b) => a.objective_sek - b.objective_sek);
  return {
    candidates,
    reason: candidates.length ? "material_benefit" : "reference_infeasible",
  };
}
