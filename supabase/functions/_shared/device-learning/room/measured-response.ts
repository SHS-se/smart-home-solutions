/** Compact measured-run response: exact native means, shared physical parameters,
 * nonnegative entry storage, and run-energy robust weighting. No latent episodes. */
import type { RoomMeanQuarter } from "./mean-observations.ts";
import type { ThermalFitResult } from "./regression.ts";
import { roomIntervalHours, roomIntervalSeconds } from "./mean-evidence.ts";
import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import { MeanFeatureWorkspace } from "./mean-features.ts";
import { leastSquares, factorLeastSquares } from "./mean-least-squares.ts";
import { solveNonnegativeNuisance } from "./mean-nuisance.ts";
import { roomMeanPair, roomEquilibriumMeanPair } from "./mean-pairs.ts";
import { roomMeanObservation } from "../../planner/models/room/observation.ts";
import { excludeUncontrolledRoomHeat, type ThermalZoneModel } from "../../planner/models/room/thermal.ts";
import { ROOM_MEASURED_POLICY, measuredRoomLineAt, type MeasuredRoomCalibration, type MeasuredRoomLedger, type MeasuredRoomRun } from "../../planner/models/room/measured-evidence.ts";
import { validateRoomResponseEvidence, type RoomResponseEvidence } from "./chronological-evidence.ts";
import { measureRoomRuns, roomHeatingRuns } from "./run-measurements.ts";
import { assessMeasuredRuns, robustResidualScale, huberWeight } from "./measured-lines.ts";

const LAGS = [0, .5, 1, 1.5, 2, 2.5, 3, 4, 5] as const;
// One candidate is the atomic checkpoint: lag × partition × weather × family.
const FAMILIES = ["finite", "integrator", "equilibrium"] as const;
export const ROOM_MEASURED_CELL_COUNT = LAGS.length * 2 * 2 * FAMILIES.length;
function cellCoordinates(index: number) {
  const group = Math.floor(index / 6);
  return { lag: LAGS[Math.floor(group / 2)], partition: group % 2, weather: index % 6 >= 3, family: FAMILIES[index % 3] };
}
type Family = "finite" | "integrator" | "equilibrium";
interface Candidate {
  family: Family; lag: number; k: number; solar: boolean; weather: boolean;
  low: number; high: number; beta: number[]; initial: [number, number][];
  n: number; dof: number; mse: number;
}
export interface MeasuredRoomCell { index: number; fits: Candidate[] }
interface View { rows: RoomMeanQuarter[]; weights: Float64Array; low: number; high: number; solar: boolean }
export interface PreparedMeasuredRoomResponse {
  full: View; training: View; ratedPowerW: number | null;
}
interface Term { index: number; segment: number; z: number; x: number[]; y: number }
interface System { terms: Term[]; count: number }
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const powerKnown = (row: RoomMeanQuarter) => finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row) && finite(row.outdoor_c);
const adjacent = (a: RoomMeanQuarter, b: RoomMeanQuarter) => b.start_ms === a.start_ms + roomIntervalSeconds(a) * 1000;

function prepareView(rows: RoomMeanQuarter[]): View {
  const hours = rows.reduce((sum, row) => sum + roomIntervalHours(row), 0);
  const energy = rows.reduce((sum, row) => sum + (powerKnown(row) ? row.heat_w! * roomIntervalHours(row) / 1000 : 0), 0);
  // Outside completed runs, retain positive time-weighted evidence at the
  // capture's measured average energy rate. No incomplete run is discarded.
  const weights = Float64Array.from(rows, row => roomIntervalHours(row) * (energy > 0 ? energy / hours : 1));
  for (const run of roomHeatingRuns(rows)) {
    let duration = 0;
    for (let i = run.from; i < run.end; i++) duration += roomIntervalHours(rows[i]);
    if (!(duration > 0 && run.measured_wh > 0)) continue;
    for (let i = run.from; i < run.end; i++) weights[i] = run.measured_wh / 1000 * roomIntervalHours(rows[i]) / duration;
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total > 0) for (let i = 0; i < weights.length; i++) weights[i] *= rows.length / total;
  const heated = rows.filter(row => powerKnown(row) && row.heat_w! > 0);
  let low = Infinity, high = -Infinity;
  for (const row of heated) { low = Math.min(low, row.outdoor_c!); high = Math.max(high, row.outdoor_c!); }
  if (!finite(low)) low = high = 0;
  const eligible = rows.filter(row => powerKnown(row) && finite(row.room_c) && finite(row.house_c));
  const solarRows = eligible.filter(row => finite(row.solar_w_per_m2));
  const solar = solarRows.length > 0 && solarRows.some(row => row.solar_w_per_m2 !== solarRows[0].solar_w_per_m2);
  return { rows, weights, low, high, solar };
}
export function prepareMeasuredRoomResponse(evidence: RoomResponseEvidence, ratedPowerW: number | null): PreparedMeasuredRoomResponse {
  validateRoomResponseEvidence(evidence);
  return { full: prepareView(evidence.fullRows), training: prepareView(evidence.trainingRows), ratedPowerW };
}

