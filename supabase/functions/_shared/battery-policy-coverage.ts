/** Offline empirical value bands. This profile never authorizes device commands. */
import { z } from "zod";
import {
  BATTERY_POLICY_LIMITS,
  BATTERY_POLICY_VERSION,
  batteryPolicyRequestSchema,
  compileBatteryPolicy,
} from "./battery-policy.ts";
import {
  type HouseholdProblem,
  parseHouseholdProblem,
} from "./planner/household-case.ts";
import {
  createHouseholdScorer,
  HOUSEHOLD_SCORER_VERSION,
  type Objective,
} from "./planner/household-score.ts";

export const BATTERY_COVERAGE_VERSION = "offline-battery-coverage-v1";
const axis = z.array(z.number().finite()).min(2).max(6);
const requestSchema = z.object({
  source: batteryPolicyRequestSchema,
  axes: z.object({
    at_ms: axis,
    energy_kwh: axis,
  }).strict(),
  acceptance: z.object({
    max_component_error_sek: z.number().finite().nonnegative(),
    max_ranking_regret_sek: z.number().finite().nonnegative(),
  }).strict(),
}).strict();
type Source = z.infer<typeof batteryPolicyRequestSchema>;
interface Coordinate {
  at_ms: number;
  energy_kwh: number;
}
interface Values {
  id: string;
  current: Objective;
  future_delta: Objective;
  full: Objective;
  total_delta_sek: number;
}
type Sample =
  & Coordinate
  & (
    | { status: "available"; values: Values[]; idle_suffix_witness: boolean }
    | { status: "unavailable"; reason: string; detail: string }
  );
interface ErrorEvidence extends Coordinate {
  max_component_error_sek: number;
  ranking_regret_sek: number;
  estimated_winner: string;
  solved_winner: string;
}
interface Cell {
  id: string;
  at_ms: [number, number];
  energy_kwh: [number, number];
  corner_indices: number[];
  held_out_indices: number[];
  status: "accepted_empirical" | "excluded";
  reasons: string[];
  evidence: ErrorEvidence[];
}
interface Coverage {
  status: "compiled";
  coverage_version: typeof BATTERY_COVERAGE_VERSION;
  compiler_version: typeof BATTERY_POLICY_VERSION;
  scorer_version: typeof HOUSEHOLD_SCORER_VERSION;
  execution: "diagnostic_only";
  source: Source & { problem: HouseholdProblem };
  axes: z.infer<typeof requestSchema>["axes"];
  acceptance: z.infer<typeof requestSchema>["acceptance"];
  interpolation: "bilinear_components";
  feasibility: "fixed_idle_suffix_corner_witness";
  certified_error_bound_sek: null;
  samples: Sample[];
  cells: Cell[];
  work: {
    solver_calls: number;
    max_solver_calls: number;
    reserved_interval_evaluations: number;
  };
}
class Rejection extends Error {}
function fail(detail: string): never {
  throw new Rejection(detail);
}
const bytes = (value: unknown) => {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    fail("Input must be JSON data");
  }
  if (json === undefined) fail("Input must be JSON data");
  return new TextEncoder().encode(json).length;
};
const sorted = (values: number[]) =>
  values.every((v, i) => i === 0 || v > values[i - 1]);
const keys = (objective: Objective) =>
  Object.keys(objective) as (keyof Objective)[];

