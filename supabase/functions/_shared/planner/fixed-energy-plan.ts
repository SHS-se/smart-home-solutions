import {
  type DispatchAuctionSolver,
  type DispatchLimits,
  type DispatchResult,
  type DispatchSchedule,
  type DispatchSlot,
  type DispatchStore,
  planDispatch,
  scoreDispatch,
} from "./dispatch-plan.ts";
import type {
  OptimisationPlan,
  OptimisationSnapshot,
  PlannedSlot,
} from "./energy-optimisation.ts";
import type { StoredPriceRow } from "./energy-price-shape.ts";

/** Everything one planning run reads. */
export interface EnergyPlanningInput {
  snapshot: OptimisationSnapshot;
  now: string;
  price_archive: StoredPriceRow[];
  fixed_plan?: FixedEnergyPlan | null;
  resolved_price_outlook?: OptimisationPlan["price_outlook"];
}

export const QUARTER_MS = 15 * 60_000;
export interface FixedEnergyPlan {
  id: string;
  starts_at: string;
  ends_at: string;
  source_snapshot_id: string;
  /** Absolute timestamps, never indices into a later rolling horizon. */
  slots: {
    start: string;
    power_w: Record<string, number>;
    discharge_w: Record<string, number>;
    targets: PlannedSlot;
    allow_export: boolean;
  }[];
}

/**
 * What activation asks the planner to materialise. Preflight is judged at the
 * reviewed snapshot's own capture time and against the prices the household
 * reviewed; HA receives a later generation from fresh measurements.
 */
export function fixedPlanPreflightInput(
  snapshot: OptimisationSnapshot,
  priceOutlook: OptimisationPlan["price_outlook"],
  fixed: FixedEnergyPlan,
): EnergyPlanningInput {
  return {
    snapshot,
    now: snapshot.captured_at,
    price_archive: [],
    resolved_price_outlook: priceOutlook,
    fixed_plan: fixed,
  };
}

export function validateFixedSchedule(
  starts: number[],
  stores: DispatchStore[],
  schedule: DispatchSchedule,
): void {
  const keys = stores.map((s) => s.key).sort().join("|");
  for (const field of ["power_w", "discharge_w"] as const) {
    if (
      !schedule?.[field] ||
      Object.keys(schedule[field]).sort().join("|") !== keys
    ) {
      throw new Error(
        "The edited plan must contain every store. Reload the plan.",
      );
    }
    for (const values of Object.values(schedule[field])) {
      if (
        !Array.isArray(values) || values.length !== starts.length ||
        values.some((v) =>
          typeof v !== "number" || !Number.isFinite(v) || v < 0
        )
      ) throw new Error("Invalid power allocation in edited plan.");
    }
  }
  if (
    schedule.allow_export &&
    (schedule.allow_export.length !== starts.length ||
      schedule.allow_export.some((v) => typeof v !== "boolean"))
  ) throw new Error("Invalid export permissions.");
}

/** Solve only the suffix, starting from the state produced by the fixed prefix. */
export function dispatchWithFixedPlan(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  starts: number[],
  fixed?: FixedEnergyPlan | null,
  solveAuction?: DispatchAuctionSolver,
): DispatchResult {
  const matching = new Map(
    fixed?.slots.map((s) => [Date.parse(s.start), s]) ?? [],
  );
  let end = 0;
  for (let i = 0; i < starts.length; i++) {
    if (matching.has(starts[i])) end = i + 1;
  }
  if (!end) return planDispatch(slots, stores, limits, { solveAuction });
  const keys = stores.map((s) => s.key).sort().join("|");
  const before = matching.has(starts[0])
    ? null
    : planDispatch(slots, stores, limits, { solveAuction });
  const schedule: DispatchSchedule = {
    power_w: {},
    discharge_w: {},
    allow_export: starts.slice(0, end).map((start) =>
      matching.get(start)?.allow_export === true
    ),
  };
  for (const field of ["power_w", "discharge_w"] as const) {
    for (const store of stores) {
      schedule[field][store.key] = starts.slice(0, end).map((start, i) => {
        const slot = matching.get(start);
        if (slot && Object.keys(slot[field]).sort().join("|") !== keys) {
          throw new Error(
            "Fixed plan device inventory changed; rescind the fixed plan to replan.",
          );
        }
        return slot ? slot[field][store.key] : before![field][store.key][i];
      });
    }
  }
  return dispatchWithPrefix(slots, stores, limits, schedule, end, solveAuction);
}

