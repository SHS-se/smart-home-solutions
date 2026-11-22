/** Owns the bounded, recent evidence for a room response. Raw observations and
 * accepted revisions outlive this working set; neither is edited here. */
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { roomIntervalHours, roomIntervalSeconds } from "./mean-evidence.ts";
import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import { HEATED_SAMPLE_MIN_W } from "./regression.ts";
import { leastSquares, factorLeastSquares } from "./mean-least-squares.ts";
import { roomMeanPair, roomEquilibriumMeanPair } from "./mean-pairs.ts";
import { roomMeanObservation } from "../../planner/models/room/observation.ts";
import { isEquilibrium, type ThermalZoneModel } from "../../planner/models/room/thermal.ts";

import { ROOM_RUN_POLICY, MIN_ROOM_HEATING_RUNS, MAX_ROOM_HEATING_RUNS } from "../../planner/models/room/run-evidence.ts";
export { ROOM_RUN_POLICY, MIN_ROOM_HEATING_RUNS, MAX_ROOM_HEATING_RUNS } from "../../planner/models/room/run-evidence.ts";
/** The proposed three-standard-error distinguishability criterion. */
const RESPONSE_STANDARD_ERRORS = 3;

export interface HeatingRun {
  id: string;
  from_ms: number;
  on_from_ms: number;
  off_from_ms: number;
  to_ms: number;
  from: number;
  on: number;
  off: number;
  end: number;
  measured_wh: number;
}
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
}
export interface RoomRunEvidence {
  policy: typeof ROOM_RUN_POLICY;
  minimum_runs: 3;
  maximum_runs: 10;
  observed_runs: number;
  retained_runs: number;
  fitted_runs: number;
  suspect_runs: number;
  provisional_runs: number;
  oldest_run_at: string | null;
  newest_run_at: string | null;
  runs: HeatingRunAssessment[];
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const known = (row: RoomMeanQuarter) => finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row);
const follows = (a: RoomMeanQuarter, b: RoomMeanQuarter) =>
  b.start_ms === a.start_ms + roomIntervalSeconds(a) * 1000;

/** Run identity is established before weather slicing. Missing readings are
 * never OFF or a new event. Capture-edge fragments cannot supply a run vote. */
export function roomHeatingRuns(rows: readonly RoomMeanQuarter[], inBand: (c: number) => boolean): HeatingRun[] {
  const runs: HeatingRun[] = [];
  let start = 0;
  while (start < rows.length) {
    while (start < rows.length && !known(rows[start])) start++;
    let stop = start + 1;
    while (stop < rows.length && known(rows[stop]) && follows(rows[stop - 1], rows[stop])) stop++;
    for (let i = start + 1; i < stop; i++) {
      if (rows[i].heat_w! <= HEATED_SAMPLE_MIN_W || rows[i - 1].heat_w! > HEATED_SAMPLE_MIN_W) continue;
      const on = i;
      while (i < stop && rows[i].heat_w! > HEATED_SAMPLE_MIN_W) i++;
      const off = i;
      if (off === stop) break;
      while (i < stop && rows[i].heat_w! <= HEATED_SAMPLE_MIN_W) i++;
      const end = i - 1;
      if (!rows.slice(on, off).some(row => finite(row.outdoor_c) && inBand(row.outdoor_c))) { i--; continue; }
      const from = on - 1;
      runs.push({ id: String(rows[on].start_ms), from_ms: rows[from].start_ms,
        on_from_ms: rows[on].start_ms, off_from_ms: rows[off].start_ms,
        to_ms: rows[end].start_ms + roomIntervalSeconds(rows[end]) * 1000,
        from, on, off, end,
        measured_wh: rows.slice(on, off).reduce((sum, row) => sum + row.heat_w! * roomIntervalHours(row), 0) });
      i--;
    }
    start = stop;
  }
  return runs;
}

/** A sparse numerical view retains measured context, with real gaps between
 * unrelated events. The observation solver estimates each unknown entry state. */
