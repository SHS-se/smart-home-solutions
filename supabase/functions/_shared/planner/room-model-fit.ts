// Fitting a room from its measured quarters, and judging the fit by what the
// planner does with it: run it forward 12 hours.
//
// Two shapes compete. The outdoor-coupled 1R1C zone (thermal-model.ts) is the
// original. The house-coupled shape replaces outdoor air with the house the
// room sits in, and lets heater heat arrive through a first-order delay:
//
//   dT/dt = g·D̄ + k_house·(T_house − T) + s·I + c
//
// where D̄ is the quarter's mean delayed heat. On the reference bathroom
// (October 2026, each day fitted only on the days before it) this predicted
// the room 12 hours ahead with half the error of the outdoor shape: the room
// settles toward the house within hours and follows it when the house's own
// heating switches off at night, and its floor keeps warming it for hours
// after the power stops. Outdoor air, against a 13-day fitted time constant,
// explained neither.
//
// The delay is not a regression coefficient: each candidate is fitted by least
// squares and the one that best predicts 12 hours ahead over the window wins.
// The published shape is whichever of the two predicts better, so a home
// without a house temperature, or a room the house does not explain, keeps
// what it had.

import {
  accumulateMoments,
  fitThermalZoneFromMoments,
  HEATED_SAMPLE_MIN_W,
  MIN_HEATED_SAMPLES,
  MIN_SOLAR_COVERAGE,
  MIN_TRAINING_SAMPLES,
  type RoomState,
  roomTransition,
  SLOT_HOURS,
  solveLinearSystem,
  stepRoom,
  type ThermalFitRejection,
  type ThermalFitResult,
  type ThermalTrainingSample,
  type ThermalZoneModel,
  backgroundRateForSlot,
} from "./thermal-model.ts";

/** One measured quarter of a room. */
export interface RoomTrainingQuarter {
  start_ms: number;
  room_c: number | null;
  outdoor_c: number | null;
  house_c: number | null;
  solar_w_per_m2: number | null;
  /** Mean power of the room's planned heaters, W. */
  heat_w: number;
  /** A quarter spent cooling teaches the heating model nothing. */
  cooling: boolean;
}

/** Candidate delays, hours. Zero keeps heat immediate. */
export const HEAT_LAG_GRID_H = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5];
/** How far ahead a fit is judged: about the longest Comfort preheat. */
export const PREDICTION_HORIZON_QUARTERS = 48;
/** Judged from a start every this many quarters. */
const PREDICTION_STRIDE_QUARTERS = 8;
/** A house-coupled room predicting worse than this is flagged a poor fit. */
export const MAX_PREDICTION_ERROR_C = 0.5;
const QUARTER_MS = 900_000;

const finite = (value: number | null): value is number => typeof value === "number" && Number.isFinite(value);

/** Quarters on one contiguous grid; a missing quarter is a row of nulls. */
function grid(quarters: RoomTrainingQuarter[]): RoomTrainingQuarter[] {
  const sorted = [...quarters].sort((a, b) => a.start_ms - b.start_ms);
  if (sorted.length === 0) return [];
  const first = sorted[0].start_ms, last = sorted.at(-1)!.start_ms;
  const byStart = new Map(sorted.map(quarter => [quarter.start_ms, quarter]));
  const rows: RoomTrainingQuarter[] = [];
  for (let at = first; at <= last; at += QUARTER_MS) {
    rows.push(byStart.get(at) ?? { start_ms: at, room_c: null, outdoor_c: null, house_c: null,
      solar_w_per_m2: null, heat_w: 0, cooling: false });
  }
  return rows;
}

/** The fit's quarters: a measured start and end, no cooling. */
const trainable = (rows: RoomTrainingQuarter[], k: number) =>
  k + 1 < rows.length && finite(rows[k].room_c) && finite(rows[k + 1].room_c) && !rows[k].cooling;

/**
 * Mean 12-hour error of `model` run from measured starts with measured inputs.
 * Null when no start has a measured 12 hours ahead of it.
 */