/** Expected constraint rejection, distinct from worker continuation and solver errors. */
export class DispatchPrefixInfeasible extends Error {}

/** Project a specified prefix and jointly solve its remaining horizon. */
export function dispatchWithPrefix(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  allocation: DispatchSchedule,
  end: number,
  solveAuction?: DispatchAuctionSolver,
): DispatchResult {
  const schedule = structuredClone(allocation);
  const prefix = scoreDispatch(
    slots.slice(0, end),
    stores.map((s) => ({ ...s, usage_weight: s.usage_weight.slice(0, end) })),
    limits,
    schedule,
  );
  // Do not silently clamp an invalid fixed trajectory and then optimise from it.
  if (prefix.infeasibilities.length) {
    throw new DispatchPrefixInfeasible(
      `Fixed plan cannot execute: ${
        prefix.infeasibilities.map((i) => i.message).join("; ")
      }`,
    );
  }
  const suffixStores = stores.map((s) => ({
    ...s,
    initial_state: prefix.state[s.key][end],
    initially_charging: schedule.power_w[s.key][end - 1] > 0,
    usage_weight: s.usage_weight.slice(end),
    slot_hours: s.slot_hours?.slice(end),
    units_per_kwh: (state: number, i: number) =>
      s.units_per_kwh(state, i + end),
    drift: (state: number, i: number) => s.drift(state, i + end),
    discharge: s.discharge
      ? {
        ...s.discharge,
        export_allowed_by_slot: s.discharge.export_allowed_by_slot?.slice(end),
        state_per_kwh_out: (state: number, i: number) =>
          s.discharge!.state_per_kwh_out(state, i + end),
      }
      : undefined,
  }));
  const suffix = end < slots.length
    ? planDispatch(slots.slice(end), suffixStores, limits, { solveAuction })
    : null;
  for (const field of ["power_w", "discharge_w"] as const) {
    for (const store of stores) {
      schedule[field][store.key].push(...(suffix?.[field][store.key] ?? []));
    }
  }
  schedule.allow_export?.push(...slots.slice(end).map(() => false));
  const scored = scoreDispatch(slots, stores, limits, schedule);
  if (scored.infeasibilities.length) {
    throw new DispatchPrefixInfeasible(
      `Fixed plan continuation is infeasible: ${
        scored.infeasibilities.map((i) => i.message).join("; ")
      }`,
    );
  }
  return {
    ...schedule,
    state: scored.state,
    import_w: scored.import_w,
    export_w: scored.export_w,
    // A fixed decision is not an economic bid. Do not invent auction evidence.
    allocations: [
      ...slots.slice(0, end).map(() => []),
      ...(suffix?.allocations.map((parts) =>
        parts.map((p) => ({ ...p, run_start_index: p.run_start_index + end }))
      ) ?? []),
    ],
    battery: [
      ...slots.slice(0, end).map(() => null),
      ...(suffix?.battery ?? []),
    ],
    stopped_because: suffix?.stopped_because ?? "no_profitable_candidate",
    iterations: suffix?.iterations ?? 0,
  };
}

/** Solve the other stores around one specified profile, then validate jointly.
 * Used to price an economic continuity alternative; it is not an actuator lock.
 */
export function dispatchWithStoreProfile(
  slots: DispatchSlot[],
  stores: DispatchStore[],
  limits: DispatchLimits,
  key: string,
  profile: (number | null)[],
  solveAuction?: DispatchAuctionSolver,
): DispatchResult {
  if (!stores.some(store => store.key === key) || profile.length !== slots.length) {
    throw new Error("Store profile must name a store and cover the horizon");
  }
  const solved = planDispatch(slots,
    stores.map(store => store.key === key ? { ...store, fixed_charge_w_by_slot: profile } : store),
    limits, { solveAuction });
  const score = scoreDispatch(slots, stores, limits, solved);
  if (score.infeasibilities.length || !Number.isFinite(score.total_sek)) {
    throw new DispatchPrefixInfeasible(`Store profile cannot execute: ${score.infeasibilities.map(item => item.message).join("; ")}`);
  }
  return { ...solved, state: score.state, import_w: score.import_w, export_w: score.export_w };
}
