/**
 * Learn from recorder interval means, not fictitious boundary temperatures.
 * The observation operator integrates the continuous room/delivered-heat ODE.
 * Selection measures chronological held-out temperature transitions; the
 * twelve-hour forecast remains a diagnostic, not an actuator-response oracle.
 */
import { solveLinearSystem } from "../linear-algebra.ts";
import { HEAT_LAG_GRID_H, MAX_PREDICTION_ERROR_C } from "./fit.ts";
import { HEATED_SAMPLE_MIN_W, MIN_HEATED_SAMPLES, MIN_SOLAR_COVERAGE, MIN_TRAINING_SAMPLES,
  type ThermalFitRejection, type ThermalFitResult } from "./regression.ts";
import { SLOT_HOURS as H, type ThermalZoneModel } from "../../planner/models/room/thermal.ts";

export interface RoomMeanQuarter {
  start_ms: number;
  room_c: number | null;
  outdoor_c: number | null;
  house_c: number | null;
  solar_w_per_m2: number | null;
  /** Measured mean electrical input; null means unobserved, never OFF. */
  heat_w: number | null;
  cooling: boolean;
}
export const ROOM_MEAN_LEARNING_METHOD = "interval_mean_transition_holdout_v1" as const;
export interface RoomLearningEvidence {
  method: typeof ROOM_MEAN_LEARNING_METHOD;
  observation: "quarter_mean";
  selection: "chronological_transition_mse";
  training_pairs: number;
  validation_pairs: number;
  validation_mse_c2: number | null;
  selected_boundary: "house" | "outdoor" | null;
  selected_lag_h: number | null;
}
export type RoomMeanFitResult = ThermalFitResult & { learning_evidence?: RoomLearningEvidence };
type Boundary = "house" | "outdoor";
const finite = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v);

/** Exact endpoint and interval-mean coefficients of T'=-kT+gD+F, D'=(P-D)/lag. */
function observation(k: number, lag: number) {
  const a = Math.exp(-k * H), effect = -Math.expm1(-k * H) / k;
  const E = effect / H;
  // Series avoids cancellation as k tends to zero; this is numerical accuracy,
  // not a bound on admissible thermal parameters.
  const V = Math.abs(k * H) < 1e-4
    ? H * (0.5 - k * H / 6 + (k * H) ** 2 / 24 - (k * H) ** 3 / 120)
    : (1 - E) / k;
  if (lag === 0) return { a, effect, E, V, C: 0, B: 0, U: 0 };
  const r = 1 / lag, C = Math.exp(-r * H);
  const equal = Math.abs((k - r) * H) < 1e-7;
  const B = equal ? H * a : (C - a) / (k - r);
  const U = equal ? (1 - a * (1 + k * H)) / (H * k * k)
    : (lag * -Math.expm1(-r * H) - effect) / (H * (k - r));
  return { a, effect, E, V, C, B, U };
}
interface Term { index: number; segment: number; x: number[]; z: number; y: number; delivered: number }
interface Design { terms: Term[]; op: ReturnType<typeof observation> }
interface Fit { k: number; lag: number; boundary: Boundary; solar: boolean; beta: number[];
  initial: Map<number, number>; mse: number; n: number; design: Design }
const boundaryValue = (row: RoomMeanQuarter, boundary: Boundary) => boundary === "house" ? row.house_c : row.outdoor_c;

