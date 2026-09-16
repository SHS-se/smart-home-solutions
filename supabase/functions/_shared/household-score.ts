/** One objective over complete resolved household candidates; offline only. */
import { totalUtility, type UtilityCurve } from "./store-value.ts";
import {
  candidateIssues,
  type Equipment,
  type HouseholdCandidate,
  householdCandidateSchema,
  type HouseholdProblem,
  parseHouseholdProblem,
  type Violation,
} from "./household-case.ts";
import {
  materializeHousehold,
  type PhysicalInterval,
  type PhysicalTrajectory,
} from "./household-physics.ts";

export const HOUSEHOLD_SCORER_VERSION = "offline-household-v2";
export interface Objective {
  import_sek: number;
  export_sek: number;
  wear_sek: number;
  starts_sek: number;
  shaping_sek: number;
  ramp_sek: number;
  service_sek: number;
  terminal_sek: number;
  billable_sek: number;
  total_sek: number;
}
export const emptyObjective = (): Objective => ({
  import_sek: 0,
  export_sek: 0,
  wear_sek: 0,
  starts_sek: 0,
  shaping_sek: 0,
  ramp_sek: 0,
  service_sek: 0,
  terminal_sek: 0,
  billable_sek: 0,
  total_sek: 0,
});
export const reconcileObjective = (v: Objective): Objective => ({
  ...v,
  billable_sek: v.import_sek - v.export_sek,
  total_sek: v.import_sek - v.export_sek + v.wear_sek + v.starts_sek +
    v.shaping_sek + v.ramp_sek - v.service_sek - v.terminal_sek,
});
/** Duration-based electricity account shared by trajectory and native-response scoring.
 * Hours are not rounded through timestamps; a native saturation can occur between ms.
 */
export function scoreElectricityInterval(input: {
  hours: number;
  import_w: number;
  export_w: number;
  previous_import_w: number | null;
  import_sek_per_kwh: number;
  export_sek_per_kwh: number;
  shaping_sek_per_kwh_per_kw: number;
  ramp_sek_per_kw: number;
}): Objective {
  const result = emptyObjective();
  const imported = input.import_w / 1000, exported = input.export_w / 1000;
  result.import_sek = imported * input.hours * input.import_sek_per_kwh;
  result.export_sek = exported * input.hours * input.export_sek_per_kwh;
  result.shaping_sek = 0.5 * input.shaping_sek_per_kwh_per_kw * imported ** 2 *
    input.hours;
  if (input.previous_import_w !== null) {
    result.ramp_sek = Math.abs(input.import_w - input.previous_import_w) /
      1000 * input.ramp_sek_per_kw;
  }
  return reconcileObjective(result);
}

export type HouseholdScore =
  | { status: "invalid_candidate"; violations: Violation[] }
  | {
    status: "physically_infeasible";
    trajectory: PhysicalTrajectory;
    violations: Violation[];
  }
  | {
    status: "scored";
    candidate_id: string;
    identity: HouseholdProblem["identity"];
    scorer_version: string;
    trajectory: PhysicalTrajectory;
    objective: Objective;
    intervals: { start: string; end: string; objective: Objective }[];
    closing: Objective;
    service_values: Record<string, number>;
    terminal_values: Record<string, number>;
  };

/** Exact for the declared linear state path and existing piecewise-quadratic utility. */
function meanUtility(
  curve: UtilityCurve,
  before: number,
  after: number,
): number {
  if (Math.abs(after - before) < 1e-12) return totalUtility(curve, before);
  const low = Math.min(before, after), high = Math.max(before, after);
  const points = [
    low,
    ...curve.points.map((p) => p.at).filter((v) => v > low && v < high),
    high,
  ];
  let integral = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    integral += (b - a) *
      (totalUtility(curve, a) + 4 * totalUtility(curve, (a + b) / 2) +
        totalUtility(curve, b)) /
      6;
  }
  return integral / (high - low);
}

/** Shared wear account for complete trajectories and incremental battery search. */
function equipmentWear(
  e: Exclude<Equipment, { kind: "heater" }>,
  physical: PhysicalInterval,
  action: HouseholdCandidate["actions"][string][number],
  hours: number,
): number {
  return (e.kind === "battery" && e.wear_basis === "discharged_storage"
    ? e.conversion && action.kind === "battery"
      ? action.discharge_w * hours / 1000
      : physical.discharge_kwh[e.id] / e.discharge_efficiency
    : physical.charge_kwh[e.id] + physical.discharge_kwh[e.id]) *
    e.wear_sek_per_kwh;
}

