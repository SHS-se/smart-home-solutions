import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import { initializeExternalHeat, inferExternalHeat, updateExternalHeat, type ExternalHeatParameters, type ExternalHeatResidual } from "./external-heat.ts";
import { MeanFeatureWorkspace } from "./mean-features.ts";
import { compareFiniteRoomResponse, conditionalAicc, type RoomResponseSelection } from "./mean-identification.ts";
import { solveNonnegativeNuisance } from "./mean-nuisance.ts";
import { roomMeanObservation } from "../../planner/models/room/observation.ts";
export { roomMeanObservation } from "../../planner/models/room/observation.ts";
/**
 * Learn from recorder interval means, not fictitious boundary temperatures.
 * The observation operator integrates the continuous room/delivered-heat ODE.
 * Selection measures chronological held-out temperature transitions; the
 * twelve-hour forecast remains a diagnostic, not an actuator-response oracle.
 */
import { factorLeastSquares, leastSquares } from "./mean-least-squares.ts";
import { prepareRoomMeanEvidence, roomIntervalHours, roomIntervalSeconds } from "./mean-evidence.ts";
import { HEAT_LAG_GRID_H, MAX_PREDICTION_ERROR_C } from "./fit.ts";
import { HEATED_SAMPLE_MIN_W, MIN_HEATED_SAMPLES, MIN_SOLAR_COVERAGE, MIN_TRAINING_SAMPLES,
  type ThermalFitRejection, type ThermalFitResult } from "./regression.ts";
import { type DynamicThermalZoneModel, type ThermalZoneModel } from "../../planner/models/room/thermal.ts";

export interface RoomMeanQuarter {
  start_ms: number;
  /** Actual Recorder interval; omitted only by existing quarter adapters. */
  duration_s?: 900 | 3600;
  room_c: number | null;
  outdoor_c: number | null;
  house_c: number | null;
  solar_w_per_m2: number | null;
  /** Measured mean electrical input; null means unobserved, never OFF. */
  heat_w: number | null;
  cooling: boolean | null;
  /** Dated, source-qualified direction evidence, separate from observed mode. */
  operation_fact?: string;
  /** Explicit shared-meter attribution, with raw totals retained upstream. */
  heat_attributed?: boolean;
  band_forcing_c_per_h?: number | null;
}
export const ROOM_MEAN_LEARNING_METHOD = "interval_mean_transition_holdout_v1" as const;
export const ROOM_MEAN_IMPLEMENTATION = "native_interval_qr_v3" as const;
export const ROOM_EXCHANGE_FAMILY = "house_outdoor_solar_v1" as const;
export interface RoomLearningEvidence {
  method: typeof ROOM_MEAN_LEARNING_METHOD;
  family: typeof ROOM_EXCHANGE_FAMILY;
  implementation?: typeof ROOM_MEAN_IMPLEMENTATION;
  observation: "quarter_mean" | "interval_mean";
  selection: "chronological_transition_mse" | "chronological_predictive_likelihood" | "regularized_marginal_bic";
  training_pairs: number;
  validation_pairs: number;
  validation_mse_c2: number | null;
  selected_boundary: "house_outdoor" | null;
  selected_lag_h: number | null;
  estimated_temperature_readings?: number;
  observation_intervals?: number;
  observation_hours?: number;
  heated_hours?: number;
  residual_degrees_of_freedom?: number;
  attributed_heater_intervals?: number;
  response_selection?: RoomResponseSelection;
  operation_evidence?: { constrained_intervals: number; fan_or_cooling_flag_intervals: number; revisions: string[] };
  additional_heat?: { method: "positive_residual_hmm_v2"; selected: boolean; iterations: number; converged: boolean; failure: RoomObservationFit["failure"];
    parameters: ExternalHeatParameters; validation_nll: number | null; plain_validation_nll: number | null;
    expected_intervals: number; expected_hours: number; episode_count: number;
    mean_forcing: number; forcing_unit: "C/h" | "C"; heater_equivalent_wh: number | null;
    clean_noise_c: number;
    variance_regularization: { family: "scaled_inverse_chi_squared"; degrees_of_freedom: 1;
      reference_c2: number; source: "pooled_observed_transition_mean_square" };
    prediction_error_scope: "heater_only_no_future_external_heat" };

}
export interface RoomHeatAttributionInterval {
  from_ms: number; to_ms: number; probability: number; forcing: number; forcing_unit: "C/h" | "C"; heat_w: number;
}
export type RoomMeanFitResult<Model extends ThermalZoneModel = ThermalZoneModel> = ThermalFitResult<Model> & {
  learning_evidence?: RoomLearningEvidence;
  /** Ephemeral diagnostic; publication retains aggregates, never this trace. */
  additional_heat_intervals?: RoomHeatAttributionInterval[];
};
const finite = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v);

/** Heating input's contribution to the change between adjacent quarter means. */
export function roomMeanHeat(op: ReturnType<typeof roomMeanObservation>, memory: number, current: number, next: number): number {
  const { E, B, a, U, C, effect, V } = op;
  return (E * B - a * U + U * C) * memory +
    (E * (effect - B) - a * (V - U) + U * (1 - C)) * current + (V - U) * next;
}

interface Equation { segment: number; x: number[]; z: number; y: number }
interface Term extends Equation { index: number; delivered: number }
interface Design { system: Equation[]; count: number }
const RESPONSE_FAMILIES = ["finite", "equilibrium", "integrator"] as const;
type ResponseFamily = typeof RESPONSE_FAMILIES[number];
export interface RoomObservationFit {
  kind: "gaussian" | "additional_heat";
  parameters: ExternalHeatParameters; iterations: number; converged: boolean; failure: "iteration_limit" | "likelihood_decreased" | "profile_unresolved" | null; nll: number; objective: number; initial: [number, number][];
}
interface RoomBandFitSummary { k: number; beta: number[]; mse: number; n: number; dof: number; observation_fit?: RoomObservationFit }
interface FitEvaluation extends RoomBandFitSummary {
  lag: number;
  solar: boolean;
  family: ResponseFamily;
  initial?: Map<number, number>;
}
interface Fit extends FitEvaluation { initial: Map<number, number>; roundoff: number }

const BAND_CELL_GRID = HEAT_LAG_GRID_H.flatMap(lag_h => [
  { lag_h, partition: "training" as const }, { lag_h, partition: "full" as const },
]);
const PROFILE_LOG_STEP = 1;
const PROFILE_REFINEMENT_STEPS = 32;
const GOLDEN_SECTION_RATIO = (Math.sqrt(5) - 1) / 2;
export const ROOM_BAND_FINITE_PROFILE_LOG_RESOLUTION = 2 * PROFILE_LOG_STEP * GOLDEN_SECTION_RATIO ** PROFILE_REFINEMENT_STEPS;
export const ROOM_BAND_OBJECTIVE_ROUNDOFF_SCALE = Number.EPSILON * 64;
export const ROOM_BAND_FIT_CELL_COUNT = BAND_CELL_GRID.length;
export interface RoomBandFitCell {
  lag_h: number;
  partition: "training" | "full";
  fits: Record<ResponseFamily, RoomBandFitSummary | null>;
  additional_heat: Record<ResponseFamily, RoomBandFitSummary | null>;
}

interface BandFit {
  outdoor: (outdoorC: number) => boolean;
  house?: number;
  gain?: number | null;
}

/** Eliminate the starting temperature between two interval means. Each side
 * keeps its own measured duration, including a fine/coarse resolution join. */
export function roomMeanPair(current: ReturnType<typeof roomMeanObservation>, next: ReturnType<typeof roomMeanObservation>) {
  const alpha = next.E * current.a / current.E;
  const L = next.E * current.effect - alpha * current.V;
  return {
    alpha, L, nextForcing: next.V,
    memory: next.E * current.B - alpha * current.U + next.U * current.C,
    currentHeat: next.E * (current.effect - current.B) - alpha * (current.V - current.U) + next.U * (1 - current.C),
    nextHeat: next.V - next.U,
  };
}

/** Exact fast-exchange limit in gain/k and forcing/k coordinates. */
export function roomEquilibriumMeanPair(lag: number, currentHours: number, nextHours: number) {
  const carry = lag ? Math.exp(-currentHours / lag) : 0;
  const fraction = lag ? -lag * Math.expm1(-nextHours / lag) / nextHours : 0;
  return { alpha: 0, L: 0, nextForcing: 1, memory: fraction * carry,
    currentHeat: fraction * (1 - carry), nextHeat: 1 - fraction };
}