function pairs(k: number, lag: number, family: Family) {
  const op = [.25, 1].map(h => roomMeanObservation(family === "equilibrium" ? 0 : k, lag, h));
  return op.flatMap((a, i) => op.map((b, j) => family === "equilibrium"
    ? roomEquilibriumMeanPair(lag, i ? 1 : .25, j ? 1 : .25) : roomMeanPair(a, b)));
}
/** Memory features include every known input, even where room means are absent. */
function visitFeatures(view: View, lag: number, visit: (index: number, segment: number, share: number, kind: number, values: number[]) => void): void {
  const { rows, low, high } = view, carry = [.25, 1].map(h => lag > 0 ? Math.exp(-h / lag) : 0);
  let memoryLow = 0, memoryHigh = 0, share = 1, segment = 0;
  const anchors = (row: RoomMeanQuarter) => {
    const fraction = high > low ? (row.outdoor_c! - low) / (high - low) : 0;
    return [row.heat_w! * (1 - fraction), row.heat_w! * fraction];
  };
  for (let i = 0; i + 1 < rows.length; i++) {
    const q = rows[i], next = rows[i + 1], kind = roomIntervalSeconds(q) === 900 ? 0 : 1;
    const known = powerKnown(q), contiguous = adjacent(q, next), [a, b] = known ? anchors(q) : [0, 0];
    if (known && contiguous && powerKnown(next) && finite(q.room_c) && finite(next.room_c) &&
      finite(q.house_c) && finite(next.house_c) && (!view.solar || (finite(q.solar_w_per_m2) && finite(next.solar_w_per_m2)))) {
      const [c, d] = anchors(next);
      visit(i, segment, share, kind * 2 + (roomIntervalSeconds(next) === 900 ? 0 : 1),
        [memoryLow, a, c, memoryHigh, b, d, 1, q.outdoor_c! - q.house_c, next.outdoor_c! - next.house_c,
          view.solar ? q.solar_w_per_m2! : 0, view.solar ? next.solar_w_per_m2! : 0,
          next.room_c, q.room_c, q.house_c, next.house_c]);
    }
    if (!known || !contiguous) { memoryLow = memoryHigh = 0; share = 1; segment++; }
    else { memoryLow = carry[kind] * memoryLow + (1 - carry[kind]) * a;
      memoryHigh = carry[kind] * memoryHigh + (1 - carry[kind]) * b; share *= carry[kind]; }
  }
}
function equation(v: readonly number[], pair: ReturnType<typeof roomMeanPair>, k: number, family: Family, weather: boolean, solar: boolean): { x: number[]; y: number } {
  const a = pair.memory * v[0] + pair.currentHeat * v[1] + pair.nextHeat * v[2];
  const b = pair.memory * v[3] + pair.currentHeat * v[4] + pair.nextHeat * v[5];
  return { x: [...(weather ? [a, b] : [a + b]), (pair.L + pair.nextForcing) * v[6],
    pair.L * v[7] + pair.nextForcing * v[8], ...(solar ? [pair.L * v[9] + pair.nextForcing * v[10]] : [])],
    y: v[11] - pair.alpha * v[12] - (family === "equilibrium" ? 1 : k) * (pair.L * v[13] + pair.nextForcing * v[14]) };
}
function compressed(view: View, lag: number, weights: Float64Array): (k: number, family: Family, weather: boolean) => System {
  const work = new MeanFeatureWorkspace(view.rows.length, 15);
  visitFeatures(view, lag, (_i, segment, share, kind, values) => {
    const w = Math.sqrt(weights[_i]);
    work.add(kind, segment, lag > 0 ? share * w : 0, values.map(value => value * w));
  });
  const features = work.factor(), count = work.count;
  return (k, family, weather) => {
    const operators = pairs(k, lag, family);
    return { count, terms: features.map(({ values, kind, segment, initialScale }) => ({ index: -1, segment,
      z: operators[kind].memory * initialScale, ...equation(values, operators[kind], k, family, weather, view.solar) })) };
  };
}
function terms(view: View, candidate: Candidate, visit: (term: Term) => void): void {
  const operators = pairs(candidate.k, candidate.lag, candidate.family);
  visitFeatures({ ...view, low: candidate.low, high: candidate.high, solar: candidate.solar }, candidate.lag, (index, segment, share, kind, v) => visit({ index, segment,
    z: candidate.lag > 0 ? share * operators[kind].memory : 0,
    ...equation(v, operators[kind], candidate.k, candidate.family, candidate.weather, candidate.solar) }));
}

