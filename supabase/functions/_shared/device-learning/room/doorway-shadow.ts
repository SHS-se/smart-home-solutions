/** Offline comparison of one steady doorway. This model has no plan consumer. */
import { roomMeanHeat, roomMeanObservation, type RoomMeanQuarter } from "./mean-observations.ts";
import type { DynamicThermalZoneModel as ThermalZoneModel } from "../../planner/models/room/thermal.ts";

export const ROOM_QUARTER_MS = 900_000;
const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

export interface DoorwayObservation extends RoomMeanQuarter {
  /** Measured independently, excluding the target room and its explicit neighbours. */
  rest_of_house_c: number | null;
  neighbour_c: number | null;
}

export type DoorwayFit =
  | { status: "unidentified"; pairs: number; reason: "no_indoor_exchange" | "no_paired_observations" | "no_independent_contrast" }
  | { status: "fitted"; pairs: number; neighbour_per_h: number; rest_of_house_per_h: number; background_c_per_h: number };

interface Moments {
  n: number;
  x: number;
  y: number;
  xx: number;
  xy: number;
}

/**
 * Partition a fixed, previously calibrated indoor exchange between a neighbour
 * and the remaining indoor reference. The comparison re-fits the intercept.
 * Rates describe a response in the receiving room, in °C/h per °C.
 */
export function fitDoorwayShadow(input: readonly DoorwayObservation[], baseline: ThermalZoneModel): DoorwayFit {
  const indoor = baseline.house_coupling_per_h ?? 0;
  if (!(indoor > 0)) return { status: "unidentified", pairs: 0, reason: "no_indoor_exchange" };

  const rows = [...input].sort((a, b) => a.start_ms - b.start_ms);
  const outdoor = baseline.cooling_constant_per_h;
  const sun = baseline.solar_gain_c_per_h_per_wm2 ?? 0;
  const gain = baseline.gain_c_per_wh;
  const op = roomMeanObservation(indoor + outdoor, baseline.heat_lag_h ?? 0);
  const { a, effect, E, V, C, B, U } = op;
  const L = E * effect - a * V;
  const memoryWeight = gain * (E * B - a * U + U * C);
  const all: Moments = { n: 0, x: 0, y: 0, xx: 0, xy: 0 };
  let segment = { zz: 0, z: 0, zx: 0, zy: 0 };
  let delivered = 0;
  let initialShare = 1;
  const finishSegment = () => {
    const { zz, z, zx, zy } = segment;
    if (zz > 0) {
      // Eliminate this segment's unknown initial delivered heat. Meter gaps
      // restart the nuisance state rather than implying that the heater was off.
      all.n -= z * z / zz;
      all.x -= z * zx / zz;
      all.y -= z * zy / zz;
      all.xx -= zx * zx / zz;
      all.xy -= zx * zy / zz;
    }
    segment = { zz: 0, z: 0, zx: 0, zy: 0 };
    delivered = 0;
    initialShare = 1;
  };
  const covered = (q: DoorwayObservation): q is DoorwayObservation &
    Record<"room_c" | "outdoor_c" | "rest_of_house_c" | "neighbour_c" | "heat_w", number> =>
    !q.cooling && finite(q.room_c) && finite(q.outdoor_c) && finite(q.rest_of_house_c) &&
    finite(q.neighbour_c) && finite(q.heat_w) && q.heat_w >= 0 && (!sun || finite(q.solar_w_per_m2));
  let pairs = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    const q = rows[i], next = rows[i + 1];
    if (next.start_ms - q.start_ms !== ROOM_QUARTER_MS || q.cooling || !finite(q.heat_w) || q.heat_w < 0) {
      finishSegment();
      continue;
    }
    if (covered(q) && covered(next)) {
      const x = L * (q.neighbour_c - q.rest_of_house_c) + V * (next.neighbour_c - next.rest_of_house_c);
      const y = next.room_c - a * q.room_c - gain * roomMeanHeat(op, delivered, q.heat_w, next.heat_w) -
        outdoor * (L * q.outdoor_c + V * next.outdoor_c) -
        indoor * (L * q.rest_of_house_c + V * next.rest_of_house_c) -
        sun * (L * (q.solar_w_per_m2 ?? 0) + V * (next.solar_w_per_m2 ?? 0));
      all.n++;
      all.x += x;
      all.y += y;
      all.xx += x * x;
      all.xy += x * y;
      const z = memoryWeight * initialShare;
      segment.zz += z * z;
      segment.z += z;
      segment.zx += z * x;
      segment.zy += z * y;
      pairs++;
    }
    delivered = C * delivered + (1 - C) * q.heat_w;
    initialShare *= C;
  }
  finishSegment();

  if (!pairs) return { status: "unidentified", pairs, reason: "no_paired_observations" };
  const variance = all.xx - all.x * all.x / all.n;
  if (!(all.n > 0) || !(variance > Math.abs(all.xx) * Number.EPSILON * 64) || !Number.isFinite(variance)) {
    return { status: "unidentified", pairs, reason: "no_independent_contrast" };
  }
  const slope = (all.xy - all.x * all.y / all.n) / variance;
  const neighbour = Math.max(0, Math.min(indoor, slope));
  return {
    status: "fitted", pairs, neighbour_per_h: neighbour, rest_of_house_per_h: indoor - neighbour,
    background_c_per_h: (all.y - neighbour * all.x) / all.n / effect,
  };
}

