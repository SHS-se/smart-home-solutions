/** Describes each completed heating event against the published room response. */
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { roomIntervalHours, roomIntervalSeconds } from "./mean-evidence.ts";
import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import { HEATED_SAMPLE_MIN_W } from "./regression.ts";
import { leastSquares, factorLeastSquares } from "./mean-least-squares.ts";
import { roomMeanPair, roomEquilibriumMeanPair } from "./mean-pairs.ts";
import { roomMeanObservation } from "../../planner/models/room/observation.ts";
import { isEquilibrium, type ThermalZoneModel } from "../../planner/models/room/thermal.ts";

import { ROOM_TRANSITION_POLICY, type ROOM_RUN_POLICY, type MAX_ROOM_HEATING_RUNS } from "../../planner/models/room/run-evidence.ts";
/** Within-run heater contrast needed to distinguish a gain from measurement noise. */
const RESPONSE_STANDARD_ERRORS = 3;

import { roomHeatingRuns, type HeatingRun } from "./run-measurements.ts";
export { roomHeatingRuns, type HeatingRun } from "./run-measurements.ts";
export interface HeatingRunAssessment {
  id: string;
  from_ms: number;
  to_ms: number;
  measured_wh: number;
  transitions: number;
  gain: number | null;
  gain_se: number | null;
  nuisance: number | null;
  nuisance_se: number | null;
  balance_per_degree: number | null;
  balance_se_per_degree: number | null;
  change_at_ms: number | null;
  change_size: number | null;
  change_se: number | null;
  change_phase: "heating" | "cooldown" | null;
  change_from_h: number | null;
  change_to_h: number | null;
  repeated_shape: boolean;
  disposition: "fitted" | "provisional" | "older_response" | "suspect_change" | "uninformative";
  /** Descriptive run conditions for display. They are never fitting inputs,
   * and older ledgers lack them. Each is null where nothing was observed. */
  on_from_ms?: number;
  off_from_ms?: number;
  outdoor_c?: number | null;
  house_c?: number | null;
  room_start_c?: number | null;
  room_peak_c?: number | null;
  room_end_c?: number | null;
  cooldown?: RunCooldown | null;
}
/** Observed fall after the heater stops and its lag has passed. */
export interface RunCooldown {
  /** Hours between the first and last interval midpoints used. */
  hours: number;
  /** Least-squares fall of the room, °C/h; positive while cooling. */
  c_per_h: number;
  room_c: number;
  outdoor_c: number;
  house_c: number | null;
  /** Observed minus model-predicted fall over the same tail transitions, °C/h,
   * against the response this run was assessed with; positive when the room
   * fell faster than that response predicts. Null for an algebraic response. */
  residual_c_per_h?: number | null;
}
export interface RoomRunEvidence {
  policy: typeof ROOM_RUN_POLICY;
  minimum_runs: 3;
  maximum_runs: typeof MAX_ROOM_HEATING_RUNS;
  /** Revision of the published response every run was assessed against. */
  assessed_against?: string | null;
  observed_runs: number;
  retained_runs: number;
  fitted_runs: number;
  suspect_runs: number;
  provisional_runs: number;
  oldest_run_at: string | null;
  newest_run_at: string | null;
  runs: HeatingRunAssessment[];
}

type AssessedHeatingRun = Omit<HeatingRunAssessment, "disposition" | "repeated_shape"> & {
  disposition: "assessed" | "suspect_change" | "uninformative";
};

/** Run-level diagnostics for the published chronological response. A run
 * belongs to this ledger even if its own heater contrast is unidentified. */
export interface RoomTransitionRunLedger {
  policy: typeof ROOM_TRANSITION_POLICY;
  assessed_against?: string | null;
  observed_runs: number;
  runs: AssessedHeatingRun[];
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const known = (row: RoomMeanQuarter) => finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row);
/** Descriptive run conditions stored with an assessed response revision. */
export const ROOM_RUN_CONDITIONS = "run_conditions_v2";

/** The window after the heater stops in which cooling is compared across runs.
 * A fixed span keeps runs comparable; a long tail approaches equilibrium. */
export const RUN_COOLDOWN_WINDOW_H = 3;
const RUN_COOLDOWN_MIN_H = 1;