/** Only these two coordinates may vary. Original source actuals stay in source. */
function at(problem: HouseholdProblem, point: Coordinate): HouseholdProblem {
  const copy = structuredClone(problem);
  const battery = copy.plant.equipment[0];
  if (battery.kind !== "battery") fail("Expected one battery");
  battery.state_kwh.initial = point.energy_kwh;
  copy.intervals[0].start = new Date(point.at_ms).toISOString();
  copy.identity.actuals_watermark = copy.intervals[0].start;
  return copy;
}
function weights(cell: Cell, point: Coordinate): number[] {
  const t = (point.at_ms - cell.at_ms[0]) / (cell.at_ms[1] - cell.at_ms[0]);
  const e = (point.energy_kwh - cell.energy_kwh[0]) /
    (cell.energy_kwh[1] - cell.energy_kwh[0]);
  return [(1 - t) * (1 - e), (1 - t) * e, t * (1 - e), t * e];
}
function interpolate(
  cell: Cell,
  samples: Sample[],
  point: Coordinate,
): Values[] {
  const corners = cell.corner_indices.map((i) => {
    const sample = samples[i];
    if (sample.status !== "available") {
      throw new Error("Unavailable cell corner");
    }
    return sample.values;
  });
  const factors = weights(cell, point);
  return corners[0].map((value, i) => {
    const component = (name: "current" | "future_delta" | "full") =>
      Object.fromEntries(
        keys(value[name]).map((key) => [
          key,
          corners.reduce(
            (sum, corner, j) => sum + factors[j] * corner[i][name][key],
            0,
          ),
        ]),
      ) as unknown as Objective;
    return {
      id: value.id,
      current: component("current"),
      future_delta: component("future_delta"),
      full: component("full"),
      total_delta_sek: corners.reduce(
        (sum, corner, j) => sum + factors[j] * corner[i].total_delta_sek,
        0,
      ),
    };
  });
}
// One stable numerical tie convention for estimates and fresh solves.
function ranking(values: Values[]): string[] {
  const remaining = [...values], result: string[] = [];
  while (remaining.length) {
    const minimum = Math.min(...remaining.map((v) => v.total_delta_sek));
    const tied = remaining.filter((v) => v.total_delta_sek <= minimum + 1e-7)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const value of tied) {
      result.push(value.id);
      remaining.splice(remaining.indexOf(value), 1);
    }
  }
  return result;
}
function errors(
  point: Coordinate,
  estimate: Values[],
  solved: Values[],
): ErrorEvidence {
  let error = 0;
  for (let i = 0; i < solved.length; i++) {
    for (const name of ["current", "future_delta", "full"] as const) {
      for (const key of keys(solved[i][name])) {
        error = Math.max(
          error,
          Math.abs(estimate[i][name][key] - solved[i][name][key]),
        );
      }
    }
    error = Math.max(
      error,
      Math.abs(estimate[i].total_delta_sek - solved[i].total_delta_sek),
    );
  }
  const winner = ranking(estimate)[0];
  return {
    at_ms: point.at_ms,
    energy_kwh: point.energy_kwh,
    max_component_error_sek: error,
    ranking_regret_sek: Math.max(
      0,
      solved.find((v) => v.id === winner)!.total_delta_sek -
        Math.min(...solved.map((v) => v.total_delta_sek)),
    ),
    estimated_winner: winner,
    solved_winner: ranking(solved)[0],
  };
}

