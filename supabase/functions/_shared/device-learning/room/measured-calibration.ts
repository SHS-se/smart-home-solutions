/** Physical calibration from observed operation intervals, independent of peak-ledger points. */
import type { RoomMeanQuarter } from "./mean-observations.ts";
import type { DynamicThermalZoneModel } from "../../planner/models/room/thermal.ts";
import { roomMeanObservation } from "../../planner/models/room/observation.ts";
import { roomMeanPair } from "./mean-pairs.ts";
import { roomIntervalHours, roomIntervalSeconds } from "./mean-evidence.ts";
import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import { HEATED_SAMPLE_MIN_W } from "./regression.ts";
import { MeanFeatureWorkspace } from "./mean-features.ts";
import { physicalSolve, finiteProfile } from "./mean-fit-numerics.ts";
import { robustResidualScale, huberWeight } from "./measured-lines.ts";

export interface MeasuredCalibrationEvidence {
  method: "native_operation_response_v1";
  observation: "interval_mean";
  fitted_pairs: number;
  /** Operation classification only; every equation retains actual measured watts. */
  heater_input_pairs: number;
  off_pairs: number;
  unavailable_pairs: { input: number; room: number; outdoor: number; house: number; adjacency: number };
  fitted_hours: number;
  measured_wh: number;
  residual_degrees_of_freedom: number;
  conditional_residual_std_c: number | null;
  /** Fitted positive background excluded by the planner, expressed at the gain reference. */
  uncredited_background_w: number | null;
  operation_spans: number;
  unanchored_off_pairs: number;
  weighted_powered_support_kwh: number;
  weighted_coast_support_kwh: number;
  first_post_off_pairs: number;
  /** Observed minus predicted mean at the first fully OFF pair after an observed switch-off. */
  first_post_off_bias_c: number | null;
}

type ImmediateRoomModel = DynamicThermalZoneModel & {
  response_family: "finite";
  heat_lag_h: 0;
  solar_gain_c_per_h_per_wm2: null;
};
export type MeasuredRoomCalibrationFit =
  | { kind: "identified"; model: ImmediateRoomModel; evidence: MeasuredCalibrationEvidence }
  | { kind: "unidentified"; reason: "no_native_pairs" | "unidentified_heater" | "rank_deficient" | "unresolved_exchange";
      evidence: MeasuredCalibrationEvidence };

interface Pair { kind: number; values: number[]; weight: number; firstOff: boolean }
interface Fit { k: number; beta: number[]; mse: number }
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const inputKnown = (row: RoomMeanQuarter) => finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row);
const adjacent = (current: RoomMeanQuarter, next: RoomMeanQuarter) =>
  next.start_ms === current.start_ms + roomIntervalSeconds(current) * 1000;

/** Input-only spans; thermometer gaps remove weight, never reallocate it. */
function operationWeights(rows: readonly RoomMeanQuarter[], evidence: MeasuredCalibrationEvidence): Float64Array {
  const weights = new Float64Array(Math.max(0, rows.length - 1));
  let segment = 0;
  const heated = (index: number) => rows[index].heat_w! > HEATED_SAMPLE_MIN_W;
  const duration = (index: number) => {
    const a = roomIntervalHours(rows[index]), b = roomIntervalHours(rows[index + 1]);
    return 2 * a * b / (a + b);
  };
  while (segment < rows.length) {
    while (segment < rows.length && !inputKnown(rows[segment])) segment++;
    if (segment === rows.length) break;
    let end = segment + 1;
    while (end < rows.length && inputKnown(rows[end]) && adjacent(rows[end - 1], rows[end])) end++;
    let on = segment;
    while (on < end) {
      while (on < end && !heated(on)) on++;
      if (on === end) break;
      let off = on, energyWh = 0;
      while (off < end && heated(off)) {
        energyWh += rows[off].heat_w! * roomIntervalHours(rows[off]);
        off++;
      }
      let nextOn = off;
      while (nextOn < end && !heated(nextOn)) nextOn++;
      const from = Math.max(segment, on - 1), last = nextOn - 1;
      let poweredHours = 0, coastHours = 0;
      for (let i = from; i < last; i++) {
        if (heated(i) || heated(i + 1)) poweredHours += duration(i);
        else coastHours += duration(i);
      }
      if (from < last) evidence.operation_spans++;
      for (let i = from; i < last; i++) {
        const phaseHours = heated(i) || heated(i + 1) ? poweredHours : coastHours;
        weights[i] = energyWh / 1000 * duration(i) / phaseHours;
      }
      on = nextOn;
    }
    segment = end;
  }
  return weights;
}