/** Visit each eligible transition with the heat state carried from earlier observations. */
function visitTransitions(rows: RoomMeanQuarter[], from: number, lag: number, solar: boolean, band: BandFit | undefined,
  visit: (index: number, segment: number, delivered: number, initialShare: number, pairIndex: number) => void): void {
  const carry = [.25, 1].map(hours => roomMeanObservation(0, lag, hours).C);
  let delivered = 0, initialShare = 1, segment = 0;
  for (let i = from; i + 1 < rows.length; i++) {
    const q = rows[i], next = rows[i + 1];
    const currentClass = roomIntervalSeconds(q) === 900 ? 0 : 1;
    const nextClass = roomIntervalSeconds(next) === 900 ? 0 : 1;
    const powerKnown = finite(q.heat_w) && q.heat_w >= 0 && roomHeatingDirectionKnown(q);
    const contiguous = next.start_ms === q.start_ms + roomIntervalSeconds(q) * 1000;
    const sameBand = !band || (finite(q.outdoor_c) && finite(next.outdoor_c) &&
      band.outdoor(q.outdoor_c) && band.outdoor(next.outdoor_c));
    if (powerKnown && contiguous && finite(next.heat_w) && next.heat_w >= 0 &&
      finite(q.room_c) && finite(next.room_c) && roomHeatingDirectionKnown(next) &&
      finite(q.house_c) && finite(next.house_c) && finite(q.outdoor_c) && finite(next.outdoor_c) &&
      (!solar || (finite(q.solar_w_per_m2) && finite(next.solar_w_per_m2))) &&
      (!band || (sameBand && q.band_forcing_c_per_h !== null && next.band_forcing_c_per_h !== null))) {
      visit(i, segment, delivered, initialShare, currentClass * 2 + nextClass);
    }
    // An independently fitted band cannot propagate another band's state.
    if (!powerKnown || !contiguous || !sameBand) {
      delivered = 0; initialShare = 1; segment++;
    } else {
      delivered = carry[currentClass] * delivered + (1 - carry[currentClass]) * q.heat_w!;
      initialShare *= carry[currentClass];
    }
  }
}

function transitionPairs(k: number, lag: number) {
  const equilibrium = k === Infinity;
  const op = [.25, 1].map(hours => roomMeanObservation(equilibrium ? 0 : k, lag, hours));
  return op.flatMap((current, i) => op.map((next, j) => equilibrium
    ? roomEquilibriumMeanPair(lag, i ? 1 : .25, j ? 1 : .25)
    : roomMeanPair(current, next)));
}

const FEATURE_WIDTH = 15;

/** Compress each lag once for exchange-profile evaluation. Candidate fits
 * keep only coefficients and initial states, with no saved raw transitions. */
function prepareDesign(rows: RoomMeanQuarter[], lag: number, solar: boolean, band?: BandFit,
  workspace = new MeanFeatureWorkspace(rows.length, FEATURE_WIDTH), latent?: {
    mean: Map<number, number>; variance: Map<number, number>; precision: Map<number, number>;
  }): (k: number) => Design {
  workspace.reset();
  const values = Array<number>(FEATURE_WIDTH).fill(0);
  const latentVariance = new Float64Array(4);
  visitTransitions(rows, 0, lag, solar, band, (index, segment, delivered, initialShare, pairIndex) => {
    const q = rows[index], next = rows[index + 1];
    values[0] = delivered;
    values[1] = q.heat_w!;
    values[2] = next.heat_w!;
    values[3] = 1;
    values[4] = q.outdoor_c! - q.house_c!;
    values[5] = next.outdoor_c! - next.house_c!;
    values[6] = solar ? q.solar_w_per_m2! : 0;
    values[7] = solar ? next.solar_w_per_m2! : 0;
    values[8] = next.room_c!;
    values[9] = q.room_c!;
    values[10] = q.house_c!;
    values[11] = next.house_c!;
    values[12] = band ? q.band_forcing_c_per_h ?? 0 : 0;
    values[13] = band ? next.band_forcing_c_per_h ?? 0 : 0;
    values[14] = latent?.mean.get(index) ?? 0;
    const precision = latent?.precision.get(index) ?? 1, weight = Math.sqrt(precision);
    latentVariance[pairIndex] += precision * (latent?.variance.get(index) ?? 0);
    if (weight !== 1) for (let j = 0; j < FEATURE_WIDTH; j++) values[j] *= weight;
    workspace.add(pairIndex, segment, lag > 0 ? initialShare * weight : 0, values);
  });
  const features = workspace.factor(), count = workspace.count;
  return k => {
    const pairs = transitionPairs(k, lag), exchangeScale = k === Infinity ? 1 : k;
    const system = features.map(({ values: v, kind, segment, initialScale }) => {
      const pair = pairs[kind];
      return { segment, z: pair.memory * initialScale,
        x: [pair.memory * v[0] + pair.currentHeat * v[1] + pair.nextHeat * v[2], (pair.L + pair.nextForcing) * v[3],
          pair.L * v[4] + pair.nextForcing * v[5], ...(solar ? [pair.L * v[6] + pair.nextForcing * v[7]] : [])],
        y: v[8] - pair.alpha * v[9] - exchangeScale * (pair.L * v[10] + pair.nextForcing * v[11]) -
          (k === Infinity ? 0 : pair.L * v[12]) - (k === Infinity ? 0 : pair.nextForcing * v[13]) -
          (pair.L + pair.nextForcing) * v[14] };
    });
    // Expected latent-input variance changes with k through its observation
    // kernel. Preserve it in Q as orthogonal residual-only equations; the
    // physical solve must not gain by treating posterior means as measured.
    latentVariance.forEach((variance, kind) => {
      if (variance > 0) system.push({ segment: -1, z: 0, x: Array<number>(solar ? 4 : 3).fill(0),
        y: (pairs[kind].L + pairs[kind].nextForcing) * Math.sqrt(variance) });
    });
    return { system, count };
  };
}

function visitTerms(rows: RoomMeanQuarter[], fit: FitEvaluation, from: number, band: BandFit | undefined,
  visit: (term: Term) => void): void {
  const { lag, solar } = fit, k = fit.family === "equilibrium" ? Infinity : fit.k;
  const pairs = transitionPairs(k, lag), exchangeScale = k === Infinity ? 1 : k;
  const term: Term = { index: 0, segment: 0, delivered: 0, z: 0, x: Array<number>(solar ? 4 : 3).fill(0), y: 0 };
  visitTransitions(rows, from, lag, solar, band, (index, segment, delivered, initialShare, pairIndex) => {
    const q = rows[index], next = rows[index + 1], pair = pairs[pairIndex];
    term.index = index;
    term.segment = segment;
    term.delivered = delivered;
    term.z = pair.memory * initialShare;
    term.x[0] = pair.memory * delivered + pair.currentHeat * q.heat_w! + pair.nextHeat * next.heat_w!;
    term.x[1] = pair.L + pair.nextForcing;
    term.x[2] = pair.L * (q.outdoor_c! - q.house_c!) + pair.nextForcing * (next.outdoor_c! - next.house_c!);
    if (solar) term.x[3] = pair.L * q.solar_w_per_m2! + pair.nextForcing * next.solar_w_per_m2!;
    term.y = next.room_c! - pair.alpha * q.room_c! - exchangeScale * (pair.L * q.house_c! + pair.nextForcing * next.house_c!) -
      (band && fit.family !== "equilibrium" ? pair.L * (q.band_forcing_c_per_h ?? 0) + pair.nextForcing * (next.band_forcing_c_per_h ?? 0) : 0);
    visit(term);
  });
}

function estimate(d: Design, k: number, lag: number, solar: boolean, band?: BandFit, family: ResponseFamily = "finite"): Fit | null {
  const size = solar ? 4 : 3;
  const groups = new Map<number, number[]>();
  d.system.forEach((term, i) => {
    if (term.z === 0) return;
    const group = groups.get(term.segment) ?? [];
    group.push(i); groups.set(term.segment, group);
  });
  // Account for every fitted initial state and the profiled nonlinear exchange.
  // A zero-residual interpolation with fewer observations than unknowns does
  // not identify a thermal model, regardless of its apparent R².
  const fixedCount = (band?.house != null ? 1 : 0) + (band?.gain != null ? 1 : 0);
  const dof = d.count - (size - fixedCount) - groups.size - (family === "finite" ? 1 : 0);
  if (dof <= 0) return null;
  if (band?.house != null && k < band.house) return null;
  const known = new Map<number, number>();
  if (band?.house != null) known.set(2, k - band.house);
  if (band?.gain != null) known.set(0, band.gain);
  const baseFree = Array.from({ length: size }, (_, j) => j).filter(j => !known.has(j));
  const fixedTerms = [...known];
  const fitted = solveNonnegativeNuisance(
    d.system.map(term => fixedTerms.length ? baseFree.map(j => term.x[j]) : term.x),
    d.system.map(term => term.y - fixedTerms.reduce((sum, [j, value]) => sum + term.x[j] * value, 0)),
    [...groups.values()].map(indices => ({ indices, values: indices.map(i => d.system[i].z) })),
    (matrix, target, scales) => {
      const factor = factorLeastSquares(matrix, target, scales, d.count);
      if (!factor) return null;
      let best: number[] | null = null, objective = Infinity;
      // Include the zero-gain face while optimizing nuisance states. Reject
      // unidentified actuator gain only after the full constrained optimum.
      for (const gain of known.has(0) ? [null] : [null, 0]) {
        for (const outdoor of known.has(2) ? [null] : [null, 0, k]) {
          for (const sun of solar ? [null, 0] : [null]) {
            const fixed = new Map<number, number>();
            if (gain !== null) fixed.set(baseFree.indexOf(0), gain);
            if (outdoor !== null) fixed.set(baseFree.indexOf(2), outdoor);
            if (solar && sun !== null) fixed.set(baseFree.indexOf(3), sun);
            const free = baseFree.map((_, j) => j).filter(j => !fixed.has(j));
            const adjusted = factor.target.map((value, i) => value - [...fixed]
              .reduce((sum, [j, v]) => sum + factor.matrix[i][j] * v, 0));
            const solved = leastSquares(factor.matrix.map(row => free.map(j => row[j])), adjusted, free.map(j => scales[j]));
            if (!solved) continue;
            const partial = baseFree.map((_, j) => fixed.get(j) ?? solved[free.indexOf(j)]);
            const beta = Array.from({ length: size }, (_, j) => known.get(j) ?? partial[baseFree.indexOf(j)]);
            if (!beta.every(Number.isFinite) || beta[0] < 0 || beta[2] < 0 || beta[2] > k || (solar && beta[3] < 0)) continue;
            const residual = factor.target.reduce((sum, y, i) => sum +
              (y - factor.matrix[i].reduce((total, value, j) => total + value * partial[j], 0)) ** 2, 0);
            if (residual < objective) { best = partial; objective = residual; }
          }
        }
      }
      return best;
    }, d.count);
  if (!fitted) return null;
  const beta = Array.from({ length: size }, (_, j) => known.get(j) ?? fitted.beta[baseFree.indexOf(j)]);
  if (family === "finite" && !(beta[0] > 0)) return null;
  const initial = new Map([...groups.keys()].map((key, i) => [key, fitted.initial[i]]));
  let residual = 0, arithmeticScale = 0;
  for (const term of d.system) {
    let response = 0, responseScale = 0;
    for (let j = 0; j < term.x.length; j++) {
      const contribution = term.x[j] * beta[j];
      response += contribution;
      responseScale += contribution ** 2;
    }
    const memory = term.z * (initial.get(term.segment) ?? 0);
    residual += (term.y - response - memory) ** 2;
    // Orthogonal compression preserves each squared column norm. Cauchy–
    // Schwarz bounds the uncompressed absolute-contribution arithmetic scale
    // without materializing every raw transition at every profile position.
    arithmeticScale += (size + 2) * (term.y ** 2 + responseScale + memory ** 2);
  }
  if (!Number.isFinite(residual)) return null;
  return { k, lag, solar, beta, initial, family, mse: residual / d.count, n: d.count, dof,
    roundoff: ROOM_BAND_OBJECTIVE_ROUNDOFF_SCALE * Math.max(1, arithmeticScale / d.count) };
}