/** A tiny box-constrained QR solve; active faces express physical coefficients. */
function physicalSolve(matrix: number[][], target: number[], scales: number[], bounds: Map<number, readonly [number, number]>): number[] | null {
  const factor = factorLeastSquares(matrix, target, scales);
  if (!factor) return null;
  const constraints = [...bounds], fixed = new Map<number, number>();
  let best: number[] | null = null, objective = Infinity;
  const trial = (at: number) => {
    if (at < constraints.length) {
      const [j, [lo, hi]] = constraints[at];
      trial(at + 1); fixed.set(j, lo); trial(at + 1);
      if (Number.isFinite(hi) && hi !== lo) { fixed.set(j, hi); trial(at + 1); }
      fixed.delete(j); return;
    }
    const free = scales.map((_, j) => j).filter(j => !fixed.has(j));
    const adjusted = factor.target.map((y, i) => y - [...fixed].reduce((sum, [j, value]) => sum + value * factor.matrix[i][j], 0));
    const solved = free.length ? leastSquares(factor.matrix.map(row => free.map(j => row[j])), adjusted, free.map(j => scales[j])) : [];
    if (!solved) return;
    const beta = scales.map((_, j) => fixed.get(j) ?? solved[free.indexOf(j)]);
    if (!beta.every(Number.isFinite) || constraints.some(([j, [lo, hi]]) => beta[j] < lo || beta[j] > hi)) return;
    const error = factor.target.reduce((sum, y, i) => sum + (y - factor.matrix[i].reduce((s, x, j) => s + x * beta[j], 0)) ** 2, 0);
    if (error < objective) { best = beta; objective = error; }
  };
  trial(0); return best;
}
function estimate(system: System, view: View, lag: number, k: number, family: Family, weather: boolean): Candidate | null {
  const gains = weather ? 2 : 1, exchange = gains + 1, size = gains + 2 + Number(view.solar), groups = new Map<number, number[]>();
  system.terms.forEach((term, i) => { if (term.z !== 0) { const indices = groups.get(term.segment) ?? []; indices.push(i); groups.set(term.segment, indices); } });
  const free = Array.from({ length: size }, (_, j) => j).filter(j => family !== "integrator" || j !== exchange);
  const dof = system.count - free.length - groups.size - Number(family === "finite");
  if (dof <= 0) return null;
  const bounds = new Map<number, readonly [number, number]>();
  for (let j = 0; j < gains; j++) bounds.set(free.indexOf(j), [0, Infinity]);
  if (family !== "integrator") bounds.set(free.indexOf(exchange), [0, family === "equilibrium" ? 1 : k]);
  if (view.solar) bounds.set(free.indexOf(size - 1), [0, Infinity]);
  const fit = solveNonnegativeNuisance(system.terms.map(t => free.map(j => t.x[j])), system.terms.map(t => t.y),
    [...groups.values()].map(indices => ({ indices, values: indices.map(i => system.terms[i].z) })),
    (matrix, target, scales) => physicalSolve(matrix, target, scales, bounds), system.count);
  if (!fit) return null;
  const beta = Array.from({ length: size }, (_, j) => family === "integrator" && j === exchange ? 0 : fit.beta[free.indexOf(j)]);
  const initial = new Map([...groups.keys()].map((key, i) => [key, fit.initial[i]]));
  const error = system.terms.reduce((sum, t) => sum + (t.y - t.x.reduce((s, x, j) => s + x * beta[j], 0) - t.z * (initial.get(t.segment) ?? 0)) ** 2, 0);
  return finite(error) ? { family, lag, k, solar: view.solar, weather, low: view.low, high: view.high,
    beta, initial: [...initial], n: system.count, dof, mse: error / system.count } : null;
}
/** Profile an unbounded positive exchange coordinate, including exact limits separately. */
function finiteProfile(at: (k: number) => Candidate | null): Candidate | null {
  const evaluate = (x: number) => { const k = Math.exp(x); return finite(k) && k > 0 ? at(k) : null; };
  let center = 0, best = evaluate(center);
  if (!best) for (let distance = 1; distance < 32 && !best; distance++) for (const x of [-distance, distance]) {
    const candidate = evaluate(x); if (candidate) { center = x; best = candidate; break; }
  }
  if (!best) return null;
  let lo = center - 1, hi = center + 1, bracket = false;
  for (let step = 0; step < 64; step++) {
    const left = evaluate(lo), right = evaluate(hi);
    const tolerance = Number.EPSILON * 128 * Math.max(1, best.mse);
    if (left && left.mse < best.mse - tolerance && (!right || left.mse <= right.mse)) {
      best = left; hi = center; center = lo; lo--;
    } else if (right && right.mse < best.mse - tolerance) { best = right; lo = center; center = hi; hi++; }
    else { bracket = !!left && !!right && left.mse > best.mse + tolerance && right.mse > best.mse + tolerance; break; }
  }
  if (!bracket) return null;
  const ratio = (Math.sqrt(5) - 1) / 2;
  let l = hi - ratio * (hi - lo), r = lo + ratio * (hi - lo), left = evaluate(l), right = evaluate(r);
  for (let i = 0; i < 28; i++) {
    if (left && left.mse < best.mse) best = left;
    if (right && right.mse < best.mse) best = right;
    if ((left?.mse ?? Infinity) < (right?.mse ?? Infinity)) { hi = r; r = l; right = left; l = hi - ratio * (hi - lo); left = evaluate(l); }
    else { lo = l; l = r; left = right; r = lo + ratio * (hi - lo); right = evaluate(r); }
  }
  return best;
}
function fittedResiduals(view: View, fit: Candidate): { indices: number[]; residuals: number[] } {
  const initial = new Map(fit.initial), indices: number[] = [], residuals: number[] = [];
  terms(view, fit, term => { indices.push(term.index); residuals.push(term.y - term.x.reduce((sum, x, j) => sum + x * fit.beta[j], 0) - term.z * (initial.get(term.segment) ?? 0)); });
  return { indices, residuals };
}
export function fitMeasuredRoomCell(prepared: PreparedMeasuredRoomResponse, index: number): MeasuredRoomCell {
  if (!Number.isInteger(index) || index < 0 || index >= ROOM_MEASURED_CELL_COUNT) throw new Error("Invalid measured room cell");
  const { partition, lag, weather, family } = cellCoordinates(index);
  const source = partition === 0 ? prepared.training : prepared.full;
  if (source.rows.length < 2 || (weather && !(source.high > source.low))) return { index, fits: [] };
  const fits: Candidate[] = [];
  // Solar and no-solar are nested model shapes, selected on common observed
  // holdout support. A missing solar interval is never a measured zero.
  for (const solar of source.solar ? [false, true] : [false]) {
    const view = { ...source, solar };
    const fitAt = (design: ReturnType<typeof compressed>) => family === "finite"
      ? finiteProfile(k => estimate(design(k, family, weather), view, lag, k, family, weather))
      : estimate(design(family === "equilibrium" ? 1 : 0, family, weather), view, lag, family === "equilibrium" ? 1 : 0, family, weather);
    let fit = fitAt(compressed(view, lag, view.weights));
    if (!fit) continue;
    // Two reweighted refits suppress isolated contamination without a latent
    // episode model or removing a measured run from the result.
    for (let iteration = 0; iteration < 2; iteration++) {
      const { indices, residuals } = fittedResiduals(view, fit);
      const scale = Math.max(Number.EPSILON * 128, robustResidualScale(residuals));
      const weights = new Float64Array(view.weights);
      indices.forEach((at, i) => { weights[at] *= huberWeight(residuals[i], scale); });
      const next = fitAt(compressed(view, lag, weights));
      if (!next) break;
      fit = next;
    }
    // Comparable, unweighted conditional error is kept separately from IRLS.
    const residuals = fittedResiduals(view, fit).residuals;
    fit.mse = residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length;
    fits.push(fit);
  }
  return { index, fits };
}

