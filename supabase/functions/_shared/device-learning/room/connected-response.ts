import { beginConnectedProcessInference, advanceConnectedProcessInference, connectedProcessResponse, type ConnectedProcessProgress } from "./connected-process.ts";
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { connectedRoomObservedPeers, validateConnectedRoomResponseEvidence, type RoomResponseEvidence } from "./chronological-evidence.ts";
import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import { leastSquares } from "./mean-least-squares.ts";
import { filterConnectedRoomExchange, type ConnectedRoomBasis, type ConnectedRoomResponse, type ExchangePosterior } from "../../planner/models/room/connected-exchange.ts";
import type { DynamicThermalZoneModel } from "../../planner/models/room/thermal.ts";
import { ROOM_MEASURED_POLICY } from "../../planner/models/room/measured-evidence.ts";
import { HEATED_SAMPLE_MIN_W, MIN_HEATED_SAMPLES, MIN_TRAINING_SAMPLES } from "./regression.ts";

export interface ConnectedFitContext { peers: string[]; observedOnly: boolean; ratedPowerW: number | null; basis: ConnectedRoomBasis }
interface Evaluation {
  values: number[]; cursor: number; posterior: ExchangePosterior | null; identified: boolean;
  nll: number; error: number; observations: number; unavailable: number; observedHours: number; heatedHours: number;
}
interface Optimizer {
  values: number[]; score: number | null; evaluation: Evaluation; coordinate: number; direction: -1 | 1;
  steps: number[]; active: number[]; sweep: number; sweepScore: number | null;
  line: { origin: number[]; score: number; plus: number | null; minus: number | null; interpolated: boolean } | null;
  potential: number; bracketed: boolean;
}
export interface ConnectedFitProgress {
  version: 1; stage: "static" | "adaptive" | "validation_static" | "validation_adaptive" | "process_posterior" | "full" | "posterior" | "complete";
  configuredContext: ConnectedFitContext;
  trainingBasis: "chronological_prefix" | "full_capture";
  context: ConnectedFitContext; seed: Seed; optimizer: Optimizer;
  staticValues: number[] | null; adaptiveValues: number[] | null;
  validationStatic: number | null; validationAdaptive: number | null;
  selectedAdaptive: boolean; selectedWeather: boolean; candidateIndex: number;
  candidates: { values: number[]; score: number; validation: number | null }[]; result: ConnectedRoomFit | null;
  processPosterior?: ConnectedProcessProgress;
  unresolvedPeers: string[];
  unidentifiedHeater: boolean;
  unidentifiedPeerCombinations: string[][];
}
export interface ConnectedRoomFit {
  response: ConnectedRoomResponse | null; model: DynamicThermalZoneModel | null;
  issues: string[]; learning: Record<string, unknown>;
}
interface Seed { rates: number[]; gain: number; outdoor: number; background: number; solar: number; reference: number;
  noise: number; thermalNoise: number; solarPresent: boolean; medianHours: number; historyHours: number; observations: number }
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const end = (row: RoomMeanQuarter) => row.start_ms + (row.duration_s ?? 900) * 1000;

/** Active-set nonnegative least squares after projecting the unrestricted intercept.
 * The centered derivative regression supplies a starting point only; all fitted
 * coefficients are subsequently optimized through native interval-mean likelihood. */