function nativePairs(rows: readonly RoomMeanQuarter[], evidence: MeasuredCalibrationEvidence) {
  const pairs: Pair[] = [];
  const operation = operationWeights(rows, evidence);
  let low = Infinity, high = -Infinity, lastCounted = -1;
  for (let i = 0; i + 1 < rows.length; i++) {
    const current = rows[i], next = rows[i + 1], missing = evidence.unavailable_pairs;
    if (!adjacent(current, next)) { missing.adjacency++; continue; }
    if (!inputKnown(current) || !inputKnown(next)) { missing.input++; continue; }
    if (!(operation[i] > 0)) { evidence.unanchored_off_pairs++; continue; }
    if (!finite(current.room_c) || !finite(next.room_c)) { missing.room++; continue; }
    if (!finite(current.outdoor_c) || !finite(next.outdoor_c)) { missing.outdoor++; continue; }
    if (!finite(current.house_c) || !finite(next.house_c)) { missing.house++; continue; }
    const off = current.heat_w! <= HEATED_SAMPLE_MIN_W && next.heat_w! <= HEATED_SAMPLE_MIN_W;
    if (off) { evidence.off_pairs++; evidence.weighted_coast_support_kwh += operation[i]; }
    else { evidence.heater_input_pairs++; evidence.weighted_powered_support_kwh += operation[i]; }
    const firstOff = off && i > 0 && adjacent(rows[i - 1], current) && inputKnown(rows[i - 1]) &&
      rows[i - 1].heat_w! > HEATED_SAMPLE_MIN_W;
    if (firstOff) evidence.first_post_off_pairs++;
    for (const at of [i, i + 1]) {
      if (at <= lastCounted) continue;
      const row = rows[at], hours = roomIntervalHours(row);
      evidence.fitted_hours += hours;
      evidence.measured_wh += row.heat_w! * hours;
      if (row.heat_w! > 0) { low = Math.min(low, row.outdoor_c!); high = Math.max(high, row.outdoor_c!); }
      lastCounted = at;
    }
    const h = roomIntervalHours(current), nextH = roomIntervalHours(next);
    // Raw features are compressed separately for the four native duration pairs.
    pairs.push({ kind: (h === .25 ? 0 : 2) + (nextH === .25 ? 0 : 1), firstOff,
      weight: operation[i], values: [next.room_c, current.room_c, current.house_c, next.house_c,
        current.outdoor_c - current.house_c, next.outdoor_c - next.house_c, 1,
        current.heat_w!, next.heat_w!, current.outdoor_c, next.outdoor_c] });
  }
  evidence.fitted_pairs = pairs.length;
  const weather = high > low;
  for (const pair of pairs) {
    // Replace weather by metered weather input. Observed zero watts remain exactly zero.
    pair.values[9] = weather && pair.values[7] > 0 ? pair.values[7] * (pair.values[9] - low) / (high - low) : 0;
    pair.values[10] = weather && pair.values[8] > 0 ? pair.values[8] * (pair.values[10] - low) / (high - low) : 0;
  }
  return { pairs, low, high, weather };
}

function operators(k: number) {
  const intervals = [.25, 1].map(hours => roomMeanObservation(k, 0, hours));
  return intervals.flatMap(current => intervals.map(next => roomMeanPair(current, next)));
}

function equation(values: readonly number[], op: ReturnType<typeof roomMeanPair>, k: number, weather: boolean) {
  const { L, nextForcing: V, alpha } = op;
  return { y: values[0] - alpha * values[1] - k * (L * values[2] + V * values[3]),
    x: [L * values[7] + V * values[8], ...(weather ? [L * values[9] + V * values[10]] : []),
      (L + V) * values[6], L * values[4] + V * values[5]] };
}

function fitPairs(pairs: readonly Pair[], weather: boolean, weights: readonly number[]): Fit | null {
  const work = new MeanFeatureWorkspace(pairs.length, 11);
  pairs.forEach((pair, i) => {
    const weight = Math.sqrt(weights[i]);
    work.add(pair.kind, -1, 0, pair.values.map(value => value * weight));
  });
  const features = work.factor(), gainCount = weather ? 2 : 1;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return finiteProfile(k => {
    const ops = operators(k);
    const terms = features.map(feature => equation(feature.values, ops[feature.kind], k, weather));
    const matrix = terms.map(term => term.x), target = terms.map(term => term.y);
    const scales = matrix[0].map((_, j) => Math.hypot(...matrix.map(row => row[j])));
    const bounds = new Map<number, readonly [number, number]>([[0, [0, Infinity]], [gainCount + 1, [0, k]]]);
    if (weather) bounds.set(1, [0, Infinity]);
    const beta = physicalSolve(matrix, target, scales, bounds);
    if (!beta) return null;
    const error = terms.reduce((sum, term) => sum + (term.y - term.x.reduce((value, x, j) => value + x * beta[j], 0)) ** 2, 0);
    return finite(error) ? { k, beta, mse: error / total } : null;
  });
}