/** Expand a numerical bracket; no imposed lower/upper physical coupling. */
function fitCandidate(rows: RoomMeanQuarter[], lag: number, solar: boolean, band?: BandFit,
  prepared = prepareDesign(rows, lag, solar, band)): Fit | null {
  const at = (logK: number) => {
    const k = Math.exp(logK);
    return k > 0 && Number.isFinite(k) ? estimate(prepared(k), k, lag, solar, band) : null;
  };
  let center = 0, best = at(center);
  // Discover a physical least-squares solution before minimising its residual.
  if (!best) for (let step = 1; step < 32 && !best; step++) {
    for (const position of [-step, step]) { const candidate = at(position); if (candidate) { center = position; best = candidate; break; } }
  }
  if (!best) return null;
  let lo = center - PROFILE_LOG_STEP, hi = center + PROFILE_LOG_STEP, bracketed = false;
  const lower = band?.house && band.house > 0 ? Math.log(band.house) : -Infinity;
  for (let expansion = 0; expansion < 64; expansion++) {
    const left = at(Math.max(lo, lower)), right = at(hi);
    const lowerThan = (value: Fit | null, other: Fit) => value !== null &&
      value.mse < other.mse - Math.max(value.roundoff, other.roundoff);
    if (lowerThan(left, best) && (!right || left!.mse <= right.mse)) {
      best = left!; hi = center; center = Math.max(lo, lower); lo = center - PROFILE_LOG_STEP;
    } else if (lowerThan(right, best)) {
      best = right!; lo = center; center = hi; hi += PROFILE_LOG_STEP;
    } else {
      // A finite timescale needs a resolved minimum. A profile approaching a
      // flat k→∞/0 limit identifies coefficient ratios, not an enormous/tiny
      // finite time constant selected by floating-point residual noise.
      const rises = (value: Fit | null) => value !== null &&
        value.mse > best!.mse + Math.max(value.roundoff, best!.roundoff);
      bracketed = (rises(left) || center === lower) && rises(right);
      lo = Math.max(lo, lower);
      break;
    }
  }
  if (!bracketed) return null;
  // Golden-section refinement reuses one factorization per iteration.
  const ratio = GOLDEN_SECTION_RATIO;
  let l = hi - ratio * (hi - lo), r = lo + ratio * (hi - lo);
  let left = at(l), right = at(r);
  for (let iteration = 0; iteration < PROFILE_REFINEMENT_STEPS; iteration++) {
    if (left && left.mse < best.mse) best = left;
    if (right && right.mse < best.mse) best = right;
    if ((left?.mse ?? Infinity) < (right?.mse ?? Infinity)) {
      hi = r; r = l; right = left; l = hi - ratio * (hi - lo); left = at(l);
    } else {
      lo = l; l = r; left = right; r = lo + ratio * (hi - lo); right = at(r);
    }
  }
  return best;
}

/** Learn local exchange on the same state coordinates as the room's general fit. */
export function fitRoomBand(
  rows: RoomMeanQuarter[], reference: DynamicThermalZoneModel, outdoor: (outdoorC: number) => boolean,
  ratedPowerW: number | null,
): { model: DynamicThermalZoneModel; minC: number; maxC: number } | null {
  const lag = reference.heat_lag_h ?? 0;
  const solar = reference.solar_gain_c_per_h_per_wm2 != null;
  const band = { outdoor, house: reference.house_coupling_per_h ?? 0,
    gain: lag > 0 ? reference.gain_c_per_wh : null };
  const prepared = prepareRoomMeanEvidence(rows, row => finite(row.outdoor_c) && outdoor(row.outdoor_c));
  rows = prepared.rows;
  const fit = fitCandidate(rows, lag, solar, band);
  if (!fit) return null;
  let heated = false, minC = Infinity, maxC = -Infinity, change = 0;
  const indices: number[] = [];
  visitTransitions(rows, 0, lag, solar, band, i => {
    const q = rows[i], next = rows[i + 1];
    indices.push(i);
    heated ||= q.heat_w! > HEATED_SAMPLE_MIN_W || next.heat_w! > HEATED_SAMPLE_MIN_W;
    minC = Math.min(minC, q.outdoor_c!, next.outdoor_c!);
    maxC = Math.max(maxC, q.outdoor_c!, next.outdoor_c!);
    change = change + next.room_c! - q.room_c!;
  });
  // A band without any measured heating cannot be qualified for heating.
  if (!heated) return null;
  const [gain, background, external, sun] = fit.beta;
  const meanChange = change / fit.n;
  const variance = indices.reduce((sum, i) => sum + (rows[i + 1].room_c! - rows[i].room_c! - meanChange) ** 2, 0) / fit.n;
  return {
    minC, maxC,
    model: {
      ...reference, response_family: "finite", gain_c_per_wh: gain, cooling_constant_per_h: external,
      background_gain_c_per_h: background, solar_gain_c_per_h_per_wm2: sun ?? null,
      thermal_capacity_wh_per_c: 1 / gain, heat_loss_w_per_c: fit.k / gain, time_constant_h: 1 / fit.k,
      heating_rate_c_per_h: ratedPowerW && ratedPowerW > 0 ? gain * ratedPowerW : null,
      sample_count: fit.n, r2: variance ? 1 - fit.mse / variance : 0,
      residual_std_c: Math.sqrt(fit.mse), prediction_error_c: null,
    },
  };
}

const NO_ERROR = -1; // Observed squared errors are nonnegative (or nonfinite).

function heldOut(fit: FitEvaluation, rows: RoomMeanQuarter[], split: number, comparable: Uint8Array, band?: BandFit) {
  // Independent bands are evaluated on their own later episode, with its own
  // initial storage. Neither a fitted training state nor a transition crossing
  // the holdout cut may explain the validation response.
  const offset = band ? split : 0;
  const first = Math.max(0, split - 1);
  const initial = band ? new Map<number, number>() : new Map(fit.initial);
  const errors = new Float64Array(rows.length - first).fill(NO_ERROR);
  const residuals = new Float64Array(errors.length), segments = new Int32Array(errors.length);
  const exposures = new Float64Array(errors.length), durations = new Float64Array(errors.length), classes = Array<string>(errors.length);
  let count = 0;
  visitTerms(rows, fit, offset, band, t => {
    if (t.index < first) return;
    let fitted = 0;
    for (let j = 0; j < t.x.length; j++) fitted += t.x[j] * fit.beta[j];
    const residual = t.y - fitted;
    if (t.z !== 0 && !initial.has(t.segment)) {
      // The first transition after a newly unobserved heat state identifies
      // that state; it cannot also validate its own prediction.
      initial.set(t.segment, Math.max(0, residual / t.z));
      return;
    }
    if (!comparable[t.index]) return;
    const error = residual - t.z * (initial.get(t.segment) ?? 0);
    errors[t.index - first] = error ** 2;
    residuals[t.index - first] = error; segments[t.index - first] = t.segment;
    exposures[t.index - first] = t.x[1];
    durations[t.index - first] = (roomIntervalHours(rows[t.index]) + roomIntervalHours(rows[t.index + 1])) / 2;
    classes[t.index - first] = `${roomIntervalSeconds(rows[t.index])}/${roomIntervalSeconds(rows[t.index + 1])}`;
    count++;
  });
  return count ? { errors, residuals, segments, exposures, durations, classes } : null;
}