/** Sufficient immutable state for the single-battery, service-free objective. */
export interface BatteryPrefix {
  length: number;
  energy_kwh: number;
  import_w: number | null;
  objective: Objective;
}
type BatteryPrefixResult =
  | { status: "scored"; prefix: BatteryPrefix }
  | {
    status: "invalid_candidate" | "physically_infeasible";
    violations: Violation[];
  };

/** Advance one interval through the same physics and accounts as the full scorer.
 * No previous interval is reparsed/materialized. Final witnesses still require a full score.
 */
export function createBatteryPrefixScorer(input: unknown) {
  const problem = parseHouseholdProblem(input);
  const { plant, economics: econ } = problem;
  const battery = plant.equipment[0];
  if (
    plant.equipment.length !== 1 || battery.kind !== "battery" ||
    plant.thermal_stores.length || econ.services.length
  ) {
    throw new Error(
      "Incremental battery scoring requires one battery and no household services",
    );
  }
  const slots = problem.intervals.map((interval, i) => ({
    hours: (Date.parse(interval.end) - Date.parse(interval.start)) / 3600000,
    plant: {
      ...plant,
      pv_w: [plant.pv_w[i]],
      residual_loads: plant.residual_loads.map((l) => ({
        ...l,
        power_w: [l.power_w[i]],
      })),
      equipment: [{
        ...battery,
        available: [battery.available[i]],
        grid_charge_allowed: [battery.grid_charge_allowed[i]],
        export_allowed: [battery.export_allowed[i]],
      }],
    },
  }));
  const initial: BatteryPrefix = {
    length: 0,
    energy_kwh: battery.state_kwh.initial,
    import_w: econ.initial_import_w,
    objective: emptyObjective(),
  };
  const extend = (
    prefix: BatteryPrefix,
    action: Extract<
      HouseholdCandidate["actions"][string][number],
      { kind: "battery" }
    >,
    curtailedW: number,
  ): BatteryPrefixResult => {
    const i = prefix.length;
    if (!Number.isInteger(i) || i < 0 || i >= slots.length) {
      throw new RangeError("Battery prefix is outside the horizon");
    }
    const parsed = householdCandidateSchema.safeParse({
      id: "incremental",
      actions: { [battery.id]: [action] },
      pv_curtail_w: [curtailedW],
    });
    if (!parsed.success) {
      return {
        status: "invalid_candidate",
        violations: parsed.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      };
    }
    const candidate = parsed.data as HouseholdCandidate;
    const slot = slots[i], e = slot.plant.equipment[0];
    const trajectory = materializeHousehold(
      {
        ...slot.plant,
        equipment: [{
          ...e,
          state_kwh: { ...e.state_kwh, initial: prefix.energy_kwh },
        }],
      },
      [slot.hours],
      candidate,
    );
    if (trajectory.violations.length) {
      return {
        status: "physically_infeasible",
        violations: trajectory.violations.map((v) => ({
          ...v,
          path: v.path.replace(/^intervals\.0/, `intervals.${i}`),
        })),
      };
    }
    const physical = trajectory.intervals[0];
    const account = scoreElectricityInterval({
      hours: slot.hours,
      import_w: physical.import_w,
      export_w: physical.export_w,
      previous_import_w: prefix.import_w,
      import_sek_per_kwh: econ.import_sek_per_kwh[i],
      export_sek_per_kwh: econ.export_sek_per_kwh[i],
      shaping_sek_per_kwh_per_kw: econ.shaping_sek_per_kwh_per_kw,
      ramp_sek_per_kw: econ.ramp_sek_per_kw,
    });
    account.wear_sek += equipmentWear(
      battery,
      physical,
      candidate.actions[battery.id][0],
      slot.hours,
    );
    const energy = trajectory.state[battery.id][1];
    const total = { ...prefix.objective };
    for (const key of Object.keys(total) as (keyof Objective)[]) {
      total[key] += account[key];
    }
    if (i === slots.length - 1) {
      // Same closing account and summation order as complete trajectory scoring.
      let terminal = 0;
      for (const t of econ.terminal) terminal += totalUtility(t.curve, energy);
      total.terminal_sek += terminal;
    }
    const objective = reconcileObjective(total);
    if (Object.values(objective).some((v) => !Number.isFinite(v))) {
      return {
        status: "invalid_candidate",
        violations: [{
          path: "objective",
          message: "numeric overflow while scoring",
        }],
      };
    }
    return {
      status: "scored",
      prefix: {
        length: i + 1,
        energy_kwh: energy,
        import_w: physical.import_w,
        objective,
      },
    };
  };
  return { initial, extend };
}