export function predictionError(model: ThermalZoneModel, quarters: RoomTrainingQuarter[]): number | null {
  const rows = grid(quarters);
  const lag = model.heat_lag_h ?? 0;
  const carry = lag > 0 ? Math.exp(-SLOT_HOURS / lag) : 0;
  const solar = rows.map(row => row.solar_w_per_m2);
  // The delayed heat each quarter starts with, from the measured history.
  const delivered: number[] = [];
  let heat = 0;
  for (const row of rows) { delivered.push(heat); heat = carry * heat + (1 - carry) * row.heat_w; }
  const errors: number[] = [];
  for (let start = 0; start + PREDICTION_HORIZON_QUARTERS < rows.length; start += PREDICTION_STRIDE_QUARTERS) {
    const end = rows[start + PREDICTION_HORIZON_QUARTERS].room_c;
    if (!finite(rows[start].room_c) || !finite(end)) continue;
    let state: RoomState = { temperature_c: rows[start].room_c!, delivered_w: delivered[start] };
    let complete = true;
    for (let k = start; k < start + PREDICTION_HORIZON_QUARTERS && complete; k++) {
      const row = rows[k];
      if (!finite(row.outdoor_c) || (model.house_coupling_per_h && !finite(row.house_c))) { complete = false; break; }
      state = stepRoom(roomTransition(model, { hours: SLOT_HOURS, outdoor_c: row.outdoor_c!, house_c: row.house_c,
        background_c_per_h: backgroundRateForSlot(model, k, solar) }), state, row.heat_w);
    }
    if (complete) errors.push(Math.abs(state.temperature_c - end));
  }
  return errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;
}

/** The outdoor-coupled zone, fitted exactly as the SQL moments always fitted it. */
function fitOutdoor(rows: RoomTrainingQuarter[], ratedPowerW: number | null): ThermalFitResult {
  const samples: ThermalTrainingSample[] = [];
  for (let k = 0; k < rows.length; k++) {
    if (!trainable(rows, k) || !finite(rows[k].outdoor_c)) continue;
    samples.push({ room_temperature_c: rows[k].room_c!, next_room_temperature_c: rows[k + 1].room_c!,
      outdoor_temperature_c: rows[k].outdoor_c!, heat_input_w: rows[k].heat_w, solar_w_per_m2: rows[k].solar_w_per_m2 });
  }
  return fitThermalZoneFromMoments(accumulateMoments(samples), ratedPowerW);
}

interface HouseFit { model: ThermalZoneModel; warnings: ThermalFitRejection[]; error: number }

/** The house-coupled zone at one delay, by least squares on the rate of change. */
function fitHouseAtLag(rows: RoomTrainingQuarter[], lag: number, ratedPowerW: number | null,
  useSolar: boolean): Omit<HouseFit, "error"> | null {
  const carry = lag > 0 ? Math.exp(-SLOT_HOURS / lag) : 0;
  const share = lag > 0 ? lag / SLOT_HOURS * -Math.expm1(-SLOT_HOURS / lag) : 0;
  // Columns: mean delayed heat, house difference, [irradiance], constant.
  const size = useSolar ? 4 : 3;
  const xtx = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const xty = new Array<number>(size).fill(0);
  let yy = 0, sy = 0, n = 0, heated = 0, delivered = 0;
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k];
    const mean = share * delivered + (1 - share) * row.heat_w;
    delivered = carry * delivered + (1 - carry) * row.heat_w;
    if (!trainable(rows, k) || !finite(row.house_c) || (useSolar && !finite(row.solar_w_per_m2))) continue;
    const x = [mean, row.house_c! - row.room_c!, ...(useSolar ? [row.solar_w_per_m2!] : []), 1];
    const y = (rows[k + 1].room_c! - row.room_c!) / SLOT_HOURS;
    for (let i = 0; i < size; i++) {
      xty[i] += x[i] * y;
      for (let j = 0; j < size; j++) xtx[i][j] += x[i] * x[j];
    }
    yy += y * y; sy += y; n++;
    if (row.heat_w > HEATED_SAMPLE_MIN_W) heated++;
  }
  if (n < MIN_TRAINING_SAMPLES) return null;
  const beta = solveLinearSystem(xtx, xty);
  if (!beta || !beta.every(Number.isFinite)) return null;
  const [gain, coupling] = beta, solar = useSolar ? beta[2] : null, background = beta[size - 1];
  if (!(gain > 0) || !(coupling > 0) || (solar !== null && !(solar >= 0))) return null;
  let residual = yy;
  for (let i = 0; i < size; i++) {
    residual -= 2 * beta[i] * xty[i];
    for (let j = 0; j < size; j++) residual += beta[i] * beta[j] * xtx[i][j];
  }
  const total = yy - sy * sy / n;
  const r2 = total > 0 ? 1 - residual / total : 0;
  const warnings: ThermalFitRejection[] = [];
  if (heated < MIN_HEATED_SAMPLES) warnings.push("insufficient_heating");
  const capacity = 1 / gain;
  let solarSum = 0, solarCount = 0;
  if (useSolar) for (const row of rows) if (finite(row.solar_w_per_m2)) { solarSum += row.solar_w_per_m2; solarCount++; }
  return {
    warnings,
    model: {
      gain_c_per_wh: gain, cooling_constant_per_h: 0, background_gain_c_per_h: background,
      solar_gain_c_per_h_per_wm2: solar, solar_mean_w_per_m2: solar === null ? null : solarSum / Math.max(1, solarCount),
      thermal_capacity_wh_per_c: capacity, heat_loss_w_per_c: coupling * capacity, time_constant_h: 1 / coupling,
      heating_rate_c_per_h: ratedPowerW && ratedPowerW > 0 ? gain * ratedPowerW : null,
      r2, sample_count: n, residual_std_c: Math.sqrt(Math.max(residual, 0) / n) * SLOT_HOURS,
      heat_lag_h: lag, house_coupling_per_h: coupling,
    },
  };
}