function scoreCandidates<T extends { training: FitEvaluation | null }>(candidates: T[], rows: RoomMeanQuarter[],
  validationRows: RoomMeanQuarter[], split: number, solar: boolean, band?: BandFit) {
  // Observed support depends on coverage, duration and weather, independently
  // of lag and response family. All candidates share this one eligibility mask.
  const comparable = new Uint8Array(rows.length);
  visitTransitions(rows, 0, 0, solar, band, i => { comparable[i] = 1; });
  const errors = candidates.map(c => c.training ? heldOut(c.training, validationRows, split, comparable, band) : null);
  const withValidation = errors.filter(values => values !== null);
  // An unknown stored-heat state consumes its first transition. Compare on
  // the intersection so that no model is scored on an inferred state.
  const common: number[] = [];
  for (let i = 0, n = withValidation[0]?.errors.length ?? 0; i < n; i++) {
    if (withValidation.every(values => values.errors[i] !== NO_ERROR)) common.push(i);
  }
  return candidates.map((candidate, i) => {
    const values = errors[i];
    let segment = -1, previous = -2, sourceSegment = -1;
    const residuals: ExternalHeatResidual[] = common.map(index => {
      const source = values?.segments[index] ?? -1;
      if (index !== previous + 1 || source !== sourceSegment) segment++;
      previous = index; sourceSegment = source;
      return { residual_c: values?.residuals[index] ?? 0, segment,
        forcing_scale: values?.exposures[index] ?? 1, duration_h: values?.durations[index] ?? 1,
        noise_class: String(values?.classes[index] ?? "default") };
    });
    const training = candidate.training;
    const nll = !values || !common.length || !training ? null : training.observation_fit
      ? inferExternalHeat(residuals, stationaryExternalPrior(training.observation_fit.parameters), { causal: true }).nll
      : common.reduce((sum, index) => sum + .5 * (Math.log(2 * Math.PI * Math.max(Number.EPSILON, training.mse)) +
        values.errors[index] / Math.max(Number.EPSILON, training.mse)), 0);
    return { ...candidate, validation: {
      mse: values && common.length ? common.reduce((sum, index) => sum + values.errors[index], 0) / common.length : null,
      count: values ? common.length : 0, nll,
    } };
  });
}

function chronologicalSplit(rows: RoomMeanQuarter[], band?: BandFit): number {
  if (!band) return Math.floor(rows.length * 2 / 3);
  // A cold band may occur entirely in the final third of the calendar. Its
  // held-out period must follow its own earlier evidence, not other weather.
  const selected = rows.flatMap((row, index) => finite(row.outdoor_c) && band.outdoor(row.outdoor_c) &&
    finite(row.room_c) && finite(row.house_c) && finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row)
    ? [{ index, hours: roomIntervalHours(row) }] : []);
  const target = selected.reduce((total, row) => total + row.hours, 0) * 2 / 3;
  let hours = 0;
  for (const row of selected) {
    hours += row.hours;
    if (hours >= target) return row.index + 1;
  }
  return rows.length;
}

function forecastError(fit: FitEvaluation, initialStates: Map<number, number>, rows: RoomMeanQuarter[],
  segments: Int32Array, heat: Float64Array, initial: Float64Array): number | null {
  const byStart = new Map(rows.map((row, i) => [row.start_ms, i]));
  let sum = 0, count = 0, lastEvaluated = -Infinity;
  const forcing = (row: RoomMeanQuarter) => (fit.k - fit.beta[2]) * row.house_c! + fit.beta[2] * row.outdoor_c! +
    fit.beta[1] + (fit.solar ? fit.beta[3] * row.solar_w_per_m2! : 0);
  for (let i = 0; i < rows.length; i++) {
    const segment = segments[i];
    if (segment === -1) continue;
    const q = rows[i], end = byStart.get(q.start_ms + 12 * 3_600_000);
    if (q.start_ms - lastEvaluated < 2 * 3_600_000 || end === undefined) continue;
    lastEvaluated = q.start_ms;
    let complete = true;
    for (let j = i; j <= end; j++) if (segments[j] !== segment) { complete = false; break; }
    if (!complete) continue;
    if (fit.family === "equilibrium" || fit.beta[0] === 0) {
      // Evolve the heater's temperature contribution, not D=contribution/gain:
      // an identified zero heater coefficient must never cause division by zero.
      const pair = fit.family === "equilibrium"
        ? roomEquilibriumMeanPair(fit.lag, roomIntervalHours(q), roomIntervalHours(rows[i + 1]))
        : roomMeanPair(roomMeanObservation(fit.k, fit.lag, roomIntervalHours(q)),
          roomMeanObservation(fit.k, fit.lag, roomIntervalHours(rows[i + 1])));
      let response = fit.beta[0] * heat[i] + (pair.memory !== 0
        ? initial[i] / pair.memory * (initialStates.get(segment) ?? 0) : 0);
      const first = roomMeanObservation(fit.k, fit.lag, roomIntervalHours(q));
      let temperature = fit.family === "equilibrium" ? 0
        : (q.room_c! - first.U * response - (first.V - first.U) * fit.beta[0] * q.heat_w! - first.V * forcing(q)) / first.E;
      for (let j = i; j < end; j++) {
        const row = rows[j], step = roomMeanObservation(fit.k, fit.lag, roomIntervalHours(row));
        if (fit.family !== "equilibrium") temperature = step.a * temperature + step.B * response +
          (step.effect - step.B) * fit.beta[0] * row.heat_w! + step.effect * forcing(row);
        response = step.C * response + (1 - step.C) * fit.beta[0] * row.heat_w!;
      }
      const next = rows[end], duration = roomIntervalHours(next);
      const last = roomMeanObservation(fit.k, fit.lag, duration);
      const fraction = fit.lag ? -fit.lag * Math.expm1(-duration / fit.lag) / duration : 0;
      const predicted = fit.family === "equilibrium"
        ? (1 - fit.beta[2]) * next.house_c! + fit.beta[2] * next.outdoor_c! + fit.beta[1] +
          (fit.solar ? fit.beta[3] * next.solar_w_per_m2! : 0) + fraction * response +
          (1 - fraction) * fit.beta[0] * next.heat_w!
        : last.E * temperature + last.U * response + (last.V - last.U) * fit.beta[0] * next.heat_w! + last.V * forcing(next);
      sum += Math.abs(predicted - next.room_c!); count++;
      continue;
    }
    const op = roomMeanObservation(fit.k, fit.lag, roomIntervalHours(q));
    const pair = roomMeanPair(op, roomMeanObservation(fit.k, fit.lag, roomIntervalHours(rows[i + 1])));
    const D = heat[i] + (pair.memory !== 0 ? initial[i] / pair.memory * (initialStates.get(segment) ?? 0) / fit.beta[0] : 0);
    let delivered = D;
    let temperature = (q.room_c! - fit.beta[0] * (op.U * D + (op.V - op.U) * q.heat_w!) - op.V * forcing(q)) / op.E;
    for (let j = i; j < end; j++) {
      const row = rows[j], step = roomMeanObservation(fit.k, fit.lag, roomIntervalHours(row));
      temperature = step.a * temperature + fit.beta[0] * (step.B * delivered + (step.effect - step.B) * row.heat_w!) + step.effect * forcing(row);
      delivered = step.C * delivered + (1 - step.C) * row.heat_w!;
    }
    const next = rows[end], last = roomMeanObservation(fit.k, fit.lag, roomIntervalHours(next));
    const predicted = last.E * temperature + fit.beta[0] * (last.U * delivered + (last.V - last.U) * next.heat_w!) + last.V * forcing(next);
    sum += Math.abs(predicted - next.room_c!); count++;
  }
  return count ? sum / count : null;
}

function prepareMeanFit(quarters: RoomMeanQuarter[], ratedPowerW: number | null, band?: BandFit) {
  const observed = [...quarters].sort((a, b) => a.start_ms - b.start_ms);
  // A retained band's cleaning scale depends only on its own contiguous
  // weather episodes. New warm-season samples cannot rewrite cold evidence.
  const include = band ? (row: RoomMeanQuarter) => finite(row.outdoor_c) && band.outdoor(row.outdoor_c) : undefined;
  const { rows, count } = prepareRoomMeanEvidence(observed, include);
  const usable = rows.filter(r => finite(r.room_c) && finite(r.heat_w) && r.heat_w >= 0 && roomHeatingDirectionKnown(r) &&
    (!include || include(r)));
  const covered = usable.filter(r => finite(r.house_c) && finite(r.outdoor_c));
  const withSun = covered.filter(r => finite(r.solar_w_per_m2));
  const hours = (input: RoomMeanQuarter[]) => input.reduce((total, row) => total + roomIntervalHours(row), 0);
  const observationHours = hours(covered), heatedHours = hours(covered.filter(r => r.heat_w! > HEATED_SAMPLE_MIN_W));
  const solar = (band !== undefined || hours(withSun) >= MIN_TRAINING_SAMPLES / 4) && hours(withSun) >= observationHours * MIN_SOLAR_COVERAGE &&
    withSun.some(row => row.solar_w_per_m2 !== withSun[0].solar_w_per_m2);
  const split = chronologicalSplit(observed, band);
  const trainingRows = prepareRoomMeanEvidence(observed.slice(0, split), include).rows;
  // Correction at the training edge cannot look into held-out observations.
  const validationRows = [...trainingRows, ...prepareRoomMeanEvidence(observed.slice(split), include).rows];
  const observation = rows.some(row => roomIntervalSeconds(row) !== 900) ? "interval_mean" as const : "quarter_mean" as const;
  const evidence = { implementation: ROOM_MEAN_IMPLEMENTATION, ...(count ? { estimated_temperature_readings: count } : {}),
    observation_intervals: covered.length, observation_hours: observationHours, heated_hours: heatedHours,
    attributed_heater_intervals: covered.filter(row => row.heat_attributed).length,
    operation_evidence: { constrained_intervals: covered.filter(row => row.operation_fact !== undefined).length,
      fan_or_cooling_flag_intervals: covered.filter(row => row.operation_fact !== undefined && row.cooling === true).length,
      revisions: [...new Set(covered.flatMap(row => row.operation_fact ? [row.operation_fact] : []))].sort() } };
  const referenceNoise = (input: RoomMeanQuarter[]) => {
    let sum = 0, count = 0;
    visitTransitions(input, 0, 0, solar, band, index => {
      sum += (input[index + 1].room_c! - input[index].room_c!) ** 2; count++;
    });
    return Math.max(Number.EPSILON, count ? sum / count : 0);
  };
  return { rows, trainingRows, validationRows, usable, solar, split, observation, evidence, hours, ratedPowerW,
    noiseReference: { training: referenceNoise(trainingRows), full: referenceNoise(rows) },
    workspace: new MeanFeatureWorkspace(rows.length, FEATURE_WIDTH) };
}