function design(rows: RoomMeanQuarter[], k: number, lag: number, boundary: Boundary, solar: boolean): Design {
  const op = observation(k, lag), { a, effect, E, V, C, B, U } = op;
  const L = E * effect - a * V;
  const deliveredCoefficient = E * B - a * U + U * C;
  let delivered = 0, initialShare = 1, segment = 0;
  const terms: Term[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const q = rows[i], next = rows[i + 1];
    const powerKnown = finite(q.heat_w) && q.heat_w >= 0;
    const contiguous = next.start_ms - q.start_ms === 900_000;
    if (powerKnown && contiguous && finite(next.heat_w) && next.heat_w >= 0 &&
      finite(q.room_c) && finite(next.room_c) && !q.cooling && !next.cooling &&
      finite(boundaryValue(q, boundary)) && finite(boundaryValue(next, boundary)) &&
      (!solar || (finite(q.solar_w_per_m2) && finite(next.solar_w_per_m2)))) {
      const heat = deliveredCoefficient * delivered +
        (E * (effect - B) - a * (V - U) + U * (1 - C)) * q.heat_w! + (V - U) * next.heat_w!;
      terms.push({ index: i, segment, delivered, z: deliveredCoefficient * initialShare,
        x: [heat, effect, ...(solar ? [L * q.solar_w_per_m2! + V * next.solar_w_per_m2!] : [])],
        y: next.room_c! - a * q.room_c! - k * (L * boundaryValue(q, boundary)! + V * boundaryValue(next, boundary)!) });
    }
    if (!powerKnown || !contiguous || q.cooling) {
      // Unknown heat breaks memory. Estimate a new segment's initial delayed
      // heat as a nuisance coefficient; do not fabricate zero heat through it.
      delivered = 0; initialShare = 1; segment++;
    } else {
      delivered = C * delivered + (1 - C) * q.heat_w!;
      initialShare *= C;
    }
  }
  return { terms, op };
}

function estimate(rows: RoomMeanQuarter[], k: number, lag: number, boundary: Boundary, solar: boolean): Fit | null {
  const d = design(rows, k, lag, boundary, solar), size = solar ? 3 : 2;
  const xx = Array.from({ length: size }, () => Array<number>(size).fill(0)), xy = Array<number>(size).fill(0);
  const nuisance = new Map<number, { xx: number; xy: number; cross: number[] }>();
  for (const t of d.terms) {
    for (let j = 0; j < size; j++) {
      xy[j] += t.x[j] * t.y;
      for (let z = 0; z < size; z++) xx[j][z] += t.x[j] * t.x[z];
    }
    if (t.z !== 0) {
      const n = nuisance.get(t.segment) ?? { xx: 0, xy: 0, cross: Array<number>(size).fill(0) };
      n.xx += t.z * t.z; n.xy += t.z * t.y;
      for (let j = 0; j < size; j++) n.cross[j] += t.z * t.x[j];
      nuisance.set(t.segment, n);
    }
  }
  // Eliminate independent initial-state nuisance columns without a large dense
  // matrix when observation gaps split the window into many segments.
  for (const n of nuisance.values()) if (n.xx > 0) {
    for (let j = 0; j < size; j++) {
      xy[j] -= n.cross[j] * n.xy / n.xx;
      for (let z = 0; z < size; z++) xx[j][z] -= n.cross[j] * n.cross[z] / n.xx;
    }
  }
  const beta = solveLinearSystem(xx, xy);
  if (!beta || !beta.every(Number.isFinite) || !(beta[0] > 0) || (solar && beta[2] < 0)) return null;
  const initial = new Map<number, number>();
  for (const [segment, n] of nuisance) initial.set(segment,
    (n.xy - n.cross.reduce((sum, v, j) => sum + v * beta[j], 0)) / n.xx);
  let residual = 0;
  for (const t of d.terms) residual += (t.y - t.x.reduce((sum, v, j) => sum + v * beta[j], 0) - t.z * (initial.get(t.segment) ?? 0)) ** 2;
  if (!d.terms.length || !Number.isFinite(residual)) return null;
  return { k, lag, boundary, solar, beta, initial, mse: residual / d.terms.length, n: d.terms.length, design: d };
}

/** Expand a numerical bracket; no imposed lower/upper physical coupling. */
function fitCandidate(rows: RoomMeanQuarter[], lag: number, boundary: Boundary, solar: boolean): Fit | null {
  const at = (logK: number) => {
    const k = Math.exp(logK);
    return k > 0 && Number.isFinite(k) ? estimate(rows, k, lag, boundary, solar) : null;
  };
  let center = 0, best = at(center);
  // Discover a physical least-squares solution before minimising its residual.
  if (!best) for (let step = 1; step < 32 && !best; step++) {
    for (const position of [-step, step]) { const candidate = at(position); if (candidate) { center = position; best = candidate; break; } }
  }
  if (!best) return null;
  let lo = center - 1, hi = center + 1;
  for (let expansion = 0; expansion < 64; expansion++) {
    const left = at(lo), right = at(hi);
    if (left && left.mse < best.mse && (!right || left.mse <= right.mse)) {
      best = left; hi = center; center = lo; lo--;
    } else if (right && right.mse < best.mse) {
      best = right; lo = center; center = hi; hi++;
    } else break;
  }
  for (let iteration = 0; iteration < 32; iteration++) {
    const l = lo + (hi - lo) / 3, r = hi - (hi - lo) / 3, left = at(l), right = at(r);
    if (left && left.mse < best.mse) best = left;
    if (right && right.mse < best.mse) best = right;
    if ((left?.mse ?? Infinity) < (right?.mse ?? Infinity)) hi = r; else lo = l;
  }
  return best;
}