function timeMean(rows: readonly RoomMeanQuarter[], value: (row: RoomMeanQuarter) => number | null): number | null {
  let sum = 0, hours = 0;
  for (const row of rows) {
    const v = value(row);
    if (!finite(v)) continue;
    sum += v * roomIntervalHours(row); hours += roomIntervalHours(row);
  }
  return hours > 0 ? sum / hours : null;
}

/** Tail intervals compared across runs: heater off, after its lag, within the window. */
function cooldownTail(rows: readonly RoomMeanQuarter[], run: HeatingRun, lagH: number) {
  const midpointH = (row: RoomMeanQuarter) => (row.start_ms - run.off_from_ms) / 3_600_000 + roomIntervalHours(row) / 2;
  const settled = Math.max(0, lagH);
  const tail = rows.slice(run.off, run.end + 1).filter(row => known(row) && row.heat_w! <= HEATED_SAMPLE_MIN_W &&
    midpointH(row) >= settled && midpointH(row) <= settled + RUN_COOLDOWN_WINDOW_H &&
    finite(row.room_c) && finite(row.outdoor_c));
  return { tail, midpointH };
}

/** Describe only what was observed. Missing readings shorten the evidence;
 * they are never filled. A cooldown needs one hour of observed fall. */
export function describeHeatingRun(rows: readonly RoomMeanQuarter[], run: HeatingRun, lagH: number) {
  const window = rows.slice(run.from, run.end + 1);
  const room = window.map(row => row.room_c).filter(finite);
  const { tail, midpointH } = cooldownTail(rows, run, lagH);
  let cooldown: RunCooldown | null = null;
  if (tail.length >= 3) {
    const x = tail.map(midpointH), y = tail.map(row => row.room_c!);
    const meanX = x.reduce((a, b) => a + b, 0) / x.length, meanY = y.reduce((a, b) => a + b, 0) / y.length;
    const sxx = x.reduce((sum, v) => sum + (v - meanX) ** 2, 0);
    const hours = x.at(-1)! - x[0];
    if (hours >= RUN_COOLDOWN_MIN_H && sxx > 0) cooldown = {
      hours, c_per_h: -x.reduce((sum, v, i) => sum + (v - meanX) * (y[i] - meanY), 0) / sxx, room_c: meanY,
      outdoor_c: timeMean(tail, row => row.outdoor_c)!, house_c: timeMean(tail, row => row.house_c),
    };
  }
  return {
    on_from_ms: run.on_from_ms, off_from_ms: run.off_from_ms,
    outdoor_c: timeMean(window, row => row.outdoor_c), house_c: timeMean(window, row => row.house_c),
    room_start_c: [rows[run.from], rows[run.on]].find(row => finite(row.room_c))?.room_c ?? null,
    room_peak_c: room.length ? Math.max(...room) : null,
    room_end_c: [...window].reverse().find(row => finite(row.room_c))?.room_c ?? null,
    cooldown,
  };
}

/** Observed minus predicted fall over the cool-down tail, using the same
 * interval-mean algebra as the run's assessment and the response's own
 * background. Unknown entry heater state is left out; after the lag it has
 * decayed. Positive: the room fell faster than the response predicts. */
function cooldownResidual(rows: readonly RoomMeanQuarter[], run: HeatingRun, model: ThermalZoneModel,
  terms: readonly RunEquation[]): number | null {
  if (isEquilibrium(model)) return null;
  const tail = new Set(cooldownTail(rows, run, model.heat_lag_h ?? 0).tail.map(row => row.start_ms));
  let sum = 0, hours = 0;
  for (const term of terms) {
    const q = rows[term.index], next = rows[term.index + 1];
    if (!tail.has(q.start_ms) || !tail.has(next.start_ms)) continue;
    const predicted = model.gain_c_per_wh * term.x[0] + model.background_gain_c_per_h * term.x[1];
    const h = roomIntervalHours(q);
    sum -= term.y - predicted; hours += h;
  }
  return hours > 0 ? sum / hours : null;
}

interface RunEquation { index: number; x: number[]; y: number; exposure: number }

/** A run's heater contrast is conditional on boundary/solar response. Its
 * nuisance rate and unknown entry heater state are not future heat inputs. */