interface MeanFitCandidate {
  family: ResponseFamily;
  training: FitEvaluation | null;
  full: FitEvaluation;
}

function finishMeanFit(prepared: ReturnType<typeof prepareMeanFit>, candidates: MeanFitCandidate[]): RoomMeanFitResult<DynamicThermalZoneModel>;
function finishMeanFit(prepared: ReturnType<typeof prepareMeanFit>, candidates: MeanFitCandidate[], band: BandFit): RoomMeanFitResult;
function finishMeanFit(prepared: ReturnType<typeof prepareMeanFit>, candidates: MeanFitCandidate[], band?: BandFit): RoomMeanFitResult {
  const { rows, validationRows, usable, solar, split, observation, evidence, hours, ratedPowerW, workspace } = prepared;
  if (!candidates.length) return { ok: false, reason: usable.length ? "singular" : "insufficient_samples", sample_count: usable.length,
    learning_evidence: { method: ROOM_MEAN_LEARNING_METHOD, family: ROOM_EXCHANGE_FAMILY, observation, selection: "chronological_transition_mse",
      training_pairs: 0, validation_pairs: 0, validation_mse_c2: null, selected_boundary: null, selected_lag_h: null, ...evidence } };
  const allScored = scoreCandidates(candidates, rows, validationRows, split, solar, band);
  const isAdditional = (fit: FitEvaluation | null) => fit?.observation_fit?.kind === "additional_heat";
  const scored = allScored.filter(c => !isAdditional(c.full));
  // Retain the finite family's held-out policy. The limiting family includes
  // EVERY lag under the family-selection criterion: a short holdout cannot
  // hide a better nested limiting comparator by picking another lag first.
  const choose = (family: typeof scored) => {
    const validated = family.filter(c => c.validation.mse !== null);
    return (validated.length ? validated : family).reduce<(typeof scored)[number] | null>((best, c) =>
      !best || (c.validation.mse ?? c.full.mse) < (best.validation.mse ?? best.full.mse) ? c : best, null);
  };
  const selected = choose(scored.filter(c => c.family === "finite"));
  const limitFamily = (family: ResponseFamily) => {
    const candidates = scored.filter(c => c.family === family), held = choose(candidates);
    const score = (candidate: (typeof scored)[number]) => conditionalAicc(candidate.full.n,
      { mse: candidate.full.mse, parameters: candidate.full.n - candidate.full.dof + 2 });
    const best = candidates.filter(c => score(c) !== null)
      .reduce<(typeof scored)[number] | null>((winner, c) => !winner || score(c)! < score(winner)! ? c : winner, null) ?? held;
    return { candidates, held, best };
  };
  const equilibriumFamily = limitFamily("equilibrium"), integratorFamily = limitFamily("integrator");
  const equilibrium = equilibriumFamily.best, integrator = integratorFamily.best;
  let chosen = selected ?? equilibrium ?? integrator!;
  let responseSelection: RoomResponseSelection | undefined;
  if (band) {
    const limit = equilibrium?.full, slow = integrator?.full;
    responseSelection = compareFiniteRoomResponse(chosen.full.n,
      selected ? { mse: selected.full.mse, parameters: selected.full.n - selected.full.dof + 2 } : null,
      limit ? { mse: limit.mse,
        // Both families search the same lag grid: count its selected parameter
        // and residual variance. The exact limit has no finite exchange k.
        parameters: limit.n - limit.dof + 2,
        steady: { heater_c_per_w: limit.beta[0], outdoor_share: limit.beta[2], offset_c: limit.beta[1],
          solar_c_per_wm2: limit.solar ? limit.beta[3] : null }, lag_h: limit.lag } : null,
      slow ? { mse: slow.mse, parameters: slow.n - slow.dof + 2,
        response: { heater_c_per_wh: slow.beta[0], background_c_per_h: slow.beta[1],
          solar_c_per_h_per_wm2: slow.solar ? slow.beta[3] : null }, lag_h: slow.lag } : null,
      selected?.full?.lag ?? null);
    responseSelection.equilibrium_lags_evaluated = equilibriumFamily.candidates.map(c => c.full.lag);
    responseSelection.equilibrium_validation_pairs = equilibrium?.validation.count ?? 0;
    responseSelection.equilibrium_validation_mse_c2 = equilibrium?.validation.mse ?? null;
    responseSelection.equilibrium_holdout_selected_lag_h = equilibriumFamily.held?.full.lag ?? null;
    responseSelection.integrator_lags_evaluated = integratorFamily.candidates.map(c => c.full.lag);
    responseSelection.integrator_validation_pairs = integrator?.validation.count ?? 0;
    responseSelection.integrator_validation_mse_c2 = integrator?.validation.mse ?? null;
    responseSelection.integrator_holdout_selected_lag_h = integratorFamily.held?.full.lag ?? null;
    if (responseSelection.selected === "equilibrium_response") chosen = equilibrium!;
    else if (responseSelection.selected === "integrator_response") chosen = integrator!;
  }
  const marginalScore = (c: typeof allScored[number]) => {
    const fit = c.full;
    const nll = fit.observation_fit?.objective ?? .5 * fit.n * (Math.log(2 * Math.PI * Math.max(Number.EPSILON, fit.mse)) + 1);
    // Physical coefficients, nuisance initial heater states, selected lag and
    // noise variance; HMM adds external scale, two transitions and one initial
    // probability. Integrate latent heat: never count fitted shifts as data.
    const parameters = fit.n - fit.dof + 2 + (fit.observation_fit ? (fit.observation_fit.kind === "additional_heat" ? 4 : 0) +
      Math.max(0, Object.keys(fit.observation_fit.parameters.sigma_by_class ?? {}).length - 1) : 0);
    return 2 * nll + parameters * Math.log(fit.n);
  };
  // Full-data identification owns publication. An unavailable earlier fit
  // makes chronological validation unavailable, never discards later data.
  const latentScored = allScored.filter(c => isAdditional(c.full));
  if (band) {
    const comparable = allScored;
    chosen = comparable.reduce((best, c) => marginalScore(c) < marginalScore(best) ? c : best);
    const bestFamily = (family: ResponseFamily) => comparable.filter(c => c.family === family)
      .reduce<(typeof comparable)[number] | null>((best, c) => !best || marginalScore(c) < marginalScore(best) ? c : best, null);
    responseSelection = { ...responseSelection!, criterion: "regularized_marginal_bic",
      finite_marginal_bic: bestFamily("finite") ? marginalScore(bestFamily("finite")!) : null,
      equilibrium_marginal_bic: bestFamily("equilibrium") ? marginalScore(bestFamily("equilibrium")!) : null,
      integrator_marginal_bic: bestFamily("integrator") ? marginalScore(bestFamily("integrator")!) : null,
      selected: chosen.family === "finite" ? "finite_response" : chosen.family === "integrator" ? "integrator_response" : "equilibrium_response",
      unavailable_reason: null, finite_predictive_nll: bestFamily("finite")?.validation.nll ?? null,
      equilibrium_predictive_nll: bestFamily("equilibrium")?.validation.nll ?? null,
      integrator_predictive_nll: bestFamily("integrator")?.validation.nll ?? null,
      finite_lag_h: bestFamily("finite")?.full.lag ?? null,
      equilibrium_lag_h: bestFamily("equilibrium")?.full.lag ?? null,
      integrator_lag_h: bestFamily("integrator")?.full.lag ?? null,
      steady_response: (() => { const f = bestFamily("equilibrium")?.full; return f ? {
        heater_c_per_w: f.beta[0], outdoor_share: f.beta[2], offset_c: f.beta[1], solar_c_per_wm2: f.solar ? f.beta[3] : null } : null; })(),
      integrator_response: (() => { const f = bestFamily("integrator")?.full; return f ? {
        heater_c_per_wh: f.beta[0], background_c_per_h: f.beta[1], solar_c_per_h_per_wm2: f.solar ? f.beta[3] : null } : null; })(),
      equilibrium_validation_pairs: bestFamily("equilibrium")?.validation.count ?? 0,
      equilibrium_validation_mse_c2: bestFamily("equilibrium")?.validation.mse ?? null,
      integrator_validation_pairs: bestFamily("integrator")?.validation.count ?? 0,
      integrator_validation_mse_c2: bestFamily("integrator")?.validation.mse ?? null };
  }
  const fit = chosen.full;
  const learning: RoomLearningEvidence = {
    method: ROOM_MEAN_LEARNING_METHOD, family: ROOM_EXCHANGE_FAMILY, observation, selection: "chronological_transition_mse",
    training_pairs: chosen.training?.n ?? 0, validation_pairs: chosen.validation.count,
    validation_mse_c2: chosen.validation.mse, selected_boundary: "house_outdoor", selected_lag_h: fit.lag,
    ...evidence, residual_degrees_of_freedom: fit.dof,
    ...(responseSelection?.criterion === "regularized_marginal_bic" ? { selection: "regularized_marginal_bic" as const } : {}),
    ...(responseSelection ? { response_selection: responseSelection } : {}),
  };
  if (responseSelection?.selected === "unavailable" &&
    (responseSelection.unavailable_reason !== "limiting_families_unidentified" || !selected)) {
    return { ok: false, reason: "response_unresolved", sample_count: fit.n, learning_evidence: learning };
  }
  let initialStates = fit.observation_fit ? new Map(fit.observation_fit.initial) : fit.initial;
  let attribution: RoomHeatAttributionInterval[] | undefined;
  if (latentScored.length) {
    const diagnostics = isAdditional(fit) ? chosen : latentScored.reduce((best, c) => marginalScore(c) < marginalScore(best) ? c : best);
    const full = diagnostics.full, external = full.observation_fit!;
    const residuals = externalResiduals(rows, full, new Map(external.initial), band);
    const inference = inferExternalHeat(residuals, external.parameters);
    const episodes: { from_ms: number; to_ms: number; probability: number }[] = [];
    let episode: typeof episodes[number] | undefined, mass = 0, length = 0;
    residuals.forEach((residual, i) => {
      const row = rows[residual.index], previous = residuals[i - 1];
      if (inference.external_probability[i] > .5) {
        if (!episode || !previous || previous.segment !== residual.segment || residual.index !== previous.index + 1) {
          episode = { from_ms: row.start_ms, to_ms: row.start_ms, probability: 0 }; episodes.push(episode); mass = 0; length = 0;
        }
        episode.to_ms = rows[residual.index + 1].start_ms + roomIntervalSeconds(rows[residual.index + 1]) * 1000;
        mass += inference.external_probability[i]; length++; episode.probability = mass / length;
      } else episode = undefined;
    });
    const unit = full.family === "equilibrium" ? "C" as const : "C/h" as const;
    attribution = residuals.map((residual, i) => ({ from_ms: rows[residual.index].start_ms,
      to_ms: rows[residual.index + 1].start_ms, probability: inference.external_probability[i],
      forcing: inference.expected_c[i] / residual.forcing_scale, forcing_unit: unit, heat_w: rows[residual.index].heat_w! }));
    const hours = attribution.map(row => (row.to_ms - row.from_ms) / 3_600_000);
    const observedHours = hours.reduce((sum, value) => sum + value, 0);
    const integratedForcing = attribution.reduce((sum, row, i) => sum + row.forcing * hours[i], 0);
    learning.additional_heat = { method: "positive_residual_hmm_v2", selected: isAdditional(fit),
      iterations: external.iterations, converged: external.converged, failure: external.failure, parameters: external.parameters,
      validation_nll: diagnostics.validation.nll,
      plain_validation_nll: scored.find(c => c.family === diagnostics.family && c.full.lag === full.lag)?.validation.nll ?? null,
      expected_intervals: inference.external_probability.reduce((sum, p) => sum + p, 0),
      expected_hours: attribution.reduce((sum, row, i) => sum + row.probability * hours[i], 0),
      episode_count: episodes.length, mean_forcing: integratedForcing / observedHours,
      forcing_unit: unit, heater_equivalent_wh: full.beta[0] > 0 ? integratedForcing / full.beta[0] : null,
      clean_noise_c: external.parameters.sigma_c,
      variance_regularization: { family: "scaled_inverse_chi_squared", degrees_of_freedom: 1,
        reference_c2: external.parameters.noise_reference_c2!, source: "pooled_observed_transition_mean_square" },
      prediction_error_scope: "heater_only_no_future_external_heat" };
  }
  if (!initialStates) {
    // Staged bands keep only scalar fits. Recover the selected family's own
    // nuisance states with exactly its original design and constraints.
    const selectedDesign = prepareDesign(rows, fit.lag, fit.solar, band, workspace)(fit.family === "equilibrium" ? Infinity : fit.k);
    const selectedBand = fit.family === "integrator" && band ? { ...band, house: 0 } : band;
    const recovered = estimate(selectedDesign, fit.k, fit.lag, fit.solar, selectedBand, fit.family);
    if (!recovered || recovered.n !== fit.n || recovered.dof !== fit.dof || recovered.mse !== fit.mse ||
      recovered.beta.some((value, i) => value !== fit.beta[i])) throw new Error("Staged room band fit changed at finalization");
    initialStates = recovered.initial;
  }
  const gain = fit.beta[0];
  const segments = new Int32Array(rows.length).fill(-1);
  const delivered = new Float64Array(rows.length), initial = new Float64Array(rows.length);
  const changes: number[] = [];
  visitTerms(rows, fit, 0, band, ({ index, segment, delivered: watts, z }) => {
    segments[index] = segment;
    delivered[index] = watts;
    initial[index] = z;
    changes.push(rows[index + 1].room_c! - rows[index].room_c!);
  });
  const prediction = forecastError(fit, initialStates, rows, segments, delivered, initial);
  const warnings: ThermalFitRejection[] = [];
  if (evidence.observation_hours < MIN_TRAINING_SAMPLES / 4) warnings.push("insufficient_samples");
  if (evidence.heated_hours < MIN_HEATED_SAMPLES / 4) warnings.push("insufficient_heating");
  if (prediction !== null && prediction > MAX_PREDICTION_ERROR_C) warnings.push("poor_fit");
  const solarRows = usable.filter(r => finite(r.solar_w_per_m2));
  const average = changes.reduce((sum, v) => sum + v, 0) / changes.length;
  const variance = changes.reduce((sum, v) => sum + (v - average) ** 2, 0) / changes.length;
  const common = {
    heat_lag_h: fit.lag,
    solar_mean_w_per_m2: fit.solar ? solarRows.reduce((sum, r) => sum + r.solar_w_per_m2! * roomIntervalHours(r), 0) / hours(solarRows) : null,
    sample_count: fit.n, r2: variance > 0 ? 1 - fit.mse / variance : 0,
    residual_std_c: Math.sqrt(fit.mse), prediction_error_c: prediction,
  };
  const model: ThermalZoneModel = fit.family === "equilibrium" ? {
    ...common, response_family: "equilibrium", heater_c_per_w: gain, outdoor_share: fit.beta[2],
    offset_c: fit.beta[1], solar_c_per_wm2: fit.solar ? fit.beta[3] : null,
  } : {
    ...common, response_family: fit.family,
    gain_c_per_wh: gain, cooling_constant_per_h: fit.beta[2],
    house_coupling_per_h: fit.k - fit.beta[2],
    background_gain_c_per_h: fit.beta[1], solar_gain_c_per_h_per_wm2: fit.solar ? fit.beta[3] : null,
    thermal_capacity_wh_per_c: gain > 0 ? 1 / gain : null,
    heat_loss_w_per_c: gain > 0 ? fit.k / gain : null, time_constant_h: fit.k > 0 ? 1 / fit.k : null,
    heating_rate_c_per_h: ratedPowerW && ratedPowerW > 0 ? gain * ratedPowerW : null,
  };
  return { ok: true, model, ...(warnings.length ? { warnings } : {}), learning_evidence: learning,
    ...(attribution ? { additional_heat_intervals: attribution } : {}) };
}