function responseModel(fit: Candidate, ratedPowerW: number | null): ThermalZoneModel {
  const gains = fit.weather ? 2 : 1, gain = fit.weather ? (fit.beta[0] + fit.beta[1]) / 2 : fit.beta[0];
  const reference = (fit.low + fit.high) / 2;
  const slope = fit.weather && gain > 0 ? (fit.beta[1] - fit.beta[0]) / ((fit.high - fit.low) * gain) : 0;
  const weather = { gain_reference_outdoor_c: reference, gain_outdoor_slope_per_c: slope };
  const common = { ...weather, heat_lag_h: fit.lag, sample_count: fit.n, residual_std_c: Math.sqrt(fit.mse), r2: 0, prediction_error_c: null };
  const background = fit.beta[gains], outdoor = fit.beta[gains + 1], sun = fit.solar ? fit.beta[gains + 2] : null;
  if (fit.family === "equilibrium") return { ...common, response_family: "equilibrium", heater_c_per_w: gain,
    outdoor_share: outdoor, offset_c: background, solar_c_per_wm2: sun };
  return { ...common, response_family: fit.family, gain_c_per_wh: gain, cooling_constant_per_h: outdoor,
    house_coupling_per_h: fit.k - outdoor, background_gain_c_per_h: background, solar_gain_c_per_h_per_wm2: sun,
    thermal_capacity_wh_per_c: slope === 0 && gain > 0 ? 1 / gain : null,
    heat_loss_w_per_c: slope === 0 && gain > 0 ? fit.k / gain : null,
    time_constant_h: fit.k > 0 ? 1 / fit.k : null,
    heating_rate_c_per_h: ratedPowerW !== null && ratedPowerW > 0 ? gain * ratedPowerW : null };
}
/** The planner's response from the published measured lines. Cooling follows
 * Newton's law through the cooling line's level at its measured room and
 * outdoor temperatures. The heater gain is the measured net rise line itself.
 * That rise already includes the losses during each run, so the planner counts
 * some loss twice while heating: it can understate the heater, never overstate
 * it. There is no rest-of-home exchange, constant term, solar term or delay. */
