/** Exact conditional battery economics. This record grants no physical authority. */
import type {
  DispatchLimits,
  DispatchSlot,
  DispatchStore,
} from "./dispatch-plan.ts";
import {
  type HouseholdCandidate,
  type HouseholdProblem,
  parseHouseholdProblem,
} from "./household-case.ts";
import { createHouseholdScorer } from "./household-score.ts";
import type { OperatingScope } from "./operating-scope.ts";
import { totalUtility } from "./store-value.ts";

/** Captured before display rounding, after all non-battery scheduling. */
export interface BatteryProjectionRow {
  start: string;
  end: string;
  house_w: number;
  /** Includes external demand in the execution branch; this is not graph base load. */
  residual_w: number;
  device_loads_w: Record<string, number>;
  charge_w: number;
  discharge_w: number;
  export_w: number;
  curtailed_w: number;
  unserved_w: number;
}
export interface BatteryProjectionIdentity {
  snapshot_id: string;
  model_version: string;
  issued_at: string;
  branch: "execution" | "priority" | "battery_verification";
  operating_scope: OperatingScope | null;
}
export interface ResolvedBatterySource {
  identity: BatteryProjectionIdentity;
  rows: BatteryProjectionRow[];
  slots: DispatchSlot[];
  store: DispatchStore;
  limits: DispatchLimits;
}
export type BatteryProjection = {
  status: "unsupported";
  reasons: string[];
} | {
  status: "ready";
  problem: HouseholdProblem;
  selected_candidate: HouseholdCandidate;
  /** Add to household total to reproduce the conditional dispatch total. */
  dispatch_total_offset_sek: number;
  provenance: BatteryProjectionIdentity & {
    state_basis: "usable_kwh_above_min_soc";
    objective: "conditional_final_non_battery_schedule";
    final_demand: BatteryProjectionRow[];
    /** Bidding heuristics do not constitute physical grid-charge permission. */
    permission_basis: "dispatch_feasibility_not_actuator_authority";
  };
};

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * One resolved production store, with the final household schedule held fixed.
 * Unsupported constraints are explicit; callers must not use the display plan
 * as a substitute. Native grants, scope and commissioning still belong to the
 * policy-request boundary, not this economic projection.
 */