function compile(input: unknown): Coverage {
  if (bytes(input) > BATTERY_POLICY_LIMITS.output_bytes) {
    fail("Input exceeds 2 MB");
  }
  const request = requestSchema.parse(input);
  const problem = parseHouseholdProblem(request.source.problem);
  const n = problem.intervals.length, battery = problem.plant.equipment[0];
  if (
    n > 288 || problem.plant.equipment.length !== 1 ||
    battery.kind !== "battery" ||
    problem.plant.thermal_stores.length ||
    problem.plant.residual_loads.length > 32 ||
    problem.economics.services.length ||
    problem.economics.completed_event_ids.length ||
    problem.economics.terminal.length > 1 ||
    problem.economics.terminal.some((t) => t.curve.points.length > 64)
  ) {
    fail(
      "Coverage supports one bounded battery problem without thermal/EV/service models",
    );
  }
  const start = Date.parse(problem.intervals[0].start);
  const end = Date.parse(problem.intervals[0].end);
  if (
    end !== (Math.floor(start / 900000) + 1) * 900000 ||
    request.source.alternatives.some((a) =>
      a.current.actions.length !== 1 || a.current.pv_curtail_w.length !== 1
    )
  ) {
    fail(
      "Coverage needs one constant-response current interval ending at the next UTC quarter",
    );
  }
  const { at_ms: times, energy_kwh: energies } = request.axes;
  if (
    !sorted(times) || !sorted(energies) ||
    times.some((t, i) =>
      !Number.isSafeInteger(t) || t < start || t >= end ||
      (i > 0 && t - times[i - 1] < 2)
    ) ||
    energies.some((e, i) =>
      e < battery.state_kwh.min || e > battery.state_kwh.max ||
      (i > 0 &&
        !((e + energies[i - 1]) / 2 > energies[i - 1] &&
          (e + energies[i - 1]) / 2 < e))
    )
  ) {
    fail(
      "Axes must increase strictly within source time/state bounds and admit distinct midpoint tests",
    );
  }
  const cellCount = (times.length - 1) * (energies.length - 1);
  const maxCalls = times.length * energies.length + 5 * cellCount;
  // Reserve for all potential calls, including duplicated edge tests, before any search.
  const reserved = maxCalls * request.source.alternatives.length *
    (request.source.search.max_interval_evaluations + n);
  if (reserved > BATTERY_POLICY_LIMITS.total_interval_evaluations) {
    fail(
      "Regional worst-case scorer work exceeds 40 million intervals; narrow axes or search",
    );
  }
  const source = { ...request.source, problem };
  const samples: Sample[] = [], cache = new Map<string, number>();
  const sample = (point: Coordinate): number => {
    const key = JSON.stringify(point);
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const resolved = at(problem, point);
    const solved = compileBatteryPolicy({ ...source, problem: resolved });
    let result: Sample;
    if (solved.status !== "compiled") {
      result = {
        ...point,
        status: "unavailable",
        reason: solved.status,
        detail: JSON.stringify(solved),
      };
    } else if (
      solved.omitted.length ||
      solved.coverage.optimality !== "optimal_in_declared_graph"
    ) {
      result = {
        ...point,
        status: "unavailable",
        reason: "incomplete_search",
        detail: JSON.stringify({
          omitted: solved.omitted,
          optimality: solved.coverage.optimality,
        }),
      };
    } else {
      // A separate existence witness, never the economic suffix or a fallback control.
      // Fixed suffix flows + affine current endpoint make corner bounds sufficient.
      const scorer = createHouseholdScorer(resolved);
      const idle = {
        kind: "battery" as const,
        charge_w: 0,
        discharge_w: 0,
        solar_charge_w: 0,
        export_w: 0,
      };
      const witness = solved.alternatives.every((a) => {
        const candidate = structuredClone(a.candidate);
        candidate.actions[battery.id] = [
          candidate.actions[battery.id][0],
          ...Array.from({ length: n - 1 }, () => ({ ...idle })),
        ];
        candidate.pv_curtail_w = candidate.pv_curtail_w.map((curtail, i) =>
          i === 0 ? curtail : Math.max(
            0,
            problem.plant.pv_w[i] -
              problem.plant.residual_loads.reduce(
                (sum, load) => sum + load.power_w[i],
                0,
              ) -
              problem.plant.grid.export_limit_w,
          )
        );
        return scorer.score(candidate).status === "scored";
      });
      result = {
        ...point,
        status: "available",
        idle_suffix_witness: witness,
        values: solved.alternatives.map((a) => ({
          id: a.id,
          current: a.current,
          future_delta: a.future_delta,
          full: a.full,
          total_delta_sek: a.total_delta_sek,
        })),
      };
    }
    const index = samples.length;
    samples.push(result);
    cache.set(key, index);
    return index;
  };
  const cells: Cell[] = [];
  for (let ti = 1; ti < times.length; ti++) {
    for (let ei = 1; ei < energies.length; ei++) {
      const t0 = times[ti - 1],
        t1 = times[ti],
        e0 = energies[ei - 1],
        e1 = energies[ei];
      const tm = t0 + Math.floor((t1 - t0) / 2), em = (e0 + e1) / 2;
      const cell: Cell = {
        id: `t${ti - 1}-e${ei - 1}`,
        at_ms: [t0, t1],
        energy_kwh: [e0, e1],
        corner_indices: [[t0, e0], [t0, e1], [t1, e0], [t1, e1]].map((
          [at_ms, energy_kwh],
        ) => sample({ at_ms, energy_kwh })),
        held_out_indices: [],
        status: "excluded",
        reasons: [],
        evidence: [],
      };
      const corners = cell.corner_indices.map((i) => samples[i]);
      if (corners.some((s) => s.status !== "available")) {
        cell.reasons.push("unavailable_corner");
      }
      if (
        corners.some((s) => s.status === "available" && !s.idle_suffix_witness)
      ) cell.reasons.push("idle_suffix_witness_failed");
      if (!cell.reasons.length) {
        cell.held_out_indices = [[tm, em], [tm, e0], [tm, e1], [t0, em], [
          t1,
          em,
        ]].map(([at_ms, energy_kwh]) => sample({ at_ms, energy_kwh }));
        for (const i of cell.held_out_indices) {
          const held = samples[i];
          if (held.status !== "available") {
            cell.reasons.push("unavailable_held_out");
            continue;
          }
          if (!held.idle_suffix_witness) {
            throw new Error("Corner witness contradicted at held-out point");
          }
          const evidence = errors(
            held,
            interpolate(cell, samples, held),
            held.values,
          );
          cell.evidence.push(evidence);
          if (
            evidence.max_component_error_sek >
              request.acceptance.max_component_error_sek
          ) cell.reasons.push("component_error_exceeded");
          if (
            evidence.ranking_regret_sek >
              request.acceptance.max_ranking_regret_sek
          ) cell.reasons.push("ranking_regret_exceeded");
        }
      }
      cell.reasons = [...new Set(cell.reasons)];
      if (!cell.reasons.length) cell.status = "accepted_empirical";
      cells.push(cell);
    }
  }
  const result: Coverage = {
    status: "compiled",
    coverage_version: BATTERY_COVERAGE_VERSION,
    compiler_version: BATTERY_POLICY_VERSION,
    scorer_version: HOUSEHOLD_SCORER_VERSION,
    execution: "diagnostic_only",
    source,
    axes: request.axes,
    acceptance: request.acceptance,
    interpolation: "bilinear_components",
    feasibility: "fixed_idle_suffix_corner_witness",
    certified_error_bound_sek: null,
    samples,
    cells,
    work: {
      solver_calls: samples.length,
      max_solver_calls: maxCalls,
      reserved_interval_evaluations: reserved,
    },
  };
  if (bytes(result) > BATTERY_POLICY_LIMITS.output_bytes) {
    fail("Coverage output exceeds 2 MB");
  }
  return result;
}