function lineCandidate(runs: readonly MeasuredRoomRun[]): Candidate | null {
  const { cooling, heating } = assessMeasuredRuns(runs, null).calibration.lines;
  const fall = runs.flatMap(run => run.cooling ? [run.cooling] : []);
  const hours = fall.reduce((sum, point) => sum + point.hours, 0);
  if (!cooling || !(hours > 0)) return null;
  const drive = fall.reduce((sum, point) => sum + point.hours * point.room_c, 0) / hours - cooling.reference_outdoor_c;
  if (!(cooling.intercept > 0 && drive > 0)) return null;
  const k = cooling.intercept / drive;
  const rise = runs.flatMap(run => run.heating && run.heating.energy_kwh > 0 ? [run.heating] : []);
  if (!heating || !rise.length) return null;
  const low = Math.min(...rise.map(point => point.outdoor_c)), high = Math.max(...rise.map(point => point.outdoor_c));
  const gain = (x: number) => Math.max(0, measuredRoomLineAt(heating, x)) / 1000;
  const weather = high > low && heating.slope_per_c > 0;
  const beta = weather ? [gain(low), gain(high), 0, k] : [gain(heating.reference_outdoor_c), 0, k];
  const n = heating.points + cooling.points, dof = n - (weather ? 3 : 2);
  if (!(Math.max(beta[0], weather ? beta[1] : 0) > 0) || dof <= 0) return null;
  return { family: "finite", lag: 0, k, solar: false, weather, low: weather ? low : heating.reference_outdoor_c,
    high: weather ? high : heating.reference_outdoor_c, beta, initial: [], n, dof, mse: 0 };
}
/** The planner response the measured lines give for these runs, if they form one. */
export function measuredLineResponse(runs: readonly MeasuredRoomRun[], ratedPowerW: number | null): ThermalZoneModel | null {
  const fit = lineCandidate(runs);
  return fit ? responseModel(fit, ratedPowerW) : null;
}
function gainAt(fit: Candidate, outdoor: number): number {
  return fit.weather ? Math.max(0, fit.beta[0] + (fit.beta[1] - fit.beta[0]) * (outdoor - fit.low) / (fit.high - fit.low)) : fit.beta[0];
}
/** Open-loop native-mean prediction. Only the entry state is conditioned on
 * measurements; later observations never reset the simulated room trajectory. */