export function fitRoomMeans(quarters: RoomMeanQuarter[], ratedPowerW?: number | null,
  options?: undefined): RoomMeanFitResult<DynamicThermalZoneModel>;
export function fitRoomMeans(quarters: RoomMeanQuarter[], ratedPowerW: number | null,
  options: { outdoor: (outdoorC: number) => boolean }): RoomMeanFitResult;
export function fitRoomMeans(quarters: RoomMeanQuarter[], ratedPowerW: number | null = null,
  options?: { outdoor: (outdoorC: number) => boolean }): RoomMeanFitResult {
  if (options) return fitIndependentRoomBand(quarters, options.outdoor, ratedPowerW).result;
  const prepared = prepareMeanFit(quarters, ratedPowerW);
  const { rows, trainingRows, solar, workspace } = prepared;
  const candidates = HEAT_LAG_GRID_H.flatMap(lag => {
    const trainingDesign = prepareDesign(trainingRows, lag, solar, undefined, workspace);
    const fullDesign = prepareDesign(rows, lag, solar, undefined, workspace);
    const training = fitCandidate(trainingRows, lag, solar, undefined, trainingDesign);
    const full = fitCandidate(rows, lag, solar, undefined, fullDesign);
    return full ? [{ family: "finite" as const, training, full }] : [];
  });
  return finishMeanFit(prepared, candidates);
}

export function prepareIndependentRoomBand(rows: RoomMeanQuarter[], outdoor: (outdoorC: number) => boolean,
  ratedPowerW: number | null = null) {
  const band = { outdoor };
  return { ...prepareMeanFit(rows, ratedPowerW, band), band };
}

export type PreparedIndependentRoomBand = ReturnType<typeof prepareIndependentRoomBand>;

function fitSummary(fit: Fit | null): RoomBandFitSummary | null {
  if (!fit) return null;
  const { k, beta, mse, n, dof } = fit;
  return { k, beta, mse, n, dof, ...(fit.observation_fit ? { observation_fit: fit.observation_fit } : {}) };
}