export function recentRoomRunRows(rows: readonly RoomMeanQuarter[], inBand: (c: number) => boolean, count = MAX_ROOM_HEATING_RUNS): RoomMeanQuarter[] {
  const runs = roomHeatingRuns(rows, inBand).slice(-count);
  return rowsForRuns(rows, runs);
}

function rowsForRuns(rows: readonly RoomMeanQuarter[], runs: readonly HeatingRun[]): RoomMeanQuarter[] {
  const indices = new Set<number>();
  for (const run of runs) for (let i = run.from; i <= run.end; i++) indices.add(i);
  return [...indices].sort((a, b) => a - b).map(i => rows[i]);
}

/** Version of the descriptive run conditions stored in each ledger. Changing
 * it revisits every band once, so stored ledgers describe their runs. */
export const ROOM_RUN_CONDITIONS = "run_conditions_v1";

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

/** Describe only what was observed. Missing readings shorten the evidence;
 * they are never filled. A cooldown needs one hour of observed fall. */
export function describeHeatingRun(rows: readonly RoomMeanQuarter[], run: HeatingRun, lagH: number) {
  const window = rows.slice(run.from, run.end + 1);
  const room = window.map(row => row.room_c).filter(finite);
  const midpointH = (row: RoomMeanQuarter) => (row.start_ms - run.off_from_ms) / 3_600_000 + roomIntervalHours(row) / 2;
  const settled = Math.max(0, lagH);
  const tail = rows.slice(run.off, run.end + 1).filter(row => known(row) && row.heat_w! <= HEATED_SAMPLE_MIN_W &&
    midpointH(row) >= settled && midpointH(row) <= settled + RUN_COOLDOWN_WINDOW_H &&
    finite(row.room_c) && finite(row.outdoor_c));
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

interface RunEquation { index: number; x: number[]; y: number; exposure: number }

/** A run's heater contrast is conditional on boundary/solar response. Its
 * nuisance rate and unknown entry heater state are not future heat inputs. */
function runEquations(rows: readonly RoomMeanQuarter[], run: HeatingRun, model: ThermalZoneModel,
  inBand: (c: number) => boolean): RunEquation[] {
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
      inBand(q.outdoor_c!) && inBand(next.outdoor_c!) &&
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
  inBand: (c: number) => boolean, noiseC: number, nuisanceOffset: number): HeatingRunAssessment {
  const result: HeatingRunAssessment = { id: run.id, from_ms: run.from_ms, to_ms: run.to_ms,
    measured_wh: run.measured_wh, transitions: 0, gain: null, gain_se: null, nuisance: null, nuisance_se: null, balance_per_degree: null, balance_se_per_degree: null,
    change_at_ms: null, change_size: null, change_se: null, change_phase: null,
    change_from_h: null, change_to_h: null, repeated_shape: false, disposition: "uninformative",
    ...describeHeatingRun(rows, run, model.heat_lag_h ?? 0) };
  const terms = runEquations(rows, run, model, inBand), matrix = terms.map(term => term.x);
  result.transitions = terms.length;
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
  // Compare the conditional heat balance at like boundary gradients, rather
  // than forcing a renovated room to retain its old loss rate. The numerator
  // is a normalized nuisance coefficient contrast, with matching units.
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
    : beta[0] > RESPONSE_STANDARD_ERRORS * uncertainty ? "provisional" : "uninformative";
  return result;
}

/** Agreement concerns recent runs, not agreement with an incumbent model.
 * Three coherent new responses can replace an older, genuinely changed plant. */
export function calibrateRoomRuns(rows: readonly RoomMeanQuarter[], model: ThermalZoneModel,
  inBand: (c: number) => boolean, noiseC = 0, nuisanceOffset = isEquilibrium(model) ? model.offset_c : model.background_gain_c_per_h): { rows: RoomMeanQuarter[]; evidence: RoomRunEvidence } {
  const observed = roomHeatingRuns(rows, inBand), retained = observed.slice(-MAX_ROOM_HEATING_RUNS);
  const assessments = retained.map(run => runResponse(rows, run, model, inBand, noiseC, nuisanceOffset));
  // A repeatable, phase-aligned shape seen in the other independent runs is
  // evidence about the heater/observation shape, not evidence identifying an
  // unknown source in this one run. Preserve the diagnostic and cross-check
  // against at least two OTHER events; do not let a run certify itself.
  for (const run of assessments.filter(run => run.disposition === "suspect_change")) {
    const peers = assessments.filter(other => other !== run && other.change_at_ms !== null &&
      other.change_phase === run.change_phase && other.change_from_h! <= run.change_to_h! &&
      run.change_from_h! <= other.change_to_h! &&
      Math.abs(other.change_size! - run.change_size!) <= RESPONSE_STANDARD_ERRORS * Math.hypot(other.change_se!, run.change_se!));
    const differentClock = (a: HeatingRunAssessment, b: HeatingRunAssessment) => {
      const widthA = a.change_to_h! - a.change_from_h!, widthB = b.change_to_h! - b.change_from_h!;
      const midpointA = (a.change_at_ms! / 3_600_000 + widthA / 2) % 24;
      const midpointB = (b.change_at_ms! / 3_600_000 + widthB / 2) % 24;
      const difference = Math.abs(midpointA - midpointB);
      return Math.min(difference, 24 - difference) > (widthA + widthB) / 2;
    };
    if (peers.some((a, i) => differentClock(run, a) && peers.slice(i + 1).some(b => differentClock(run, b) && differentClock(a, b)))) {

      run.repeated_shape = true;
      run.disposition = run.gain! > RESPONSE_STANDARD_ERRORS * run.gain_se! ? "provisional" : "uninformative";
    }
  }
  const usable = assessments.filter(run => run.disposition === "provisional");
  const compatible = (a: number, b: number, seA: number, seB: number) => Math.abs(a - b) <=
    RESPONSE_STANDARD_ERRORS * Math.hypot(seA, seB) + Number.EPSILON * 64 * Math.max(Math.abs(a), Math.abs(b));
  // A renovation may change losses while the heater's gain is unchanged. The
  // conditional balance distinguishes that regime before the exact refit;
  // its nuisance offset itself never becomes a future source of heat.
  const agrees = (a: HeatingRunAssessment, b: HeatingRunAssessment) =>
    compatible(a.gain!, b.gain!, a.gain_se!, b.gain_se!) &&
    compatible(a.balance_per_degree!, b.balance_per_degree!, a.balance_se_per_degree!, b.balance_se_per_degree!);
  let selected: HeatingRunAssessment[] = [];
  for (const seed of [...usable].reverse()) {
    const group: HeatingRunAssessment[] = [seed];
    for (const run of [...usable].reverse()) if (run !== seed && group.every(other => agrees(run, other))) group.push(run);
    if (group.length >= MIN_ROOM_HEATING_RUNS) { selected = group; break; }
  }
  const selectedIds = new Set(selected.map(run => run.id));
  const firstSelected = Math.min(...selected.map(run => run.from_ms));
  for (const run of usable) {
    if (selectedIds.has(run.id)) run.disposition = "fitted";
    else if (run.from_ms < firstSelected && selected.length) run.disposition = "older_response";
  }
  const selectedRuns = retained.filter(run => selectedIds.has(run.id));
  return { rows: rowsForRuns(rows, selectedRuns), evidence: {
    policy: ROOM_RUN_POLICY, minimum_runs: MIN_ROOM_HEATING_RUNS, maximum_runs: MAX_ROOM_HEATING_RUNS,
    observed_runs: observed.length, retained_runs: retained.length, fitted_runs: selected.length,
    suspect_runs: assessments.filter(run => run.disposition === "suspect_change").length,
    provisional_runs: assessments.filter(run => run.disposition === "provisional").length,
    oldest_run_at: selectedRuns.length ? new Date(selectedRuns[0].from_ms).toISOString() : null,
    newest_run_at: selectedRuns.length ? new Date(selectedRuns.at(-1)!.to_ms).toISOString() : null,
    runs: assessments,
  } };
}