function validationErrors(view: View, fit: Candidate, split: number, projected = false): Map<number, number> {
  const errors = new Map<number, number>(), rows = view.rows, initial = new Map(fit.initial);
  const gains = fit.weather ? 2 : 1, outdoor = fit.beta[gains + 1], background = fit.beta[gains];
  const sun = fit.solar ? fit.beta[gains + 2] : 0;
  let release: number | null = null, temperature: number | null = null, segment = 0, seededAt = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], h = roomIntervalHours(row);
    // Native means locate a new measured entry temperature at the holdout
    // boundary; known heater memory still carries through that boundary.
    if (i === split) { temperature = null; seededAt = i; }
    const known = powerKnown(row) && finite(row.house_c) && (!fit.solar || finite(row.solar_w_per_m2));
    if (!known) { release = temperature = null; segment++; continue; }
    const heating = gainAt(fit, row.outdoor_c!) * row.heat_w!;
    const force = outdoor * row.outdoor_c! + ((fit.family === "equilibrium" ? 1 : fit.k) - outdoor) * row.house_c! + (projected && i >= split ? Math.min(0, background) : background) + sun * (row.solar_w_per_m2 ?? 0);
    if (release === null) {
      if (fit.lag === 0) release = 0;
      else if (i < split && initial.has(segment)) release = initial.get(segment)!;
      else if (fit.family === "equilibrium" && finite(row.room_c)) {
        const fraction = -fit.lag * Math.expm1(-h / fit.lag) / h;
        release = Math.max(0, (row.room_c - force - (1 - fraction) * heating) / fraction);
      } else {
        const next = rows[i + 1];
        if (next && adjacent(row, next) && powerKnown(next) && finite(row.room_c) && finite(next.room_c) &&
          finite(next.house_c) && (!fit.solar || finite(next.solar_w_per_m2))) {
          const pair = roomMeanPair(roomMeanObservation(fit.k, fit.lag, h), roomMeanObservation(fit.k, fit.lag, roomIntervalHours(next)));
          const nextHeat = gainAt(fit, next.outdoor_c!) * next.heat_w!;
          const nextForce = outdoor * next.outdoor_c! + (fit.k - outdoor) * next.house_c +
            (projected && i + 1 >= split ? Math.min(0, background) : background) + sun * (next.solar_w_per_m2 ?? 0);
          if (pair.memory !== 0) {
            // Infer the release at this observed pair, not a remote segment's
            // initial coordinate. Two means consume one conditional transition.
            release = Math.max(0, (next.room_c - pair.alpha * row.room_c - pair.L * force - pair.nextForcing * nextForce -
              pair.currentHeat * heating - pair.nextHeat * nextHeat) / pair.memory);
            seededAt = i + 1;
          }
        }
      }
    }
    if (release === null) continue;
    if (fit.family === "equilibrium") {
      const carry = fit.lag > 0 ? Math.exp(-h / fit.lag) : 0;
      const fraction = fit.lag > 0 ? fit.lag * (1 - carry) / h : 0;
      const predicted = force + fraction * release + (1 - fraction) * heating;
      if (i >= split && i > seededAt && finite(row.room_c)) errors.set(i, row.room_c - predicted);
      release = carry * release + (1 - carry) * heating;
    } else {
      const op = roomMeanObservation(fit.k, fit.lag, h);
      if (temperature === null && finite(row.room_c)) {
        temperature = (row.room_c - op.U * release - (op.V - op.U) * heating - op.V * force) / op.E;
        seededAt = Math.max(seededAt, i);
      }
      if (temperature !== null) {
        const predicted = op.E * temperature + op.U * release + (op.V - op.U) * heating + op.V * force;
        if (i >= split && i > seededAt && finite(row.room_c) && finite(predicted)) errors.set(i, row.room_c - predicted);
        temperature = op.a * temperature + op.B * release + (op.effect - op.B) * heating + op.effect * force;
      }
      release = op.C * release + (1 - op.C) * heating;
    }
    if (i + 1 < rows.length && !adjacent(row, rows[i + 1])) { release = temperature = null; segment++; }
  }
  return errors;
}
function candidateKey(fit: Candidate): string { return `${fit.family}:${fit.lag}:${fit.weather}:${fit.solar}`; }
function aicc(fit: Candidate): number {
  const parameters = fit.n - fit.dof + 1;
  return fit.n * Math.log(Math.max(Number.MIN_VALUE, fit.mse)) + 2 * parameters +
    (fit.n > parameters + 1 ? 2 * parameters * (parameters + 1) / (fit.n - parameters - 1) : Infinity);
}
type EvaluatedCandidate = { fit: Candidate; errors: Map<number, number> };
/** Each selection population owns its common support. Descriptive algebraic
 * evidence cannot remove observations from state-carrying forecast selection. */