function positiveRegression(matrix: number[][], target: number[]): number[] | null {
  if (!matrix.length) return null;
  const p = matrix[0].length, means = Array.from({ length: p }, (_, j) => matrix.reduce((s, row) => s + row[j], 0) / matrix.length);
  const average = target.reduce((a, b) => a + b, 0) / target.length;
  const x = matrix.map(row => row.map((v, j) => v - means[j])), y = target.map(v => v - average);
  const scales = means.map((_, j) => Math.hypot(...x.map(row => row[j])));
  if (scales.some(s => !(s > 0)) || !leastSquares(x, y)) return null;
  const a = x.map(row => row.map((v, j) => v / scales[j])), beta = Array<number>(p).fill(0), active = new Set<number>();
  const tolerance = Number.EPSILON * 256 * Math.max(1, Math.hypot(...y)) * matrix.length;
  for (let iteration = 0; iteration < p * p * 4; iteration++) {
    const residual = y.map((v, i) => v - a[i].reduce((s, z, j) => s + z * beta[j], 0));
    const gradient = beta.map((_, j) => active.has(j) ? -Infinity : a.reduce((s, row, i) => s + row[j] * residual[i], 0));
    const maximum = Math.max(...gradient);
    if (!(maximum > tolerance)) break;
    active.add(gradient.indexOf(maximum));
    for (;;) {
      const columns = [...active], fit = leastSquares(a.map(row => columns.map(j => row[j])), y);
      if (!fit) return null;
      const trial = Array<number>(p).fill(0); columns.forEach((j, i) => { trial[j] = fit[i]; });
      if (columns.every(j => trial[j] > 0)) { beta.splice(0, p, ...trial); break; }
      let alpha = 1;
      for (const j of columns) if (trial[j] <= 0) alpha = Math.min(alpha, beta[j] / (beta[j] - trial[j]));
      for (let j = 0; j < p; j++) beta[j] += alpha * (trial[j] - beta[j]);
      for (const j of columns) if (beta[j] <= tolerance) { beta[j] = 0; active.delete(j); }
      if (!active.size) break;
    }
  }
  const fitted = beta.map((v, j) => v / scales[j]);
  return [...fitted, average - fitted.reduce((s, v, j) => s + v * means[j], 0)];
}
function solarVaries(rows: readonly RoomMeanQuarter[]): boolean {
  let first: number | undefined;
  for (const row of rows) if (finite(row.solar_w_per_m2)) {
    if (first !== undefined && row.solar_w_per_m2 !== first) return true;
    first = row.solar_w_per_m2;
  }
  return false;
}
function seedFit(rows: readonly RoomMeanQuarter[], context: ConnectedFitContext): Seed | null {
  const eligible = rows.filter(row => finite(row.room_c) && finite(row.outdoor_c) &&
    (context.observedOnly || finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row)));
  const solarPresent = solarVaries(eligible);
  const matrix: number[][] = [], target: number[] = [], durations: number[] = [];
  let outdoorSum = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    if (end(a) !== b.start_ms || ![a, b].every(row => finite(row.room_c) && finite(row.outdoor_c) &&
      (context.observedOnly || finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row)) &&
      (!solarPresent || finite(row.solar_w_per_m2)) && context.peers.every(key => finite(row.peer_c?.[key])))) continue;
    const hours = ((a.duration_s ?? 900) + (b.duration_s ?? 900)) / 7200;
    matrix.push([(a.outdoor_c! - a.room_c! + b.outdoor_c! - b.room_c!) / 2,
      ...(!context.observedOnly ? [(a.heat_w! + b.heat_w!) / 2] : []),
      ...(solarPresent ? [(a.solar_w_per_m2! + b.solar_w_per_m2!) / 2] : []),
      ...context.peers.map(key => (a.peer_c![key]! - a.room_c! + b.peer_c![key]! - b.room_c!) / 2)]);
    target.push((b.room_c! - a.room_c!) / hours); durations.push(hours); outdoorSum += a.outdoor_c!;
  }
  const fit = positiveRegression(matrix, target);
  if (!fit || target.length <= fit.length) return null;
  let at = 0;
  const outdoor = fit[at++], gain = context.observedOnly ? 0 : fit[at++], solar = solarPresent ? fit[at++] : 0;
  if (!context.observedOnly && !(gain > 0)) return null;
  const rates = context.peers.map(() => fit[at++]), background = fit[at];
  const residual = target.reduce((sum, y, i) => sum + (y - background - matrix[i].reduce((s, x, j) => s + x * fit[j], 0)) ** 2, 0) / (target.length - fit.length);
  durations.sort((a, b) => a - b);
  const medianHours = durations[Math.floor(durations.length / 2)], scale = Math.max(residual,
    Number.EPSILON ** 2 * Math.max(1, ...eligible.map(row => Math.abs(row.room_c!))) ** 2);
  return { rates, outdoor, gain, background, solar, reference: outdoorSum / target.length,
    noise: scale * medianHours ** 3 / 2, thermalNoise: scale * medianHours / 2,
    solarPresent, medianHours, historyHours: (end(rows.at(-1)!) - rows[0].start_ms) / 3_600_000, observations: target.length };
}
/** Squared coordinates include exact zero at physical boundaries. Noise is strictly positive. */
function valuesFrom(seed: Seed, context: ConnectedFitContext, adaptive: boolean): number[] {
  const rates = seed.rates.map(Math.sqrt);
  return [Math.sqrt(seed.outdoor), ...(!context.observedOnly ? [Math.log(seed.gain), 0, 0] : []),
    ...(seed.solarPresent ? [Math.sqrt(seed.solar)] : []), seed.background, Math.log(seed.noise), Math.log(seed.thermalNoise), ...rates,
    ...(adaptive ? seed.rates.flatMap(() => [Math.log(1 / Math.sqrt(seed.medianHours * seed.historyHours)), Math.log(1)]) : [])];
}
function modelFrom(values: readonly number[], seed: Seed, context: ConnectedFitContext, adaptive: boolean): ConnectedRoomResponse | null {
  let at = 0;
  const outdoor = values[at++] ** 2;
  const heater = context.observedOnly ? null : { gain_c_per_wh: Math.exp(values[at++]), lag_h: values[at++] ** 2,
    gain_outdoor_slope_per_c: values[at++], gain_reference_outdoor_c: seed.reference };
  const solar = seed.solarPresent ? values[at++] ** 2 : 0;
  const background = values[at++], noise = Math.exp(values[at++]), thermalNoise = Math.exp(values[at++]);
  const rates = context.peers.map(() => values[at++] ** 2);
  const incoming = context.peers.map((from, j) => {
    if (!adaptive) return { kind: "constant" as const, from, per_h: rates[j] };
    const reversion_per_h = Math.exp(values[at++]), stationary_variance = Math.exp(values[at++]);
    return rates[j] === 0 ? { kind: "constant" as const, from, per_h: 0 } :
      { kind: "log_ou" as const, from, mean_log_per_h: Math.log(rates[j]), reversion_per_h, stationary_variance };
  });
  if (![outdoor, solar, background, noise, thermalNoise, ...(heater ? Object.values(heater) : []), ...rates].every(finite) || !(noise > 0) ||
    incoming.some(e => e.kind === "log_ou" && ![e.reversion_per_h, e.stationary_variance, e.mean_log_per_h].every(finite))) return null;
  const logs = incoming.flatMap(e => e.kind === "log_ou" ? [e.mean_log_per_h] : []), n = logs.length + 2;
  return { family: "adaptive_connected_native_v1", thermal: { outdoor_per_h: outdoor, heater,
    solar_per_wm2_h: solar, background_per_h: background }, incoming, observation_noise_c2_h: noise,
    thermal_noise_c2_per_h: thermalNoise, reference_state: { through_ms: Date.parse(context.basis.history_from),
      temperature_c: 0, stored_heat_c: 0, log_rates: logs, covariance: Array.from({ length: n }, () => Array<number>(n).fill(0)), observations: 0 },
    basis: context.basis, evidence: {} };
}
const evaluation = (values: number[]): Evaluation => ({ values, cursor: 0, posterior: null, identified: false,
  nll: 0, error: 0, observations: 0, unavailable: 0, observedHours: 0, heatedHours: 0 });