function runEquations(rows: readonly RoomMeanQuarter[], run: HeatingRun, model: ThermalZoneModel): RunEquation[] {
  const lag = model.heat_lag_h ?? 0, equilibrium = isEquilibrium(model);
  const k = equilibrium ? 0 : model.cooling_constant_per_h + (model.house_coupling_per_h ?? 0);
  const sun = equilibrium ? model.solar_c_per_wm2 : model.solar_gain_c_per_h_per_wm2;
  const equations: RunEquation[] = [];
  let memory = 0, initial = 1;
  for (let i = run.from; i < run.end; i++) {
    const q = rows[i], next = rows[i + 1];
    const currentOp = roomMeanObservation(k, lag, roomIntervalHours(q));
    const pair = equilibrium ? roomEquilibriumMeanPair(lag, roomIntervalHours(q), roomIntervalHours(next))
      : roomMeanPair(currentOp, roomMeanObservation(k, lag, roomIntervalHours(next)));
    if ([q, next].every(row => finite(row.room_c) && finite(row.outdoor_c) && finite(row.house_c)) &&
      (sun == null || (finite(q.solar_w_per_m2) && finite(next.solar_w_per_m2)))) {
      const background = (row: RoomMeanQuarter) => equilibrium
        ? model.outdoor_share * row.outdoor_c! + (1 - model.outdoor_share) * row.house_c! + (sun ?? 0) * (row.solar_w_per_m2 ?? 0)
        : model.cooling_constant_per_h * row.outdoor_c! + (model.house_coupling_per_h ?? 0) * row.house_c! +
          (sun ?? 0) * (row.solar_w_per_m2 ?? 0);
      const x = [pair.memory * memory + pair.currentHeat * q.heat_w! + pair.nextHeat * next.heat_w!,
        pair.L + pair.nextForcing];
      if (lag > 0) x.push(pair.memory * initial);
      equations.push({ index: i, x, exposure: pair.L + pair.nextForcing,
        y: next.room_c! - pair.alpha * q.room_c! - pair.L * background(q) - pair.nextForcing * background(next) });
    }
    memory = currentOp.C * memory + (1 - currentOp.C) * q.heat_w!;
    initial *= currentOp.C;
  }
  return equations;
}