function residuals(pairs: readonly Pair[], fit: Fit, weather: boolean): number[] {
  const ops = operators(fit.k);
  return pairs.map(pair => {
    const term = equation(pair.values, ops[pair.kind], fit.k, weather);
    return term.y - term.x.reduce((sum, value, j) => sum + value * fit.beta[j], 0);
  });
}

/** One finite immediate response. Every actual input remains in the mean-pair balance,
 * including standby electricity during an OFF coast. No peak endpoints or gap fills. */
export function fitMeasuredRoomCalibration(rows: readonly RoomMeanQuarter[], ratedPowerW: number | null): MeasuredRoomCalibrationFit {
  const evidence: MeasuredCalibrationEvidence = { method: "native_operation_response_v1", observation: "interval_mean",
    fitted_pairs: 0, heater_input_pairs: 0, off_pairs: 0,
    unavailable_pairs: { input: 0, room: 0, outdoor: 0, house: 0, adjacency: 0 },
    fitted_hours: 0, measured_wh: 0, residual_degrees_of_freedom: 0, conditional_residual_std_c: null, uncredited_background_w: null,
    operation_spans: 0, unanchored_off_pairs: 0, weighted_powered_support_kwh: 0, weighted_coast_support_kwh: 0,
    first_post_off_pairs: 0, first_post_off_bias_c: null };
  const { pairs, low, high, weather } = nativePairs(rows, evidence);
  const unavailable = (reason: Extract<MeasuredRoomCalibrationFit, { kind: "unidentified" }>["reason"]): MeasuredRoomCalibrationFit =>
    ({ kind: "unidentified", reason, evidence });
  if (!pairs.length) return unavailable("no_native_pairs");
  if (!(evidence.measured_wh > 0)) return unavailable("unidentified_heater");
  // Count total exchange, the outdoor split, background, and each gain coordinate.
  const dof = pairs.length - (weather ? 5 : 4);
  if (!(dof > 0)) return unavailable("rank_deficient");
  const weights = pairs.map(pair => pair.weight);
  let fit = fitPairs(pairs, weather, weights);
  if (!fit) return unavailable("unresolved_exchange");
  for (let pass = 0; pass < 2; pass++) {
    const errors = residuals(pairs, fit, weather);
    const scale = Math.max(Number.EPSILON * 128, robustResidualScale(errors));
    const next = fitPairs(pairs, weather, weights.map((weight, i) => weight * huberWeight(errors[i], scale)));
    if (!next) return unavailable("unresolved_exchange");
    fit = next;
  }
  const gains = weather ? 2 : 1, lowGain = fit.beta[0], delta = weather ? fit.beta[1] : 0;
  const gain = lowGain + delta / 2, reference = (low + high) / 2;
  if (!(gain > 0)) return unavailable("unidentified_heater");
  const errors = residuals(pairs, fit, weather);
  const mse = errors.reduce((sum, error) => sum + error * error, 0) / errors.length;
  evidence.residual_degrees_of_freedom = dof;
  evidence.uncredited_background_w = Math.max(0, fit.beta[gains]) / gain;
  evidence.conditional_residual_std_c = Math.sqrt(mse);
  if (evidence.first_post_off_pairs) evidence.first_post_off_bias_c =
    errors.reduce((sum, error, i) => sum + (pairs[i].firstOff ? error : 0), 0) / evidence.first_post_off_pairs;
  return { kind: "identified", evidence, model: { response_family: "finite", heat_lag_h: 0,
    solar_gain_c_per_h_per_wm2: null, gain_c_per_wh: gain,
    gain_reference_outdoor_c: reference, gain_outdoor_slope_per_c: weather ? delta / ((high - low) * gain) : 0,
    cooling_constant_per_h: fit.beta[gains + 1], house_coupling_per_h: fit.k - fit.beta[gains + 1],
    background_gain_c_per_h: fit.beta[gains], thermal_capacity_wh_per_c: delta === 0 ? 1 / gain : null,
    heat_loss_w_per_c: delta === 0 ? fit.k / gain : null, time_constant_h: 1 / fit.k,
    heating_rate_c_per_h: ratedPowerW !== null && ratedPowerW > 0 ? gain * ratedPowerW : null,
    sample_count: pairs.length, residual_std_c: Math.sqrt(mse), r2: 0, prediction_error_c: null } };
}