function fitHouse(rows: RoomTrainingQuarter[], ratedPowerW: number | null): HouseFit | null {
  let usable = 0, withHouse = 0, withSun = 0;
  for (let k = 0; k < rows.length; k++) {
    if (!trainable(rows, k)) continue;
    usable++;
    if (finite(rows[k].house_c)) {
      withHouse++;
      if (finite(rows[k].solar_w_per_m2)) withSun++;
    }
  }
  // The same rule as the sun: fit on the covered part only when it is most
  // of the window, so the house shape never describes a slice of it.
  if (withHouse < MIN_TRAINING_SAMPLES || withHouse < usable * MIN_SOLAR_COVERAGE) return null;
  const useSolar = withSun >= MIN_TRAINING_SAMPLES && withSun >= withHouse * MIN_SOLAR_COVERAGE;
  let best: HouseFit | null = null;
  for (const lag of HEAT_LAG_GRID_H) {
    // Sunshine cannot cool a room: a negative sun term falls back to none.
    const fit = (useSolar ? fitHouseAtLag(rows, lag, ratedPowerW, true) : null) ??
      fitHouseAtLag(rows, lag, ratedPowerW, false);
    if (!fit) continue;
    const error = predictionError(fit.model, rows);
    if (error === null) continue;
    if (!best || error < best.error) best = { ...fit, error };
  }
  return best;
}

/**
 * Fit a room from its quarters and publish the shape that predicts it better.
 *
 * The outdoor shape is always fitted, with its old rules and warnings, so a
 * home that never sends a house temperature is unchanged. The house shape
 * replaces it only when it is physical and predicts the window better.
 */
export function fitRoom(quarters: RoomTrainingQuarter[], ratedPowerW: number | null = null): ThermalFitResult {
  const rows = grid(quarters);
  const outdoor = fitOutdoor(rows, ratedPowerW);
  const outdoorError = outdoor.ok ? predictionError(outdoor.model, rows) : null;
  const house = fitHouse(rows, ratedPowerW);
  if (house && (outdoorError === null || house.error < outdoorError)) {
    const warnings = [...house.warnings];
    if (house.error > MAX_PREDICTION_ERROR_C) warnings.push("poor_fit");
    return { ok: true, ...(warnings.length ? { warnings } : {}),
      model: { ...house.model, prediction_error_c: house.error } };
  }
  if (!outdoor.ok) return outdoor;
  return { ...outdoor, model: { ...outdoor.model, prediction_error_c: outdoorError } };
}