function heldOut(fit: Fit, rows: RoomMeanQuarter[], split: number, comparable: Set<number>) {
  const d = design(rows, fit.k, fit.lag, fit.boundary, fit.solar), initial = new Map(fit.initial);
  let total = 0, count = 0;
  for (const t of d.terms) {
    if (t.index < split - 1) continue;
    const residual = t.y - t.x.reduce((sum, v, j) => sum + v * fit.beta[j], 0);
    if (t.z !== 0 && !initial.has(t.segment)) {
      // The first transition after a newly unobserved heat state identifies
      // that state; it cannot also validate its own prediction.
      initial.set(t.segment, residual / t.z); continue;
    }
    if (!comparable.has(t.index)) continue;
    total += (residual - t.z * (initial.get(t.segment) ?? 0)) ** 2; count++;
  }
  return { mse: count ? total / count : null, count };
}

function forecastError(fit: Fit, rows: RoomMeanQuarter[]): number | null {
  const { a, effect, E, V, C, B, U } = fit.design.op;
  const terms = new Map(fit.design.terms.map(t => [t.index, t]));
  let sum = 0, count = 0;
  for (const term of fit.design.terms) {
    const i = term.index;
    if (i % 8 !== 0 || i + 48 >= rows.length) continue;
    let complete = true;
    for (let j = i; j <= i + 48; j++) if (!terms.has(j) || terms.get(j)!.segment !== term.segment) { complete = false; break; }
    if (!complete) continue;
    const q = rows[i], next = rows[i + 48];
    const heatCoefficient = E * B - a * U + U * C;
    const D = term.delivered + (heatCoefficient !== 0 ? term.z / heatCoefficient * (fit.initial.get(term.segment) ?? 0) / fit.beta[0] : 0);
    const forcing = (r: RoomMeanQuarter) => fit.k * boundaryValue(r, fit.boundary)! + fit.beta[1] + (fit.solar ? fit.beta[2] * r.solar_w_per_m2! : 0);
    let delivered = D, temperature = (q.room_c! - fit.beta[0] * (U * D + (V - U) * q.heat_w!) - V * forcing(q)) / E;
    for (let j = i; j < i + 48; j++) {
      const r = rows[j];
      temperature = a * temperature + fit.beta[0] * (B * delivered + (effect - B) * r.heat_w!) + effect * forcing(r);
      delivered = C * delivered + (1 - C) * r.heat_w!;
    }
    const predicted = E * temperature + fit.beta[0] * (U * delivered + (V - U) * next.heat_w!) + V * forcing(next);
    sum += Math.abs(predicted - next.room_c!); count++;
  }
  return count ? sum / count : null;
}