function optimizer(values: number[], seed: Seed, context: ConnectedFitContext): Optimizer {
  const steps = values.map(v => Math.max(Math.abs(v) * .25, .1));
  // Positive-log noise/process coordinates and dimensionless weather slope have distinct units.
  let at = 1;
  if (!context.observedOnly) { steps[at++] = 1; steps[at++] = .5; steps[at++] = .01; }
  if (seed.solarPresent) steps[at++] = Math.max(Math.sqrt(seed.solar) / 2, .001);
  steps[at++] = Math.max(Math.abs(seed.background) / 2, Math.sqrt(seed.thermalNoise));
  steps[at++] = steps[at++] = 1;
  return { values, score: null, evaluation: evaluation(values), coordinate: 0, direction: 1, steps,
    active: values.map((_, i) => i).filter(i => context.observedOnly || i !== 3), sweep: 0, sweepScore: null, line: null, potential: 0, bracketed: true };
}
const emptyFit = (reason: string): ConnectedRoomFit => ({ response: null, model: null, issues: [reason], learning: {
  method: "adaptive_connected_native_v1", identification: reason } });
function identifyStructure(rows: readonly RoomMeanQuarter[], configured: ConnectedFitContext) {
  let context = configured;
  const observedPeers = connectedRoomObservedPeers(rows, context.peers);
  const unresolvedPeers = context.peers.filter(key => !observedPeers.includes(key));
  const unidentifiedPeerCombinations: string[][] = [], redundant = new Set<string>();
  const sameCenteredBoundary = (a: string, b: string | null) => {
    const differences = rows.flatMap(row => {
      const x = row.peer_c?.[a], y = b === null ? row.outdoor_c : row.peer_c?.[b];
      return finite(row.room_c) && finite(x) && finite(y) ? [x - y] : [];
    });
    if (differences.length < 2) return false;
    const average = differences.reduce((sum, x) => sum + x, 0) / differences.length;
    return differences.every(x => Math.abs(x - average) <= Number.EPSILON * 256 * Math.max(1, Math.abs(x), Math.abs(average)));
  };
  for (let i = 0; i < observedPeers.length; i++) {
    const key = observedPeers[i];
    const contrast = rows.flatMap(row => finite(row.room_c) && finite(row.peer_c?.[key]) ? [row.peer_c![key]! - row.room_c] : []);
    if (contrast.length > 1 && contrast.every(x => Math.abs(x - contrast[0]) <= Number.EPSILON * 256 * Math.max(1, Math.abs(x), Math.abs(contrast[0])))) {
      redundant.add(key); unidentifiedPeerCombinations.push([key, "background"]);
    }
    if (sameCenteredBoundary(key, null)) { redundant.add(key); unidentifiedPeerCombinations.push([key, "outdoor"]); }
    for (let j = i + 1; j < observedPeers.length; j++) if (sameCenteredBoundary(key, observedPeers[j])) {
      // A sum is identifiable, individual directed coefficients are not.
      // Do not choose a named room arbitrarily as the owner of that sum.
      redundant.add(key); redundant.add(observedPeers[j]); unidentifiedPeerCombinations.push([key, observedPeers[j]]);
    }
  }
  context = { ...context, peers: observedPeers.filter(key => !redundant.has(key)) };
  let seed = seedFit(rows, context), unidentifiedHeater = false;
  if (!seed && !context.observedOnly) {
    const passive = rows.map(row => finite(row.heat_w) && row.heat_w === 0 && roomHeatingDirectionKnown(row)
      ? row : { ...row, outdoor_c: null });
    const fitted = seedFit(passive, { ...context, observedOnly: true });
    if (fitted) { seed = fitted; context = { ...context, observedOnly: true }; unidentifiedHeater = true; }
  }
  return { context, seed, unresolvedPeers, unidentifiedHeater, unidentifiedPeerCombinations };
}
export function beginConnectedRoomFit(evidence: RoomResponseEvidence, configuredContext: ConnectedFitContext): ConnectedFitProgress {
  validateConnectedRoomResponseEvidence(evidence, configuredContext);
  let structure = identifyStructure(evidence.trainingRows, configuredContext);
  let trainingBasis: ConnectedFitProgress["trainingBasis"] = evidence.trainingRows.length === evidence.fullRows.length
    ? "full_capture" : "chronological_prefix";
  if (trainingBasis === "chronological_prefix" && (!structure.seed || structure.unidentifiedHeater ||
    structure.unresolvedPeers.length || structure.unidentifiedPeerCombinations.length ||
    !structure.seed.solarPresent && solarVaries(evidence.fullRows))) {
    const full = identifyStructure(evidence.fullRows, configuredContext);
    if (full.seed && (!structure.seed || structure.unidentifiedHeater && !full.unidentifiedHeater ||
      !structure.seed.solarPresent && full.seed.solarPresent ||
      full.context.peers.some(key => !structure.context.peers.includes(key)))) {
      // A training prefix can predate the first informative heater operation or
      // peer contrast or varying solar input. Identify that newly observed shape from the full causal
      // basis, without claiming its already-used tail as independent validation.
      structure = full; trainingBasis = "full_capture";
    }
  }
  const { context, seed, unresolvedPeers, unidentifiedHeater, unidentifiedPeerCombinations } = structure;
  const unavailable: Seed = { rates: context.peers.map(() => 0), outdoor: 0, gain: 0, background: 0, solar: 0,
    reference: 0, noise: 1, thermalNoise: 1, solarPresent: false, medianHours: .25, historyHours: 1, observations: 0 };
  const effective = seed ?? unavailable, values = seed ? valuesFrom(seed, context, false) : [];
  return { version: 1, stage: seed ? "static" : "complete", configuredContext, trainingBasis, context, seed: effective,
    optimizer: optimizer(values, effective, context), staticValues: null, adaptiveValues: null,
    validationStatic: null, validationAdaptive: null, selectedAdaptive: false, selectedWeather: false, candidateIndex: 0, candidates: [], result: seed ? null : emptyFit("unidentified_connected_response"),
    unresolvedPeers, unidentifiedHeater, unidentifiedPeerCombinations };
}