export function projectBatteryDispatch(
  source: ResolvedBatterySource,
): BatteryProjection {
  const { rows, slots, store, limits } = source;
  const reasons: string[] = [];
  const reject = (reason: string) => reasons.push(reason);
  if (!rows.length || rows.length !== slots.length) {
    reject("capture_length_mismatch");
  }
  if (limits.grid_import_shaping_w !== 0) reject("nonzero_shaping_threshold");
  if (rows.some((r) => r.curtailed_w > 1e-7 || r.unserved_w > 1e-7)) {
    reject("curtailment_or_unserved_energy");
  }
  if (store.key !== "battery" || !store.discharge) {
    reject("missing_resolved_battery");
  }
  if (
    store.min_state !== 0 || store.curve.unit !== "kwh" ||
    store.retention_per_slot !== 1 ||
    store.terminal_weight !== 1 || store.usage_weight.length !== rows.length ||
    store.usage_weight.some((w) => w !== 0) ||
    (store.wear_sek_per_kwh ?? 0) !== 0 ||
    (store.min_power_w ?? 0) !== 0 || (store.power_step_w ?? 0) !== 0 ||
    (store.start_cost_sek ?? 0) !== 0
  ) reject("unsupported_battery_objective");
  if (
    !store.slot_hours || store.slot_hours.length !== rows.length ||
    rows.some((r, i) =>
      Math.abs(
          (Date.parse(r.end) - Date.parse(r.start)) / 3_600_000 -
            store.slot_hours![i],
        ) > 1e-10 ||
      slots[i]?.duration_hours !== store.slot_hours![i]
    )
  ) reject("capture_duration_mismatch");
  if (
    rows.some((r) =>
      !Number.isFinite(r.house_w) || !Number.isFinite(r.residual_w) ||
      r.residual_w < 0 ||
      Object.values(r.device_loads_w).some((w) =>
        !Number.isFinite(w) || w < 0
      ) ||
      Math.abs(
          r.house_w - r.residual_w -
            Object.values(r.device_loads_w).reduce((a, b) => a + b, 0),
        ) > 1e-6
    )
  ) {
    reject("invalid_household_partition");
  }
  const discharge = store.discharge;
  // No schema default for resolved export permissions or degradation.
  if (
    !discharge?.export_allowed_by_slot ||
    discharge.export_allowed_by_slot.length !== rows.length ||
    discharge.cycling_cost_sek_per_unit === undefined
  ) reject("missing_resolved_permissions_or_wear");
  if (
    discharge?.export_allowed &&
    discharge.export_allowed_by_slot?.some(Boolean) &&
    (discharge.export_min_state ?? 0) !== 0
  ) reject("positive_export_reserve");
  if (reasons.length) return { status: "unsupported", reasons };

  const etaCharge = store.units_per_kwh(store.initial_state, 0);
  const statePerKwh = discharge!.state_per_kwh_out(store.initial_state, 0);
  // This projector is for the production constant-efficiency, lossless-idle store.
  // Probe bounds as well as initial state to reject other resolved store families.
  if (
    rows.some((_, i) =>
      [store.min_state, store.initial_state, store.max_state].some((state) =>
        store.units_per_kwh(state, i) !== etaCharge ||
        discharge!.state_per_kwh_out(state, i) !== statePerKwh ||
        store.drift(state, i) !== state
      )
    )
  ) {
    return { status: "unsupported", reasons: ["nonconstant_battery_physics"] };
  }
  let problem: HouseholdProblem;
  try {
    problem = parseHouseholdProblem({
      schema_version: 2,
      identity: {
        case_id:
          `${source.identity.snapshot_id}:${source.identity.branch}:battery`,
        intent_revision: source.identity.snapshot_id,
        model_revision: source.identity.model_version,
        actuals_watermark: rows[0].start,
        provenance: "resolved",
      },
      intervals: rows.map(({ start, end }) => ({ start, end })),
      plant: {
        grid: {
          import_limit_w: limits.grid_import_limit_w,
          export_limit_w: limits.grid_export_limit_w,
        },
        pv_w: slots.map((s) => s.pv_w),
        residual_loads: [{
          id: "final_household_consumption",
          power_w: rows.map((r) => r.house_w),
        }],
        thermal_stores: [],
        equipment: [{
          id: "battery",
          kind: "battery",
          model_id: source.identity.model_version,
          available: rows.map(() => true),
          state_kwh: {
            initial: store.initial_state,
            min: store.min_state,
            max: store.max_state,
            provenance: "selected_dispatch_store:usable_kwh_above_min_soc",
          },
          charge_max_w: store.max_power_w,
          discharge_max_w: discharge!.max_power_w,
          charge_efficiency: etaCharge,
          discharge_efficiency: 1 / statePerKwh,
          wear_basis: "discharged_storage",
          wear_sek_per_kwh: discharge!.cycling_cost_sek_per_unit,
          grid_charge_allowed: rows.map(() => true),
          export_allowed: discharge!.export_allowed_by_slot!.map((allowed) =>
            discharge!.export_allowed && allowed
          ),
        }],
      },
      economics: {
        tariff: "energy_only",
        import_sek_per_kwh: slots.map((s) => s.import_price_sek_per_kwh),
        export_sek_per_kwh: slots.map((s) => s.export_price_sek_per_kwh),
        shaping_sek_per_kwh_per_kw: limits.peak_shaping_sek_per_kwh_per_kw,
        ramp_sek_per_kw: limits.grid_ramp_sek_per_kw ?? 0,
        // Dispatch has no initial-to-first-slot ramp charge.
        initial_import_w: null,
        services: [],
        completed_event_ids: [],
        terminal: [{
          id: "battery_terminal",
          store_id: "battery",
          curve: store.curve,
          coverage_from: rows.at(-1)!.end,
          model_id: source.identity.model_version,
          event_ids: [],
        }],
      },
    });
  } catch {
    return { status: "unsupported", reasons: ["invalid_resolved_model"] };
  }
  const selected_candidate: HouseholdCandidate = {
    id: "selected_materialization",
    pv_curtail_w: rows.map(() => 0),
    actions: {
      battery: rows.map((r, i) => ({
        kind: "battery",
        charge_w: r.charge_w,
        discharge_w: r.discharge_w,
        solar_charge_w: Math.min(
          r.charge_w,
          Math.max(0, slots[i].pv_w - r.house_w),
        ),
        export_w: r.export_w,
      })),
    },
  };
  const score = createHouseholdScorer(problem).score(selected_candidate);
  if (score.status !== "scored") {
    return {
      status: "unsupported",
      reasons: ["selected_conditional_schedule_infeasible"],
    };
  }
  return freeze({
    status: "ready",
    problem,
    selected_candidate,
    dispatch_total_offset_sek: totalUtility(store.curve, store.initial_state),
    provenance: {
      ...structuredClone(source.identity),
      state_basis: "usable_kwh_above_min_soc",
      objective: "conditional_final_non_battery_schedule",
      final_demand: structuredClone(rows),
      permission_basis: "dispatch_feasibility_not_actuator_authority",
    },
  });
}
