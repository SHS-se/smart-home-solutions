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
  dispatchWithStoreProfile,
  QUARTER_MS,
} from "./fixed-energy-plan.ts";

import type { BatteryOperation } from "./battery-command.ts";

export const REPLAN_DEADBAND_SEK = 0.05;
/**
 * What a replan must save before it may stop a big load that is already on.
 *
 * Measured over the whole horizon, so it is the saving from cutting the rest
 * of the run, not a per-quarter margin. The quarter deadband above is five öre:
 * a new price release shifting the pool's value by less than that switched a
 * heat pump off mid-run, which costs a compressor stop and a pump sequence the
 * objective does not see.
 */
export const HELD_RUN_RELEASE_SEK = 5;
export interface ReplanReference {
  version: 2;
  source_plan_id: string;
  issued_at: string;
  evaluated_at: string;
  valid_until: string;
  slot_start: string;
  store_keys: string[];
  pool_heat: boolean | null;
  /**
   * Published quarters, from the current one, that the previous plan kept the
   * pool on without a break. Absent in references frozen before it existed.
   */
  pool_run_quarters?: number | null;
  battery: {
    operation: Exclude<BatteryOperation, "self_consumption">;
    charge_w: number;
    discharge_w: number;
  } | null;
}
export interface ReplanDecision {
  source_plan_id: string;
  selected: "proposed" | "direct" | "repaired" | "held";
  reason: string;
  proposed_sek: number | null;
  reference_sek: number | null;
  deadband_sek: number;
  /** Present when a running pool was held or deliberately let go. */
  held_run?: { quarters: number; held_sek: number; release_sek: number; released: boolean };
}
export interface ContinuityProblem {
  slots: DispatchSlot[];
  stores: DispatchStore[];
  limits: DispatchLimits;
  result: DispatchResult;
}
export interface ContinuityCandidate {
  construction: "direct" | "repaired" | "held";
  result: DispatchResult;
  objective_sek: number;
}

/** Fields read by continuity; the database omits other scenarios and diagnostics. */
export type ReplanPreviousPlan = Pick<OptimisationPlan,
  "status" | "schema_version" | "plan_id" | "fixed_plan" | "mode" |
  "capabilities" | "issued_at" | "valid_until"
> & {
  pool?: OptimisationPlan["pool"];
  plans: { priority: Pick<OptimisationPlan["plans"]["priority"],
    "status" | "dispatched_devices"
  > & {
    slots: Pick<OptimisationPlan["plans"]["priority"]["slots"][number],
      "start" | "binding" | "pool_w" | "pool_command_w" | "battery_command" |
      "battery_charge_w" | "battery_discharge_w"
    >[];
  } };
};

/** Only the server's last issued plan supplies the reference; freeze it into the replay snapshot. */
export function replanReference(
  previous: ReplanPreviousPlan | null,
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
  const previousSlots = previous.plans?.priority?.slots ?? [];
  const index = previousSlots.findIndex((s) =>
    Date.parse(s.start) === Date.parse(current?.start ?? "")
  );
  const slot = previousSlots[index];
  if (!slot?.binding || previous.plans.priority.status !== "ready") return null;
  let poolRun = 0;
  const poolOn = (s: typeof slot) => previous.pool?.heater_response?.kind === "bergvarme" ? s.pool_command_w! > 0 : s.pool_w > 0;
  while (previousSlots[index + poolRun]?.binding && poolOn(previousSlots[index + poolRun])) poolRun += 1;
  const batteryDispatched = previous.plans.priority.dispatched_devices.includes("battery");
  const command = slot.battery_command;
  // Forecast watts alone cannot preserve which source or destination was authorized.
  if (batteryDispatched && (!command || command.schema_version !== 3 || command.operation === "self_consumption")) return null;
  const reference: ReplanReference = {
    version: 2,
    source_plan_id: previous.plan_id,
    issued_at: previous.issued_at,
    evaluated_at: now.toISOString(),
    valid_until: previous.valid_until,
    slot_start: slot.start,
    store_keys: previous.plans.priority.dispatched_devices,
    pool_heat: previous.plans.priority.dispatched_devices.includes("pool")
      ? poolOn(slot)
      : null,
    pool_run_quarters: previous.plans.priority.dispatched_devices.includes("pool")
      ? poolRun
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
    (reference.pool_run_quarters == null ||
      (Number.isInteger(reference.pool_run_quarters) && reference.pool_run_quarters >= 0 &&
        (reference.pool_run_quarters === 0) === !reference.pool_heat)) &&
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
    case "idle":
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

/**
 * The plan that keeps an already-running pool on to the end of its previous run.
 *
 * A running load is held, a planned one is not: until the pool has actually
 * switched on, moving its start costs nothing physical, so the proposal stands.
 * Once it is on, construct an alternative holding only the pool profile and
 * re-plan the other stores around it. This alternative is compared economically
 * with the free proposal; it creates no runtime obligation.
 *
 * Returns null when there is nothing to hold or the proposal already holds it.
 */
export function heldRunCandidate(
  problem: ContinuityProblem,
  reference: ReplanReference,
  poolRunning: boolean,
  solveAuction?: DispatchAuctionSolver,
): ContinuityCandidate | null {
  const { slots, stores, limits, result } = problem;
  const quarters = Math.min(reference.pool_run_quarters ?? 0, slots.length);
  const pool = stores.find((store) => store.key === "pool");
  if (!poolRunning || !pool || quarters < 1) return null;
  if (result.power_w.pool.slice(0, quarters).every((watts) => watts > 0)) return null;
  const profile = result.power_w.pool.map((_, index) =>
    index < quarters ? pool.max_power_w : null
  );
  let solved: DispatchResult;
  try {
    solved = dispatchWithStoreProfile(slots, stores, limits, pool.key, profile, solveAuction);
  } catch (error) {
    if (!(error instanceof DispatchPrefixInfeasible)) throw error;
    return null;
  }
  // Judged by the same stores as the proposal, so the comparison is only the
  // schedule, never a different objective.
  const score = scoreDispatch(slots, stores, limits, solved);
  if (score.infeasibilities.length || !Number.isFinite(score.total_sek)) return null;
  return {
    construction: "held",
    objective_sek: score.total_sek,
    result: { ...solved, state: score.state, import_w: score.import_w, export_w: score.export_w },
  };
}