function variancePenalty(state: ConnectedFitProgress, values: readonly number[]): number {
  const model = modelFrom(values, state.seed, state.context, state.stage === "adaptive" || state.selectedAdaptive);
  if (!model) return Number.MAX_VALUE;
  // Proper scaled-inverse-chi-square priors, nu=1. The scale is measured once
  // from this partition's seed and stays fixed for every competing trial.
  return [[model.observation_noise_c2_h, state.seed.noise], [model.thermal_noise_c2_per_h, state.seed.thermalNoise]]
    .reduce((sum, [variance, reference]) => sum + .5 * (3 * Math.log(variance / reference) + reference / variance), 0);
}

function nextTrial(state: ConnectedFitProgress): boolean {
  const o = state.optimizer, rawScore = o.evaluation.observations > o.values.length
    ? o.evaluation.nll + variancePenalty(state, o.evaluation.values) : Number.MAX_VALUE;
  const score = Number.isFinite(rawScore) ? rawScore : Number.MAX_VALUE;
  if (o.score === null || score < o.score) { o.values = o.evaluation.values; o.score = score; }
  if (o.sweepScore === null) o.sweepScore = o.score;
  const coordinate = o.active[o.coordinate], step = o.steps[coordinate];
  if (o.line) {
    const line = o.line;
    if (line.plus === null) {
      line.plus = score;
      const trial = [...line.origin]; trial[coordinate] -= step;
      o.evaluation = evaluation(trial); return true;
    }
    if (line.minus === null) {
      line.minus = score;
      const curvature = line.plus + line.minus - 2 * line.score;
      if (curvature > 0 && Number.isFinite(curvature)) {
        const displacement = .5 * step * (line.minus - line.plus) / curvature;
        o.potential = Math.max(o.potential, (line.minus - line.plus) ** 2 / (8 * curvature));
        if (Math.abs(displacement) < step && Math.abs(displacement) > Number.EPSILON * Math.max(1, Math.abs(line.origin[coordinate]))) {
          const trial = [...line.origin]; trial[coordinate] += displacement;
          line.interpolated = true; o.evaluation = evaluation(trial); return true;
        }
      } else if (Math.min(line.plus, line.minus) < line.score) o.bracketed = false;
    }
    const atBoundary = Math.abs(o.values[coordinate] - line.origin[coordinate]) >= step * (1 - Number.EPSILON * 8);
    if (atBoundary) { o.steps[coordinate] *= 2; o.bracketed = false; }
    else o.steps[coordinate] /= 2;
    o.coordinate++; o.line = null;
  }
  if (o.coordinate >= o.active.length) {
    o.coordinate = 0; o.sweep++;
    const improvement = (o.sweepScore ?? Infinity) - (o.score ?? Infinity);
    const tolerance = 1e-6 * Math.max(1, Math.abs(o.score ?? 0));
    const converged = o.bracketed && improvement <= tolerance && o.potential <= tolerance;
    o.sweepScore = o.score;
    o.potential = 0; o.bracketed = true;
    if (!o.active.length || converged || Math.max(...o.active.map(i => o.steps[i])) < 1e-6 || o.sweep >= 40) return false;
  }
  o.line = { origin: [...o.values], score: o.score, plus: null, minus: null, interpolated: false };
  const trial = [...o.values], nextCoordinate = o.active[o.coordinate]; trial[nextCoordinate] += o.steps[nextCoordinate];
  o.evaluation = evaluation(trial);
  return true;
}
function finalFit(state: ConnectedFitProgress): ConnectedRoomFit {
  const e = state.optimizer.evaluation, response = modelFrom(state.optimizer.values, state.seed, state.context, state.selectedAdaptive);
  if (!response || !e.posterior || e.observations <= state.optimizer.values.length) return emptyFit("unidentified_connected_response");
  response.reference_state = e.posterior;
  response.evidence = { method: "native_mean_cubature_likelihood_v1", observation: "interval_mean", selection: state.candidates.some(candidate => candidate.validation !== null) ? "chronological_predictive_likelihood" : "penalized_full_likelihood_without_validation",
    fitted_observations: e.observations, residual_degrees_of_freedom: e.observations - state.optimizer.values.length,
    validation_static_nll: state.validationStatic, validation_adaptive_nll: state.validationAdaptive,
    validation_weather_static_nll: state.candidates[2]?.validation ?? null,
    validation_weather_adaptive_nll: state.candidates[3]?.validation ?? null,
    validation_available: state.candidates.some(candidate => candidate.validation !== null),
    training_basis: state.trainingBasis, observed_only: state.configuredContext.observedOnly,
    heater_weather_response_selected: state.selectedWeather,
    conditional_only: true, unavailable_intervals: e.unavailable, optimization_sweeps: state.optimizer.sweep,
    thermal_state_identified: e.identified,
    unresolved_peer_sources: state.unresolvedPeers,
    unidentified_heater: state.unidentifiedHeater,
    unidentified_peer_combinations: state.unidentifiedPeerCombinations,
    variance_regularization: { family: "scaled_inverse_chi_squared", degrees_of_freedom: 1,
      observation_reference_c2_h: state.seed.noise, thermal_reference_c2_per_h: state.seed.thermalNoise },
    heater_identified: response.thermal.heater !== null && e.observedHours >= MIN_TRAINING_SAMPLES / 4 && e.heatedHours >= MIN_HEATED_SAMPLES / 4,
    observed_hours: e.observedHours, measured_heated_hours: e.heatedHours };
  const h = response.thermal.heater, total = response.thermal.outdoor_per_h + response.incoming.reduce((sum, edge) => sum +
    (edge.kind === "constant" ? edge.per_h : Math.exp(edge.mean_log_per_h)), 0);
  const model: DynamicThermalZoneModel | null = h ? { response_family: total > 0 ? "finite" : "integrator", gain_c_per_wh: h.gain_c_per_wh,
    heat_lag_h: h.lag_h, gain_reference_outdoor_c: h.gain_reference_outdoor_c, gain_outdoor_slope_per_c: h.gain_outdoor_slope_per_c,
    cooling_constant_per_h: response.thermal.outdoor_per_h, house_coupling_per_h: 0,
    background_gain_c_per_h: response.thermal.background_per_h, solar_gain_c_per_h_per_wm2: response.thermal.solar_per_wm2_h,
    // Electrical response does not identify delivered heat, COP or heat capacity.
    thermal_capacity_wh_per_c: null, heat_loss_w_per_c: null,
    time_constant_h: total > 0 ? 1 / total : null, heating_rate_c_per_h: state.context.ratedPowerW === null ? null : h.gain_c_per_wh * state.context.ratedPowerW,
    sample_count: e.observations, residual_std_c: Math.sqrt(e.error / e.observations), r2: 0, prediction_error_c: null } : null;
  return { response, model, issues: [], learning: { ...response.evidence,
    measured_runs: { policy: ROOM_MEASURED_POLICY, fitted_observations: e.observations,
      residual_degrees_of_freedom: e.observations - state.optimizer.values.length } } };
}