/** Compile all cells or report an input/budget rejection; excluded cells are explicit. */
export function compileBatteryPolicyCoverage(input: unknown) {
  try {
    return compile(input);
  } catch (error) {
    if (
      error instanceof Rejection || error instanceof z.ZodError ||
      (error instanceof Error &&
        error.message.startsWith("Invalid household problem:"))
    ) {
      return { status: "rejected" as const, detail: error.message };
    }
    throw error;
  }
}
export type BatteryCoverageResult = ReturnType<
  typeof compileBatteryPolicyCoverage
>;

/** Trusted in-process offline evaluation, not a wire reader or permission to actuate. */
export function evaluateBatteryPolicyCoverage(
  result: BatteryCoverageResult,
  input: unknown,
) {
  if (result.status !== "compiled") return { status: "unavailable" as const };
  let problem: HouseholdProblem;
  try {
    problem = parseHouseholdProblem(input);
  } catch {
    return { status: "outside_coverage" as const };
  }
  const battery = problem.plant.equipment[0];
  if (
    problem.plant.equipment.length !== 1 || !battery ||
    battery.kind !== "battery"
  ) {
    return { status: "outside_coverage" as const };
  }
  const point = {
    at_ms: Date.parse(problem.intervals[0].start),
    energy_kwh: battery.state_kwh.initial,
  };
  if (
    JSON.stringify(at(problem, point)) !==
      JSON.stringify(at(result.source.problem, point))
  ) return { status: "outside_coverage" as const };
  // Closed outer boundary, deterministic first accepted cell on shared boundaries.
  const cell = result.cells.find((c) =>
    c.status === "accepted_empirical" &&
    point.at_ms >= c.at_ms[0] && point.at_ms <= c.at_ms[1] &&
    point.energy_kwh >= c.energy_kwh[0] && point.energy_kwh <= c.energy_kwh[1]
  );
  if (!cell) return { status: "outside_coverage" as const };
  const values = interpolate(cell, result.samples, point);
  return {
    status: "estimated" as const,
    execution: result.execution,
    cell_id: cell.id,
    reference_id: result.source.reference_id,
    values,
    ranking: ranking(values),
    error_evidence: cell.evidence,
    certified_error_bound_sek: null,
  };
}