function prepareBandFitCell(prepared: PreparedIndependentRoomBand, index: number) {
  const cell = BAND_CELL_GRID[index];
  if (!cell) throw new Error("Unknown room band fit cell");
  const { lag_h: lag, partition } = cell;
  const rows = partition === "training" ? prepared.trainingRows : prepared.rows;
  const { solar, band, workspace } = prepared;
  return { cell, lag, rows, solar, band, design: prepareDesign(rows, lag, solar, band, workspace) };
}

/** One cell shares its observation design across the three response families. */
function plainRoomBandFitCell(prepared: PreparedIndependentRoomBand, index: number): RoomBandFitCell {
  const { cell, lag, rows, solar, band, design } = prepareBandFitCell(prepared, index);
  return { ...cell, additional_heat: { finite: null, equilibrium: null, integrator: null }, fits: {
    finite: fitSummary(fitCandidate(rows, lag, solar, band, design)),
    equilibrium: fitSummary(estimate(design(Infinity), 1, lag, solar, band, "equilibrium")),
    // At k=0 both nonnegative exchange rates vanish, removing outdoor share.
    integrator: fitSummary(estimate(design(0), 0, lag, solar, { outdoor: band.outdoor, house: 0 }, "integrator")),
  } };
}

/** A cell's empirical additional-heat fit is a resumable ECM solve. One step
 * performs one physical profile update, so a long historical fit never needs
 * to complete its whole iteration path in one Edge invocation. */
export interface RoomHeatFitState {
  version: 2; index: number; cell: RoomBandFitCell; family_index: number;
  working: RoomBandFitSummary | null; observation_kind: "gaussian" | "additional_heat";
}
const EXTERNAL_FIT_MAX_ITERATIONS = 200;
const EXTERNAL_FIT_LOG_TOLERANCE = 1e-7;

function stationaryExternalPrior(parameters: ExternalHeatParameters): ExternalHeatParameters {
  const a = parameters.transition[0][1], b = parameters.transition[1][0], total = a + b;
  return total > 0 ? { ...parameters, initial: [b / total, a / total] } : parameters;
}

function externalResiduals(rows: RoomMeanQuarter[], fit: FitEvaluation, initial: Map<number, number>, band?: BandFit) {
  const result: (ExternalHeatResidual & { index: number; forcing_scale: number })[] = [];
  let segment = -1, previous = -2, sourceSegment = -1;
  visitTerms(rows, fit, 0, band, t => {
    if (t.segment !== sourceSegment || t.index !== previous + 1) segment++;
    sourceSegment = t.segment; previous = t.index;
    result.push({ index: t.index, segment, forcing_scale: t.x[1],
      duration_h: (roomIntervalHours(rows[t.index]) + roomIntervalHours(rows[t.index + 1])) / 2,
      noise_class: `${roomIntervalSeconds(rows[t.index])}/${roomIntervalSeconds(rows[t.index + 1])}`,
      residual_c: t.y - t.x.reduce((sum, x, j) => sum + x * fit.beta[j], 0) - t.z * (initial.get(t.segment) ?? 0) });
  });
  return result;
}

function parseObservationFit(value: unknown): RoomObservationFit {
  const fields = fitRecord(value), parameters = fitRecord(fields?.parameters);
  if (!fields || !parameters || Object.keys(fields).length !== 8 ||
    (fields.kind !== "gaussian" && fields.kind !== "additional_heat") ||
    (fields.failure !== null && fields.failure !== "iteration_limit" && fields.failure !== "likelihood_decreased" && fields.failure !== "profile_unresolved") ||
    typeof fields.iterations !== "number" || !Number.isSafeInteger(fields.iterations) || fields.iterations < 0 ||
    fields.iterations > EXTERNAL_FIT_MAX_ITERATIONS || typeof fields.converged !== "boolean" ||
    typeof fields.nll !== "number" || !Number.isFinite(fields.nll) ||
    typeof fields.objective !== "number" || !Number.isFinite(fields.objective) || !Array.isArray(fields.initial) ||
    fields.initial.some(pair => !Array.isArray(pair) || pair.length !== 2 ||
      !Number.isSafeInteger(pair[0]) || pair[0] < 0 || !Number.isFinite(pair[1]) || pair[1] < 0)) {
    throw new Error("Invalid staged external heat fit");
  }
  // The numerical owner validates probabilities, scales and normalization.
  inferExternalHeat([{ residual_c: 0, segment: 0 }], parameters as unknown as ExternalHeatParameters);
  return { kind: fields.kind as RoomObservationFit["kind"], parameters: parameters as unknown as ExternalHeatParameters, iterations: fields.iterations,
    converged: fields.converged, failure: fields.failure as RoomObservationFit["failure"], nll: fields.nll, objective: fields.objective, initial: fields.initial as [number, number][] };
}

export function parseRoomHeatFitState(value: unknown, index: number): RoomHeatFitState | null {
  if (value == null) return null;
  const fields = fitRecord(value), cell = fitRecord(fields?.cell), expected = BAND_CELL_GRID[index];
  const fits = fitRecord(cell?.fits), additional = fitRecord(cell?.additional_heat);
  if (!expected || !fields || Object.keys(fields).length !== 6 || fields.version !== 2 ||
    (fields.observation_kind !== "gaussian" && fields.observation_kind !== "additional_heat") || fields.index !== index ||
    typeof fields.family_index !== "number" || !Number.isInteger(fields.family_index) || fields.family_index < 0 || fields.family_index > 2 ||
    !cell || Object.keys(cell).length !== 4 || cell.lag_h !== expected.lag_h || cell.partition !== expected.partition ||
    !fits || Object.keys(fits).length !== 3 || !additional || Object.keys(additional).length !== 3) {
    throw new Error("Invalid additional heat iteration checkpoint");
  }
  const decoded = (source: Record<string, unknown>) => ({ finite: parseFitSummary(source.finite, "finite"),
    equilibrium: parseFitSummary(source.equilibrium, "equilibrium"), integrator: parseFitSummary(source.integrator, "integrator") });
  const family = RESPONSE_FAMILIES[fields.family_index];
  const working = parseFitSummary(fields.working, family);
  if (working && !working.observation_fit) throw new Error("Missing additional heat iteration parameters");
  return { version: 2, index, family_index: fields.family_index,
    observation_kind: fields.observation_kind as RoomHeatFitState["observation_kind"], cell: { ...expected, fits: decoded(fits), additional_heat: decoded(additional) }, working };
}

function roomHeatFitMicrostep(prepared: PreparedIndependentRoomBand, index: number,
  previous: RoomHeatFitState | null = null): { cell: RoomBandFitCell | null; state: RoomHeatFitState | null } {
  const state: RoomHeatFitState = previous ? structuredClone(previous) : {
    version: 2, index, cell: plainRoomBandFitCell(prepared, index), family_index: 0, working: null, observation_kind: "gaussian",
  };
  if (state.index !== index) throw new Error("Additional heat iteration belongs to another cell");
  const { lag_h: lag, partition } = state.cell;
  const rows = partition === "training" ? prepared.trainingRows : prepared.rows;
  const { solar, band, workspace } = prepared;
  while (state.family_index < RESPONSE_FAMILIES.length) {
    const family = RESPONSE_FAMILIES[state.family_index], plain = state.cell.fits[family];
    if (!plain) { state.family_index++; state.observation_kind = "gaussian"; continue; }
    const physical = (latent?: Parameters<typeof prepareDesign>[5], fixed?: RoomBandFitSummary) => {
      const design = prepareDesign(rows, lag, solar, band, workspace, latent);
      const localBand = family === "integrator" ? { ...band, house: 0 } : band;
      return fixed ? estimate(design(family === "equilibrium" ? Infinity : fixed.k), fixed.k, lag, solar, localBand, family)
        : family === "finite" ? fitCandidate(rows, lag, solar, band, design)
        : estimate(design(family === "equilibrium" ? Infinity : 0), family === "equilibrium" ? 1 : 0, lag, solar, localBand, family);
    };
    let working = state.working;
    if (!working) {
      const fit = plain.observation_fit ? { ...plain, family, lag, solar, roundoff: 0,
        initial: new Map(plain.observation_fit.initial) } : physical(undefined, plain);
      if (!fit) { state.family_index++; state.observation_kind = "gaussian"; continue; }
      const residuals = externalResiduals(rows, fit, fit.initial, band);
      if (!residuals.length) { state.family_index++; state.observation_kind = "gaussian"; continue; }
      let parameters = initializeExternalHeat(residuals);
      // A candidate-independent unit-information calibration regularizes the
      // mixture's otherwise unbounded zero-noise likelihood. It describes
      // observed transition variation, never measured sensor precision.
      parameters.noise_reference_c2 = prepared.noiseReference[partition];
      if (state.observation_kind === "gaussian") {
        parameters.initial = [1, 0]; parameters.transition = [[1, 0], [0, 1]];
      }
      if (state.observation_kind === "gaussian" && fit.mse <= fit.roundoff) {
        parameters = updateExternalHeat(residuals, parameters).parameters;
        const exact = inferExternalHeat(residuals, parameters);
        state.cell.fits[family] = { ...plain, observation_fit: { kind: "gaussian", parameters,
          iterations: 1, converged: true, failure: null, nll: exact.nll, objective: exact.objective, initial: [...fit.initial] } };
        state.family_index++; continue;
      }
      const initialInference = inferExternalHeat(residuals, parameters);
      working = { ...plain, observation_fit: { kind: state.observation_kind, parameters, iterations: 0, converged: false, failure: null,
        nll: initialInference.nll, objective: initialInference.objective, initial: [...fit.initial] } };
    }
    const evaluation: FitEvaluation = { ...working, family, lag, solar };
    const external = working.observation_fit!;
    const residuals = externalResiduals(rows, evaluation, new Map(external.initial), band);
    const update = updateExternalHeat(residuals, external.parameters);
    const latent = { mean: new Map<number, number>(), variance: new Map<number, number>(), precision: new Map<number, number>() };
    residuals.forEach((residual, i) => {
      const scale = residual.forcing_scale, mean = update.inference.expected_c[i] / scale;
      latent.mean.set(residual.index, mean);
      latent.variance.set(residual.index, Math.max(0, update.inference.second_moment_c2[i] / (scale * scale) - mean * mean));
      const sigma = update.parameters.sigma_by_class?.[residual.noise_class!] ?? update.parameters.sigma_c;
      latent.precision.set(residual.index, 1 / (sigma * sigma));
    });
    const next = physical(latent);
    if (!next) {
      const completed = { ...working, observation_fit: { ...external, failure: "profile_unresolved" as const, converged: false } };
      if (state.observation_kind === "gaussian") { state.cell.fits[family] = completed; state.observation_kind = "additional_heat"; }
      else { state.cell.additional_heat[family] = completed; state.family_index++; state.observation_kind = "gaussian"; }
      state.working = null; continue;
    }
    const nextResiduals = externalResiduals(rows, next, next.initial, band);
    const inference = inferExternalHeat(nextResiduals, update.parameters);
    const iterations = external.iterations + 1;
    const improvement = external.objective - inference.objective;
    const arithmeticTolerance = Number.EPSILON * 64 * residuals.length * (1 + Math.abs(external.objective));
    const decreased = improvement < -arithmeticTolerance;
    const converged = !decreased && Math.abs(improvement) <= EXTERNAL_FIT_LOG_TOLERANCE * (1 + Math.abs(external.objective));
    const failure = decreased ? "likelihood_decreased" as const :
      !converged && iterations === EXTERNAL_FIT_MAX_ITERATIONS ? "iteration_limit" as const : null;
    const summary: RoomBandFitSummary = { ...fitSummary(next)!,
      mse: nextResiduals.reduce((sum, r) => sum + r.residual_c ** 2, 0) / nextResiduals.length,
      observation_fit: { kind: state.observation_kind, parameters: update.parameters, iterations, converged, failure, nll: inference.nll, objective: inference.objective, initial: [...next.initial] } };
    if (converged || failure !== null) {
      const completed = decreased ? { ...working, observation_fit: {
        ...external, failure: "likelihood_decreased" as const, converged: false } } : summary;
      if (state.observation_kind === "gaussian") { state.cell.fits[family] = completed; state.observation_kind = "additional_heat"; }
      else { state.cell.additional_heat[family] = completed; state.family_index++; state.observation_kind = "gaussian"; }
      state.working = null;
    } else state.working = summary;
    if (state.family_index < RESPONSE_FAMILIES.length) return { cell: null, state };
  }
  return { cell: state.cell, state: null };
}