export function fitRoomMeans(quarters: RoomMeanQuarter[], ratedPowerW: number | null = null): RoomMeanFitResult {
  const rows = [...quarters].sort((a, b) => a.start_ms - b.start_ms);
  const usable = rows.filter(r => finite(r.room_c) && finite(r.heat_w) && !r.cooling);
  const withHouse = usable.filter(r => finite(r.house_c));
  const boundaries: Boundary[] = ["outdoor"];
  if (withHouse.length >= MIN_TRAINING_SAMPLES && withHouse.length >= usable.length * MIN_SOLAR_COVERAGE) boundaries.push("house");
  const split = Math.floor(rows.length * 2 / 3);
  const configurations = boundaries.flatMap(boundary => {
    const covered = usable.filter(r => finite(boundaryValue(r, boundary)));
    const withSun = covered.filter(r => finite(r.solar_w_per_m2));
    const solar = withSun.length >= MIN_TRAINING_SAMPLES && withSun.length >= covered.length * MIN_SOLAR_COVERAGE;
    return (boundary === "house" ? HEAT_LAG_GRID_H : [0]).flatMap(lag =>
      (solar ? [true, false] : [false]).map(sun => ({ boundary, lag, solar: sun })));
  });
  const candidates = configurations.map(c => ({ config: c,
    training: fitCandidate(rows.slice(0, split), c.lag, c.boundary, c.solar),
    full: fitCandidate(rows, c.lag, c.boundary, c.solar) })).filter(c => c.full !== null);
  if (!candidates.length) return { ok: false, reason: usable.length ? "singular" : "insufficient_samples", sample_count: usable.length,
    learning_evidence: { method: ROOM_MEAN_LEARNING_METHOD, observation: "quarter_mean", selection: "chronological_transition_mse",
      training_pairs: 0, validation_pairs: 0, validation_mse_c2: null, selected_boundary: null, selected_lag_h: null } };
  // Candidates are judged on the same observed validation transitions.
  const comparable = new Set<number>();
  for (let i = split - 1; i + 1 < rows.length; i++) {
    if (candidates.every(c => c.full!.design.terms.some(t => t.index === i))) comparable.add(i);
  }
  const scored = candidates.map(c => ({ ...c, validation: c.training ? heldOut(c.training, rows, split, comparable) : { mse: null, count: 0 } }));
  const validated = scored.filter(c => c.validation.mse !== null);
  // Algebraically identifiable short histories still produce a model, with
  // explicit zero validation evidence; absence of holdout does not gate planning.
  const selected = (validated.length ? validated : scored).reduce((best, c) =>
    (c.validation.mse ?? c.full!.mse) < (best.validation.mse ?? best.full!.mse) ? c : best);
  const fit = selected.full!, gain = fit.beta[0], prediction = forecastError(fit, rows);
  const warnings: ThermalFitRejection[] = [];
  if (fit.n < MIN_TRAINING_SAMPLES) warnings.push("insufficient_samples");
  if (usable.filter(r => r.heat_w! > HEATED_SAMPLE_MIN_W).length < MIN_HEATED_SAMPLES) warnings.push("insufficient_heating");
  if (prediction !== null && prediction > MAX_PREDICTION_ERROR_C) warnings.push("poor_fit");
  const solarRows = usable.filter(r => finite(r.solar_w_per_m2));
  const changes = fit.design.terms.map(t => rows[t.index + 1].room_c! - rows[t.index].room_c!);
  const average = changes.reduce((sum, v) => sum + v, 0) / changes.length;
  const variance = changes.reduce((sum, v) => sum + (v - average) ** 2, 0) / changes.length;
  const model: ThermalZoneModel = {
    gain_c_per_wh: gain, cooling_constant_per_h: fit.boundary === "outdoor" ? fit.k : 0,
    house_coupling_per_h: fit.boundary === "house" ? fit.k : null, heat_lag_h: fit.lag,
    background_gain_c_per_h: fit.beta[1], solar_gain_c_per_h_per_wm2: fit.solar ? fit.beta[2] : null,
    solar_mean_w_per_m2: fit.solar ? solarRows.reduce((sum, r) => sum + r.solar_w_per_m2!, 0) / solarRows.length : null,
    thermal_capacity_wh_per_c: 1 / gain, heat_loss_w_per_c: fit.k / gain, time_constant_h: 1 / fit.k,
    heating_rate_c_per_h: ratedPowerW && ratedPowerW > 0 ? gain * ratedPowerW : null,
    sample_count: fit.n, r2: variance > 0 ? 1 - fit.mse / variance : 0,
    residual_std_c: Math.sqrt(fit.mse), prediction_error_c: prediction,
  };
  return { ok: true, model, ...(warnings.length ? { warnings } : {}), learning_evidence: {
    method: ROOM_MEAN_LEARNING_METHOD, observation: "quarter_mean", selection: "chronological_transition_mse",
    training_pairs: selected.training?.n ?? 0, validation_pairs: selected.validation.count,
    validation_mse_c2: selected.validation.mse, selected_boundary: fit.boundary, selected_lag_h: fit.lag,
  } };
}