/** Every row and optimizer trial is resumable; no 400-day pass is an atomic cell. */
export function advanceConnectedRoomFit(evidence: RoomResponseEvidence, previous: ConnectedFitProgress, milliseconds = 650): ConnectedFitProgress {
  const state = structuredClone(previous), started = performance.now();
  while (state.stage !== "complete" && performance.now() - started < milliseconds) {
    if (state.stage === "process_posterior") {
      const rows = evidence.fullRows, through = end(rows.at(-1)!);
      state.processPosterior ??= beginConnectedProcessInference(state.result!.response!, rows);
      state.processPosterior = advanceConnectedProcessInference(rows, state.processPosterior, through, Math.max(1, milliseconds - (performance.now() - started)));
      if (state.processPosterior.complete) {
        state.result!.response = connectedProcessResponse(state.processPosterior);
        state.result!.learning = { ...state.result!.learning, process_inference: state.result!.response.evidence.process_inference };
        delete state.processPosterior; state.stage = "complete";
      }
      continue;
    }
    const validating = state.stage.startsWith("validation"), full = state.stage === "full" || state.stage === "posterior";
    const adaptive = state.stage === "adaptive" || state.stage === "validation_adaptive" || full && state.selectedAdaptive;
    const trainingRows = state.trainingBasis === "full_capture" ? evidence.fullRows : evidence.trainingRows;
    const rows = full ? evidence.fullRows : validating ? [...trainingRows, ...evidence.fullRows.slice(trainingRows.length)] : trainingRows;
    const e = state.optimizer.evaluation, response = modelFrom(e.values, state.seed, state.context, adaptive);
    if (response && e.cursor < rows.length) {
      // Only the final forward pass needs per-observation durations. Use the
      // filter's accepted observation directly, including reinitializations.
      const posterior = state.stage === "posterior";
      const next = Math.min(rows.length, e.cursor + (posterior ? 1 : 128), validating && e.cursor < trainingRows.length ? trainingRows.length : rows.length);
      // Every competing shape is scored on the same conditional observation
      // population, including when an edge or solar coefficient meets zero.
      const chunk = rows.slice(e.cursor, next).map(row => state.context.peers.some(key => !finite(row.peer_c?.[key])) ||
        state.seed.solarPresent && !finite(row.solar_w_per_m2) || state.unidentifiedHeater &&
        (!finite(row.heat_w) || row.heat_w !== 0 || !roomHeatingDirectionKnown(row)) ? { ...row, inference_available: false } : row);
      if (state.unidentifiedHeater) response.evidence = { ...response.evidence, unidentified_heater: true };
      const result = filterConnectedRoomExchange(response, chunk, end(chunk.at(-1)!), e.posterior?.observations ? e.posterior : undefined, e.identified);
      e.posterior = result.posterior; e.identified = result.diagnostics.thermal_state_identified;
      if (!validating || e.cursor >= trainingRows.length) {
        e.nll += result.diagnostics.negative_log_likelihood; e.error += result.diagnostics.squared_error_c2;
        if (result.diagnostics.numerical_failures) e.nll = Number.MAX_VALUE;
        if (!Number.isFinite(e.nll)) e.nll = Number.MAX_VALUE;
        if (!Number.isFinite(e.error)) { e.error = Number.MAX_VALUE; e.nll = Number.MAX_VALUE; }
        e.observations += result.diagnostics.observed_intervals; e.unavailable += result.diagnostics.unavailable_intervals;
        if (posterior && result.diagnostics.observed_intervals === 1) {
          const row = chunk[0];
          const hours = (row.duration_s ?? 900) / 3600;
          e.observedHours += hours;
          if (finite(row.heat_w) && row.heat_w > HEATED_SAMPLE_MIN_W && roomHeatingDirectionKnown(row)) e.heatedHours += hours;
        }
      }
      e.cursor = next; continue;
    }
    if (!response) { e.cursor = rows.length; e.nll = Number.MAX_VALUE; }
    if (!validating && state.stage !== "posterior" && nextTrial(state)) continue;
    if (state.stage === "static" || state.stage === "adaptive") {
      const values = [...state.optimizer.values];
      state.candidates.push({ values, score: state.optimizer.score ?? Number.MAX_VALUE, validation: null });
      if (state.candidateIndex === 0) state.staticValues = values;
      if (state.candidateIndex === 1) state.adaptiveValues = values;
      state.candidateIndex++;
      const count = state.context.observedOnly ? 2 : 4;
      if (state.candidateIndex < count) {
        const isAdaptive = state.candidateIndex % 2 === 1;
        state.stage = isAdaptive ? "adaptive" : "static";
        const next = isAdaptive ? [...state.candidates[state.candidateIndex - 1].values,
          ...state.context.peers.flatMap(() => [Math.log(1 / Math.sqrt(state.seed.medianHours * state.seed.historyHours)), 0])]
          : [...state.staticValues!];
        state.optimizer = optimizer(next, state.seed, state.context);
        if (state.candidateIndex >= 2) state.optimizer.active = next.map((_, i) => i);
      } else {
        state.candidateIndex = 0; state.stage = "validation_static";
        state.optimizer = optimizer(state.candidates[0].values, state.seed, state.context);
      }
    } else if (validating) {
      state.candidates[state.candidateIndex].validation = e.observations > 0 ? e.nll / e.observations : null;
      state.candidateIndex++;
      if (state.candidateIndex < state.candidates.length) {
        state.stage = state.candidateIndex % 2 ? "validation_adaptive" : "validation_static";
        state.optimizer = optimizer(state.candidates[state.candidateIndex].values, state.seed, state.context);
      } else {
        state.validationStatic = state.candidates[0].validation;
        state.validationAdaptive = state.candidates[1].validation;
        const hasValidation = state.candidates.some(candidate => candidate.validation !== null);
        const scores = state.candidates.map((candidate, i) => hasValidation ? candidate.validation ?? Number.MAX_VALUE :
          candidate.score + candidate.values.length - (!state.context.observedOnly && i < 2 ? 1 : 0));
        const winner = scores.indexOf(Math.min(...scores));
        state.selectedAdaptive = winner % 2 === 1; state.selectedWeather = winner >= 2;
        state.stage = "full"; state.optimizer = optimizer(state.candidates[winner].values, state.seed, state.context);
        if (state.selectedWeather) state.optimizer.active = state.optimizer.values.map((_, i) => i);
      }
    } else if (state.stage === "full") {
      // Re-evaluate the selected optimum once to publish its exact forward posterior.
      state.stage = "posterior"; state.optimizer.evaluation = evaluation(state.optimizer.values);
    } else {
      state.result = finalFit(state); state.stage = state.result.response ? "process_posterior" : "complete";
    }
  }
  return state;
}