/** The elapsed budget bounds batches of pure numerical work; the capture
 * and fence stay with the caller. A single physical profile is the atomic
 * work unit, independently CPU-qualified on a full 400-day capture. */
export function advanceIndependentRoomBandCell(prepared: PreparedIndependentRoomBand, index: number,
  state: RoomHeatFitState | null = null): { cell: RoomBandFitCell | null; state: RoomHeatFitState | null } {
  const started = performance.now();
  let step = roomHeatFitMicrostep(prepared, index, state);
  while (!step.cell && performance.now() - started < 200) step = roomHeatFitMicrostep(prepared, index, step.state);
  return step;
}

/** Offline callers run exactly the same deterministic checkpoint steps. */
export function fitIndependentRoomBandCell(prepared: PreparedIndependentRoomBand, index: number): RoomBandFitCell {
  let state: RoomHeatFitState | null = null;
  for (;;) {
    const step = advanceIndependentRoomBandCell(prepared, index, state);
    if (step.cell) return step.cell;
    state = step.state;
  }
}

/** Evaluate one exchange point for cross-runtime numerical qualification. */
export function evaluateRoomBandFiniteTrial(prepared: PreparedIndependentRoomBand, index: number,
  k: number): RoomBandFitSummary | null {
  if (!(k > 0) || !Number.isFinite(k)) throw new Error("Invalid room band finite trial exchange");
  const { lag, solar, band, design } = prepareBandFitCell(prepared, index);
  return fitSummary(estimate(design(k), k, lag, solar, band));
}

function fitRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseFitSummary(value: unknown, family: ResponseFamily): RoomBandFitSummary | null {
  if (value === null) return null;
  const fields = fitRecord(value);
  if (!fields || Object.keys(fields).length !== ("observation_fit" in fields ? 6 : 5)) throw new Error("Invalid staged room band fit summary");
  const { k, beta, mse, n, dof } = fields;
  if (typeof k !== "number" || !Number.isFinite(k) ||
    (family === "finite" ? k <= 0 : k !== (family === "equilibrium" ? 1 : 0)) ||
    !Array.isArray(beta) || (beta.length !== 3 && beta.length !== 4) || !Array.from(beta).every(Number.isFinite) ||
    typeof mse !== "number" || !Number.isFinite(mse) || mse < 0 ||
    typeof n !== "number" || !Number.isSafeInteger(n) || typeof dof !== "number" || !Number.isSafeInteger(dof) || dof <= 0 || n < dof) {
    throw new Error("Invalid staged room band fit summary");
  }
  const observation_fit = fields.observation_fit === undefined ? undefined : parseObservationFit(fields.observation_fit);
  return { k, beta, mse, n, dof, ...(observation_fit ? { observation_fit } : {}) };
}

/** Decode a stored prefix in production order. A null score is a completed fit. */
export function parseRoomBandFitCells(input: unknown): RoomBandFitCell[] {
  if (!Array.isArray(input) || input.length > ROOM_BAND_FIT_CELL_COUNT) throw new Error("Invalid staged room band fit prefix");
  return Array.from(input, (entry, i) => {
    const cell = fitRecord(entry), expected = BAND_CELL_GRID[i], fits = fitRecord(cell?.fits);
    if (cell?.lag_h !== expected.lag_h || cell?.partition !== expected.partition || Object.keys(cell).length !== 4 ||
      !fits || Object.keys(fits).length !== 3) throw new Error("Invalid staged room band fit cell");
    const additional = fitRecord(cell.additional_heat);
    if (!additional || Object.keys(additional).length !== 3) throw new Error("Invalid staged additional-heat fit");
    return { ...expected, additional_heat: {
      finite: parseFitSummary(additional.finite, "finite"), equilibrium: parseFitSummary(additional.equilibrium, "equilibrium"),
      integrator: parseFitSummary(additional.integrator, "integrator"),
    }, fits: {
      finite: parseFitSummary(fits.finite, "finite"),
      equilibrium: parseFitSummary(fits.equilibrium, "equilibrium"),
      integrator: parseFitSummary(fits.integrator, "integrator"),
    } };
  });
}

export function finalizeIndependentRoomBand(prepared: PreparedIndependentRoomBand, cells: RoomBandFitCell[]):
  { result: RoomMeanFitResult; minC: number | null; maxC: number | null } {
  if (cells.length !== ROOM_BAND_FIT_CELL_COUNT) throw new Error("Room band fit is incomplete");
  const candidates: MeanFitCandidate[] = [];
  const { solar, rows, band } = prepared;
  for (let i = 0; i < cells.length; i += 2) {
    const training = cells[i], full = cells[i + 1], lag = BAND_CELL_GRID[i].lag_h;
    if (training.lag_h !== lag || full.lag_h !== lag || training.partition !== "training" || full.partition !== "full") {
      throw new Error("Room band fit cells are out of order");
    }
    for (const kind of ["fits", "additional_heat"] as const) for (const family of RESPONSE_FAMILIES) {
      const trained = training[kind][family], complete = full[kind][family];
      const columns = solar ? 4 : 3;
      if ((trained && trained.beta.length !== columns) || (complete && complete.beta.length !== columns)) {
        throw new Error("Room band fit cells have different observation designs");
      }
      if (complete) candidates.push({ family, full: { ...complete, family, lag, solar },
        training: trained ? { ...trained, family, lag, solar } : null });
    }
  }
  const result = finishMeanFit(prepared, candidates, band);
  if (!result.ok) return { result, minC: null, maxC: null };
  let minC = Infinity, maxC = -Infinity;
  visitTransitions(rows, 0, result.model.heat_lag_h ?? 0, solar, band, i => {
    minC = Math.min(minC, rows[i].outdoor_c!, rows[i + 1].outdoor_c!);
    maxC = Math.max(maxC, rows[i].outdoor_c!, rows[i + 1].outdoor_c!);
  });
  return { result, minC: minC === Infinity ? null : minC, maxC: maxC === -Infinity ? null : maxC };
}

/** A band's complete response is identified from its own measured intervals.
 * It does not inherit gain, delay, exchange or solar terms from a general fit. */
export function fitIndependentRoomBand(rows: RoomMeanQuarter[], outdoor: (outdoorC: number) => boolean,
  ratedPowerW: number | null = null): { result: RoomMeanFitResult; minC: number | null; maxC: number | null } {
  const prepared = prepareIndependentRoomBand(rows, outdoor, ratedPowerW);
  const cells = Array.from({ length: ROOM_BAND_FIT_CELL_COUNT }, (_, i) => fitIndependentRoomBandCell(prepared, i));
  return finalizeIndependentRoomBand(prepared, cells);
}