export interface ShadowForecastQuarter {
  start_ms: number;
  outdoor_c: number;
  house_c: number;
  rest_of_house_c: number;
  neighbour_c: number;
  solar_w_per_m2: number;
  heat_w: number;
}

export interface ShadowForecastOrigin {
  /** Start of the first forecast quarter. Time-indexed observations before it are complete. */
  start_ms: number;
  initial_temperature_c: number;
  initial_delivered_w: number;
  /** Weather, indoor boundaries and heater input captured before this forecast began. */
  forecast: readonly ShadowForecastQuarter[];
}

interface ForecastEstimate {
  start_ms: number;
  baseline_c: number;
  doorway_c: number;
}

/** Forecast quarter means for both models from the same state and captured forcing. */
export function projectDoorwayShadow(
  origin: ShadowForecastOrigin, baseline: ThermalZoneModel, fit: Extract<DoorwayFit, {status: "fitted"}>,
): ForecastEstimate[] {
  const indoor = baseline.house_coupling_per_h ?? 0;
  const outdoor = baseline.cooling_constant_per_h;
  const sun = baseline.solar_gain_c_per_h_per_wm2 ?? 0;
  const gain = baseline.gain_c_per_wh;
  const { a, effect, E, V, C, B, U } = roomMeanObservation(indoor + outdoor, baseline.heat_lag_h ?? 0);
  let delivered = origin.initial_delivered_w;
  let baselineState = origin.initial_temperature_c;
  let doorwayState = baselineState;
  const estimates: ForecastEstimate[] = [];
  for (const q of origin.forecast) {
    if (q.start_ms !== origin.start_ms + estimates.length * ROOM_QUARTER_MS ||
        ![q.heat_w, q.solar_w_per_m2, q.outdoor_c, q.house_c, q.rest_of_house_c, q.neighbour_c].every(finite)) break;
    const common = outdoor * q.outdoor_c + sun * q.solar_w_per_m2;
    const baselineForcing = common + indoor * q.house_c + baseline.background_gain_c_per_h;
    const doorwayForcing = common + fit.rest_of_house_per_h * q.rest_of_house_c +
      fit.neighbour_per_h * q.neighbour_c + fit.background_c_per_h;
    const meanHeat = gain * (U * delivered + (V - U) * q.heat_w);
    const endHeat = gain * (B * delivered + (effect - B) * q.heat_w);
    estimates.push({ start_ms: q.start_ms,
      baseline_c: E * baselineState + V * baselineForcing + meanHeat,
      doorway_c: E * doorwayState + V * doorwayForcing + meanHeat });
    baselineState = a * baselineState + effect * baselineForcing + endHeat;
    doorwayState = a * doorwayState + effect * doorwayForcing + endHeat;
    delivered = C * delivered + (1 - C) * q.heat_w;
  }
  return estimates;
}