export function createHouseholdScorer(input: unknown) {
  const problem = parseHouseholdProblem(input); // zod creates an owned deep copy
  const { plant, economics: econ } = problem;
  const hours = problem.intervals.map((v) =>
    (Date.parse(v.end) - Date.parse(v.start)) / 3600000
  );
  const equipment = new Map(plant.equipment.map((e) => [e.id, e]));
  const boundary = new Map(
    problem.intervals.map((v, i) => [Date.parse(v.start), i]),
  );
  boundary.set(Date.parse(problem.intervals.at(-1)!.end), hours.length);
  const score = (input: unknown): HouseholdScore => {
    const parsed = householdCandidateSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: "invalid_candidate",
        violations: parsed.error.issues.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      };
    }
    const candidate = parsed.data as HouseholdCandidate;
    const malformed = candidateIssues(problem, candidate);
    if (malformed.length) {
      return { status: "invalid_candidate", violations: malformed };
    }
    const trajectory = materializeHousehold(plant, hours, candidate);
    if (trajectory.violations.length) {
      return {
        status: "physically_infeasible",
        trajectory,
        violations: trajectory.violations,
      };
    }
    const rows = trajectory.intervals.map((physical, i) => {
      const objective = scoreElectricityInterval({
        hours: hours[i],
        import_w: physical.import_w,
        export_w: physical.export_w,
        previous_import_w: i > 0
          ? trajectory.intervals[i - 1].import_w
          : econ.initial_import_w,
        import_sek_per_kwh: econ.import_sek_per_kwh[i],
        export_sek_per_kwh: econ.export_sek_per_kwh[i],
        shaping_sek_per_kwh_per_kw: econ.shaping_sek_per_kwh_per_kw,
        ramp_sek_per_kw: econ.ramp_sek_per_kw,
      });
      for (const e of plant.equipment) {
        if (e.kind !== "heater") {
          objective.wear_sek += equipmentWear(
            e,
            physical,
            candidate.actions[e.id][i],
            hours[i],
          );
        }
      }
      for (const key of physical.starts) {
        const e = equipment.get(key)!;
        if (e.kind === "heater") objective.starts_sek += e.start_cost_sek;
      }
      return { ...problem.intervals[i], objective };
    });
    const closing = emptyObjective();
    const serviceValues: Record<string, number> = Object.create(null);
    for (const service of econ.services) {
      const values = trajectory.state[service.store_id];
      serviceValues[service.id] = 0;
      if (service.kind === "continuous") {
        rows.forEach((r, i) => {
          const value =
            meanUtility(service.curves[i], values[i], values[i + 1]) * hours[i];
          r.objective.service_sek += value;
          serviceValues[service.id] += value;
        });
      } else if (!econ.completed_event_ids.includes(service.id)) {
        const index = boundary.get(Date.parse(service.at));
        if (index !== undefined) {
          const value = totalUtility(service.curve, values[index]);
          (index === rows.length ? closing : rows[index].objective)
            .service_sek += value;
          serviceValues[service.id] = value;
        }
      }
    }
    const terminalValues: Record<string, number> = Object.create(null);
    for (const t of econ.terminal) {
      const value = totalUtility(t.curve, trajectory.state[t.store_id].at(-1)!);
      closing.terminal_sek += value;
      terminalValues[t.id] = value;
    }
    const total = emptyObjective();
    for (const account of [...rows.map((r) => r.objective), closing]) {
      for (const key of Object.keys(total) as (keyof Objective)[]) {
        total[key] += account[key];
      }
    }
    const objective = reconcileObjective(total);
    if (Object.values(objective).some((v) => !Number.isFinite(v))) {
      return {
        status: "invalid_candidate",
        violations: [{
          path: "objective",
          message: "numeric overflow while scoring",
        }],
      };
    }
    return {
      status: "scored",
      candidate_id: candidate.id,
      identity: structuredClone(problem.identity),
      scorer_version: HOUSEHOLD_SCORER_VERSION,
      trajectory,
      objective,
      intervals: rows.map((r) => ({
        ...r,
        objective: reconcileObjective(r.objective),
      })),
      closing: reconcileObjective(closing),
      service_values: serviceValues,
      terminal_values: terminalValues,
    };
  };
  return { score };
}