export function parseConnectedFitProgress(value: unknown): ConnectedFitProgress | null {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("stage" in value) ||
    !["static", "adaptive", "validation_static", "validation_adaptive", "process_posterior", "full", "posterior", "complete"].includes(String(value.stage))) return null;
  const p = value as ConnectedFitProgress;
  if (!p.configuredContext || typeof p.configuredContext.observedOnly !== "boolean" || !Array.isArray(p.configuredContext.peers) ||
    !p.configuredContext.peers.every(k => typeof k === "string") || !["chronological_prefix", "full_capture"].includes(p.trainingBasis) ||
    !Array.isArray(p.candidates) || !Number.isSafeInteger(p.candidateIndex) || p.candidateIndex < 0 || p.candidateIndex > 4 ||
    typeof p.selectedAdaptive !== "boolean" || typeof p.selectedWeather !== "boolean" || !p.context || !Array.isArray(p.context.peers) || !p.context.peers.every(k => typeof k === "string") || !p.seed || !p.optimizer ||
    !Array.isArray(p.optimizer.values) || !p.optimizer.values.every(finite) || !Array.isArray(p.optimizer.steps) ||
    !p.optimizer.steps.every(v => finite(v) && v >= 0) || !p.optimizer.evaluation || !Number.isSafeInteger(p.optimizer.evaluation.cursor) || p.optimizer.evaluation.cursor < 0) return null;
  return p;
}