function runResponse(rows: readonly RoomMeanQuarter[], run: HeatingRun, model: ThermalZoneModel,
  noiseC: number, nuisanceOffset: number): AssessedHeatingRun {
  const result: AssessedHeatingRun = { id: run.id, from_ms: run.from_ms, to_ms: run.to_ms,
    measured_wh: run.measured_wh, transitions: 0, gain: null, gain_se: null, nuisance: null, nuisance_se: null, balance_per_degree: null, balance_se_per_degree: null,
    change_at_ms: null, change_size: null, change_se: null, change_phase: null,
    change_from_h: null, change_to_h: null, disposition: "uninformative",
    ...describeHeatingRun(rows, run, model.heat_lag_h ?? 0) };
  const terms = runEquations(rows, run, model), matrix = terms.map(term => term.x);
  result.transitions = terms.length;
  if (result.cooldown) result.cooldown = { ...result.cooldown, residual_c_per_h: cooldownResidual(rows, run, model, terms) };
  const beta = leastSquares(matrix, terms.map(term => term.y));
  if (!beta || terms.length <= beta.length) return result;
  const residuals = terms.map(term => term.y - term.x.reduce((sum, value, j) => sum + value * beta[j], 0));
  const rss = residuals.reduce((sum, value) => sum + value ** 2, 0);
  // Partial out nuisance and entry state to measure actual heater excitation.
  const nuisance = leastSquares(matrix.map(x => x.slice(1)), matrix.map(x => x[0]));
  if (!nuisance) return result;
  const information = matrix.reduce((sum, x) => sum + (x[0] - x.slice(1).reduce((total, v, j) => total + v * nuisance[j], 0)) ** 2, 0);
  if (!(information > 0)) return result;
  const uncertainty = Math.sqrt(Math.max(rss / (terms.length - beta.length), noiseC ** 2) / information);
  result.gain = beta[0]; result.gain_se = uncertainty; result.nuisance = beta[1];
  const withoutOffset = matrix.map(x => x.filter((_v, j) => j !== 1));
  const offsetProjection = leastSquares(withoutOffset, matrix.map(x => x[1]));
  const offsetInformation = offsetProjection ? matrix.reduce((sum, x, i) => sum +
    (x[1] - withoutOffset[i].reduce((total, value, j) => total + value * offsetProjection[j], 0)) ** 2, 0) : 0;
  if (!(offsetInformation > 0)) return result;
  result.nuisance_se = Math.sqrt(Math.max(rss / (terms.length - beta.length), noiseC ** 2) / offsetInformation);
  const exposure = terms.reduce((sum, term) => sum + term.exposure, 0);
  const meanGradient = (boundary: "outdoor_c" | "house_c") => terms.reduce((sum, term) => {
    const current = rows[term.index], next = rows[term.index + 1];
    return sum + term.exposure * ((current.room_c! - current[boundary]!) + (next.room_c! - next[boundary]!)) / 2;
  }, 0) / exposure;
  const gradient = Math.hypot(meanGradient("outdoor_c"), meanGradient("house_c"));
  if (!(gradient > 0)) return result;
  // Express the run’s conditional heat-balance difference per degree of boundary gradient.
  result.balance_per_degree = (beta[1] - nuisanceOffset) / gradient;
  result.balance_se_per_degree = result.nuisance_se / gradient;
  // A scanned step has amplitude and change-location parameters. The BIC
  // penalty pays for both, rather than testing every location as preselected.
  const comparisonVariance = Math.max(noiseC * noiseC, rss / (terms.length - beta.length));
  const likelihood = (error: number) => comparisonVariance > 0 ? error / comparisonVariance
    : terms.length * Math.log(Math.max(Number.MIN_VALUE, error / terms.length));
  const baseScore = likelihood(rss) + beta.length * Math.log(terms.length);
  let bestScore = baseScore;
  const factor = factorLeastSquares(matrix, terms.map(term => term.y));
  if (!factor) return result;
  const suffixSquares = new Float64Array(terms.length + 1), suffixResidual = new Float64Array(terms.length + 1);
  const suffixProjection = factor.orthonormal.map(() => new Float64Array(terms.length + 1));
  for (let i = terms.length - 1; i >= 0; i--) {
    const exposure = terms[i].exposure;
    suffixSquares[i] = suffixSquares[i + 1] + exposure ** 2;
    suffixResidual[i] = suffixResidual[i + 1] + exposure * residuals[i];
    factor.orthonormal.forEach((q, j) => { suffixProjection[j][i] = suffixProjection[j][i + 1] + q[i] * exposure; });
  }
  const arithmeticScale = terms.reduce((sum, term) => sum + term.y ** 2, 0);
  // Rank-one regression against the QR basis makes the full change scan linear
  // in run length. A long winter event cannot trigger a quadratic worker step.
  for (let cut = beta.length; cut < terms.length - beta.length; cut++) {
    const stepInformation = suffixSquares[cut] - suffixProjection.reduce((sum, q) => sum + q[cut] ** 2, 0);
    if (!(stepInformation > Number.EPSILON * terms.length * 64 * suffixSquares[cut])) continue;
    const changeSize = suffixResidual[cut] / stepInformation;
    const error = Math.max(0, rss - suffixResidual[cut] ** 2 / stepInformation);
    const score = likelihood(error) + (beta.length + 2) * Math.log(terms.length);
    if (score < bestScore && error < rss - Number.EPSILON * arithmeticScale * 64) {
      bestScore = score;
      const changedRow = rows[terms[cut].index];
      result.change_at_ms = changedRow.start_ms;
      result.change_size = changeSize;
      result.change_se = Math.sqrt(Math.max(noiseC ** 2, error / Math.max(1, terms.length - beta.length - 1)) / stepInformation);
      result.change_phase = changedRow.start_ms < run.off_from_ms ? "heating" : "cooldown";
      const origin = result.change_phase === "heating" ? run.on_from_ms : run.off_from_ms;
      result.change_from_h = (changedRow.start_ms - origin) / 3_600_000;
      result.change_to_h = result.change_from_h + roomIntervalHours(changedRow);
    }
  }
  result.disposition = result.change_at_ms !== null ? "suspect_change"
    : beta[0] > RESPONSE_STANDARD_ERRORS * uncertainty ? "assessed" : "uninformative";
  return result;
}

/** Describe each complete event against one final response. Unknown heat and
 * changes within an event remain diagnostics rather than membership votes. */
export function assessRoomHeatingRuns(rows: readonly RoomMeanQuarter[], model: ThermalZoneModel,
  noiseC: number, nuisanceOffset: number): RoomTransitionRunLedger {
  const runs = roomHeatingRuns(rows).map(run => runResponse(rows, run, model, noiseC, nuisanceOffset));
  return { policy: ROOM_TRANSITION_POLICY, observed_runs: runs.length, runs };
}