function selectCandidate(full: readonly Candidate[], evaluated: readonly EvaluatedCandidate[]): {
  selected: Candidate | null; validation: Candidate | null; errors: number[];
  criterion: "chronological_trajectory_mse" | "aicc";
} {
  const common = evaluated.length ? [...evaluated[0].errors.keys()].filter(i => evaluated.every(value => value.errors.has(i))) : [];
  if (common.length) {
    const error = (value: EvaluatedCandidate) => common.reduce((sum, i) => sum + value.errors.get(i)! ** 2, 0) / common.length;
    const best = evaluated.reduce((a, b) => error(b) < error(a) ? b : a);
    return { selected: full.find(fit => candidateKey(fit) === candidateKey(best.fit))!,
      validation: best.fit, errors: common.map(i => best.errors.get(i)!), criterion: "chronological_trajectory_mse" as const };
  }
  return { selected: full.reduce<Candidate | null>((best, fit) => !best || aicc(fit) < aicc(best) ? fit : best, null),
    validation: null, errors: [], criterion: "aicc" as const };
}
export interface MeasuredRoomLearningEvidence {
  method: "measured_run_native_mean_v1";
  implementation: typeof ROOM_MEASURED_POLICY;
  observation: "interval_mean";
  selection: "chronological_trajectory_mse";
  selection_scope: "state_carrying";
  selected_lag_h: number | null;
  /** Which response the planner receives. The chronological fit stays as evidence. */
  planner_response: "measured_lines" | "chronological_fit";
  /** The chronological fit as fitted, including any positive background. */
  chronological_model: ThermalZoneModel | null;
  chronological_validation: { observations: number; trajectory_mae_c: number | null; trajectory_bias_c: number | null };
  /** Best description across all families, not a second executable response. */
  descriptive_fit: { family: Family; lag_h: number; criterion: "chronological_trajectory_mse" | "aicc";
    observations: number; trajectory_mae_c: number | null; trajectory_bias_c: number | null } | null;
  forecast_nuisance: { excluded: true; fitted_offset: number; projected_offset: number; unit: "C/h" | "C" };
  measured_runs: MeasuredRoomCalibration;
}
export interface LearnedMeasuredRoomResponse {
  result: ThermalFitResult<ThermalZoneModel> & { learning_evidence: MeasuredRoomLearningEvidence };
  run_ledger: MeasuredRoomLedger | null;
}
export function finalizeMeasuredRoomResponse(prepared: PreparedMeasuredRoomResponse, cells: readonly MeasuredRoomCell[]): LearnedMeasuredRoomResponse {
  if (cells.length !== ROOM_MEASURED_CELL_COUNT || cells.some((cell, i) => cell.index !== i)) throw new Error("Incomplete measured room fit");
  const full = cells.filter(cell => cellCoordinates(cell.index).partition === 1).flatMap(cell => cell.fits);
  const training = cells.filter(cell => cellCoordinates(cell.index).partition === 0).flatMap(cell => cell.fits);
  const split = prepared.training.rows.length;
  // The training prefix has its own source qualification. Future qualification
  // must not rewrite its input-memory history during holdout scoring.
  const validationView = { ...prepared.full, rows: [...prepared.training.rows, ...prepared.full.rows.slice(split)] };
  const possible = new Map(full.map(fit => [candidateKey(fit), fit]));
  const evaluated = training.filter(fit => possible.has(candidateKey(fit))).map(fit => ({ fit, errors: validationErrors(validationView, fit, split) }));
  // Algebraic equilibrium identifies a balance, not room capacity. The same
  // learner fits it as descriptive evidence but never invents a relaxation
  // constant to turn that balance into a measured-state forecast.
  const selection = selectCandidate(full.filter(fit => fit.family !== "equilibrium"),
    evaluated.filter(value => value.fit.family !== "equilibrium"));
  const { selected, validation } = selection;
  const descriptive = selectCandidate(full, evaluated);
  const chronological = selected ? responseModel(selected, prepared.ratedPowerW) : null;
  // The planner plans with the measured lines whenever both can be formed;
  // otherwise the chronological fit keeps the room planned.
  const runs = measureRoomRuns(prepared.full.rows);
  const lines = lineCandidate(runs);
  if (lines) {
    const fitted = [...validationErrors(prepared.full, lines, 0).values()];
    lines.mse = fitted.length ? fitted.reduce((sum, x) => sum + x * x, 0) / fitted.length : 0;
  }
  const lineValidation = lines && split ? lineCandidate(measureRoomRuns(prepared.training.rows)) : null;
  const planner = lines ?? selected;
  const model = planner ? responseModel(planner, prepared.ratedPowerW) : null;
  const assessed = assessMeasuredRuns(runs, model);
  const checked = lines ? lineValidation : validation;
  const errors = lines ? lineValidation ? [...validationErrors(validationView, lineValidation, split).values()] : [] : selection.errors;
  const projectedValues = checked ? [...validationErrors(validationView, checked, split, true).values()] : [];
  const projectedMetrics = {
    projected_trajectory_mae_c: projectedValues.length ? projectedValues.reduce((sum, x) => sum + Math.abs(x), 0) / projectedValues.length : null,
    projected_trajectory_bias_c: projectedValues.length ? projectedValues.reduce((sum, x) => sum + x, 0) / projectedValues.length : null,
  };
  const calibration: MeasuredRoomCalibration = { ...assessed.calibration, fitted_observations: planner?.n ?? 0,
    residual_degrees_of_freedom: planner?.dof ?? 0, validation: { ...projectedMetrics,
      training_to: split ? new Date(prepared.training.rows[split - 1].start_ms + roomIntervalSeconds(prepared.training.rows[split - 1]) * 1000).toISOString() : null,
      observations: errors.length, trajectory_mae_c: errors.length ? errors.reduce((sum, x) => sum + Math.abs(x), 0) / errors.length : null,
      trajectory_bias_c: errors.length ? errors.reduce((sum, x) => sum + x, 0) / errors.length : null } };
  const offset = planner ? planner.beta[planner.weather ? 2 : 1] : 0;
  const learning: MeasuredRoomLearningEvidence = { method: "measured_run_native_mean_v1", implementation: ROOM_MEASURED_POLICY,
    observation: "interval_mean", selection: "chronological_trajectory_mse", selection_scope: "state_carrying", selected_lag_h: selected?.lag ?? null,
    planner_response: lines ? "measured_lines" : "chronological_fit",
    chronological_model: chronological,
    chronological_validation: { observations: selection.errors.length,
      trajectory_mae_c: selection.errors.length ? selection.errors.reduce((sum, x) => sum + Math.abs(x), 0) / selection.errors.length : null,
      trajectory_bias_c: selection.errors.length ? selection.errors.reduce((sum, x) => sum + x, 0) / selection.errors.length : null },
    descriptive_fit: descriptive.selected ? { family: descriptive.selected.family, lag_h: descriptive.selected.lag,
      criterion: descriptive.criterion, observations: descriptive.errors.length,
      trajectory_mae_c: descriptive.errors.length ? descriptive.errors.reduce((sum, x) => sum + Math.abs(x), 0) / descriptive.errors.length : null,
      trajectory_bias_c: descriptive.errors.length ? descriptive.errors.reduce((sum, x) => sum + x, 0) / descriptive.errors.length : null } : null,
    forecast_nuisance: { excluded: true, fitted_offset: offset, projected_offset: Math.min(0, offset), unit: planner?.family === "equilibrium" ? "C" : "C/h" },
    measured_runs: calibration };
  return { result: model ? { ok: true, model: excludeUncontrolledRoomHeat(model), learning_evidence: learning }
    : { ok: false, reason: "singular", sample_count: prepared.full.rows.length, learning_evidence: learning },
    run_ledger: { policy: ROOM_MEASURED_POLICY, observed_runs: assessed.runs.length, runs: assessed.runs } };
}
export function parseMeasuredRoomCells(input: unknown): MeasuredRoomCell[] {
  if (!Array.isArray(input) || input.length > ROOM_MEASURED_CELL_COUNT) throw new Error("Invalid measured room cells");
  return input.map((value: unknown, index) => {
    if (!value || typeof value !== "object" || !("index" in value) || value.index !== index || !("fits" in value) || !Array.isArray(value.fits) || value.fits.length > 2) throw new Error("Invalid measured room cell");
    const fits = value.fits.map((raw: unknown): Candidate => {
      if (!raw || typeof raw !== "object") throw new Error("Invalid measured room fit");
      const row = raw as Record<string, unknown>;
      if ((row.family !== "finite" && row.family !== "integrator" && row.family !== "equilibrium") || row.lag !== cellCoordinates(index).lag || row.family !== cellCoordinates(index).family || row.weather !== cellCoordinates(index).weather ||
        typeof row.solar !== "boolean" || typeof row.weather !== "boolean" || !Array.isArray(row.beta) ||
        !row.beta.every(v => typeof v === "number" && Number.isFinite(v)) || !Array.isArray(row.initial) ||
        !row.initial.every(v => Array.isArray(v) && v.length === 2 && v.every(x => typeof x === "number" && Number.isFinite(x))) ||
        !["k", "low", "high", "n", "dof", "mse"].every(key => typeof row[key] === "number" && Number.isFinite(row[key])) ||
        !(Number(row.n) > Number(row.dof) && Number(row.dof) > 0) || Number(row.mse) < 0 || Number(row.k) < 0 ||
        row.beta.length !== (row.weather ? 4 : 3) + Number(row.solar)) throw new Error("Invalid measured room fit coefficients");
      const gains = row.weather ? 2 : 1, beta = row.beta as number[], initial = row.initial as [number, number][];
      if (!Number.isSafeInteger(row.n) || !Number.isSafeInteger(row.dof) || Number(row.low) > Number(row.high) ||
        (row.weather && !(Number(row.high) > Number(row.low))) || beta.slice(0, gains).some(v => v < 0) ||
        beta[gains + 1] < 0 || beta[gains + 1] > Number(row.k) || (row.solar && beta.at(-1)! < 0) ||
        (row.family === "integrator" && row.k !== 0) || (row.family === "equilibrium" && row.k !== 1) ||
        (row.family === "finite" && !(Number(row.k) > 0)) ||
        initial.some(([segment, state]) => !Number.isSafeInteger(segment) || segment < 0 || state < 0) ||
        new Set(initial.map(([segment]) => segment)).size !== initial.length) throw new Error("Invalid measured room physical state");
      return { family: row.family, lag: Number(row.lag), k: Number(row.k), solar: row.solar, weather: row.weather,
        low: Number(row.low), high: Number(row.high), beta: row.beta as number[], initial: row.initial as [number, number][],
        n: Number(row.n), dof: Number(row.dof), mse: Number(row.mse) };
    });
    if (new Set(fits.map(fit => fit.solar)).size !== fits.length) throw new Error("Duplicate measured room solar shape");
    return { index, fits };
  });
}
export function learnMeasuredRoomResponse(evidence: RoomResponseEvidence, ratedPowerW: number | null): LearnedMeasuredRoomResponse {
  const prepared = prepareMeasuredRoomResponse(evidence, ratedPowerW);
  return finalizeMeasuredRoomResponse(prepared, Array.from({ length: ROOM_MEASURED_CELL_COUNT }, (_, index) => fitMeasuredRoomCell(prepared, index)));
}
