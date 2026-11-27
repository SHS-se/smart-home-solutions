/** Capture-time room state from native mean observations and received inputs.
 * No fitting, database reads, command selection or persisted synthetic telemetry. */
import type { OptimisationSnapshot } from "../../planning-contracts.ts";
import { roomMeanObservation } from "./observation.ts";
import { type DynamicThermalZoneModel, type RoomState, roomHeaterGain, roomTransition, stepRoom } from "./thermal.ts";

const HOUR_MS = 3_600_000;
const SLOT_MS = 900_000;

/** One frozen clock for the selected and literal-comfort trajectories. */
export function roomPlanClock(snapshot: Pick<OptimisationSnapshot, "captured_at" | "slots">): {
  start_ms: number; hours: number[];
} {
  const captured = Date.parse(snapshot.captured_at);
  const start_ms = Math.max(captured, snapshot.slots.length ? Date.parse(snapshot.slots[0].start) : captured);
  return { start_ms, hours: snapshot.slots.map(slot =>
    Math.max(0, Date.parse(slot.start) + SLOT_MS - Math.max(start_ms, Date.parse(slot.start))) / HOUR_MS) };
}

export interface RoomStateReading { start_ms: number; end_ms: number; mean_c: number }
export interface RoomStateInterval {
  start_ms: number;
  end_ms: number;
  heater_w: number | null;
  outdoor_c: number | null;
  house_c?: number | null;
  solar_w_per_m2?: number | null;
}
export interface RoomStateHistory {
  reading: RoomStateReading;
  intervals: readonly RoomStateInterval[];
  /** Available boundary estimates, not asserted physical lower bounds. A house
   * evaluator receives the actual uncovered span and retains estimate provenance. */
  fallback: { outdoor_c: number; house_c: number | ((span: { start_ms: number; end_ms: number }) => number); solar_w_per_m2?: number };
}
type Span = { start_ms: number; end_ms: number };
type Boundary = "outdoor_c" | "house_c" | "solar_w_per_m2";
export interface EstimatedRoomState extends RoomState {
  observed_through: number;
  missing_power: Span[];
  estimated_boundary: (Span & { fields: Boundary[] })[];
  /** Unobserved heat before the received history has no useful-heat credit. */
  estimated_initial_heat: boolean;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Fill only actual gaps, then coalesce identical inputs. Work scales with the
 * received history, never the number of quarters in a missing span. */
function historySpans(history: readonly RoomStateInterval[], from: number, to: number, estimateIndoor = false): RoomStateInterval[] {
  const result: RoomStateInterval[] = [];
  const append = (row: RoomStateInterval) => {
    const last = result.at(-1);
    // A missing indoor value may be evaluated from different native peer means
    // in adjacent intervals. Do not erase those source boundaries by coalescing.
    if (last && (!estimateIndoor || finite(last.house_c) && finite(row.house_c)) && last.end_ms === row.start_ms && last.heater_w === row.heater_w &&
      last.outdoor_c === row.outdoor_c && last.house_c === row.house_c && last.solar_w_per_m2 === row.solar_w_per_m2) {
      last.end_ms = row.end_ms;
    } else result.push(row);
  };
  let at = from;
  for (const row of history) {
    const start = Math.max(at, row.start_ms), end = Math.min(to, row.end_ms);
    if (end <= start) continue;
    if (start > at) append({ start_ms: at, end_ms: start, heater_w: null, outdoor_c: null });
    append({ ...row, start_ms: start, end_ms: end });
    at = end;
  }
  if (at < to) append({ start_ms: at, end_ms: to, heater_w: null, outdoor_c: null });
  return result;
}

/** Condition the native mean, then advance to the capture instant. Missing
 * heater input receives zero useful-heat credit, not a measured-idle label.
 * For a constant interval, rho=a/E and the conditioned endpoint coefficients
 * are B-rho*U (initial release), effect-B-rho*(V-U) (heater), and
 * effect-rho*V (boundary forcing). They are nonnegative for k,lag >= 0.
 * Composition below uses that same integral/endpoint map for varying inputs.
 * Boundary estimates remain estimates: no absolute physical bound is claimed.
 */
export function estimateRoomState(model: DynamicThermalZoneModel, input: RoomStateHistory, toMs: number): EstimatedRoomState {
  const reading = input.reading, lag = model.heat_lag_h ?? 0;
  const house = model.house_coupling_per_h ?? 0, solar = model.solar_gain_c_per_h_per_wm2 ?? 0;
  const coupling = model.cooling_constant_per_h + house;
  if (![reading.start_ms, reading.end_ms, reading.mean_c, toMs, coupling, lag,
    model.gain_c_per_wh, model.background_gain_c_per_h, solar].every(Number.isFinite) ||
    reading.end_ms < reading.start_ms || coupling < 0 || lag < 0) throw new Error("Malformed room state inputs");
  const history = input.intervals.filter(row => finite(row.start_ms) && finite(row.end_ms) && row.end_ms > row.start_ms)
    .slice().sort((a, b) => a.start_ms - b.start_ms);
  const estimateIndoor = typeof input.fallback.house_c === "function";
  const missing_power: Span[] = [], estimated_boundary: EstimatedRoomState["estimated_boundary"] = [];
  const missing = (row: Span) => {
    const last = missing_power.at(-1);
    if (last?.end_ms === row.start_ms) last.end_ms = row.end_ms;
    else missing_power.push({ start_ms: row.start_ms, end_ms: row.end_ms });
  };
  const conditions = (row: RoomStateInterval, memoryOnly = false, record = true) => {
    const fields: Boundary[] = [];
    const boundary = (field: Boundary, needed: boolean): number => {
      if (finite(row[field])) return row[field];
      if (!needed) return 0;
      const fallback = input.fallback[field];
      const value = typeof fallback === "function" ? fallback(row) : fallback;
      if (!finite(value)) throw new Error(`Room state needs an available ${field} estimate`);
      fields.push(field);
      return value;
    };
    const outdoor_c = boundary("outdoor_c", (!memoryOnly && model.cooling_constant_per_h > 0) || (model.gain_outdoor_slope_per_c ?? 0) !== 0);
    const house_c = boundary("house_c", !memoryOnly && house > 0);
    const irradiance = boundary("solar_w_per_m2", !memoryOnly && solar !== 0);
    if (record && fields.length) {
      const last = estimated_boundary.at(-1);
      if (last?.end_ms === row.start_ms && last.fields.join() === fields.join()) last.end_ms = row.end_ms;
      else estimated_boundary.push({ start_ms: row.start_ms, end_ms: row.end_ms, fields });
    }
    if (record && !finite(row.heater_w)) missing(row);
    // A boundary estimate must not give unmeasured variable-gain heat credit.
    const watts = finite(row.heater_w) && (finite(row.outdoor_c) || !(model.gain_outdoor_slope_per_c ?? 0))
      ? Math.max(0, row.heater_w) : 0;
    return { hours: (row.end_ms - row.start_ms) / HOUR_MS, outdoor_c, house_c,
      background_c_per_h: model.background_gain_c_per_h + solar * irradiance, watts };
  };

  let heat = 0;
  if (lag > 0) {
    const from = Math.min(reading.start_ms, history[0]?.start_ms ?? reading.start_ms);
    for (const row of historySpans(history, from, reading.start_ms)) {
      const c = conditions(row, true), carry = Math.exp(-c.hours / lag);
      heat = carry * heat + roomHeaterGain(model, row.outdoor_c) * lag * -Math.expm1(-c.hours / lag) * c.watts;
    }
  }

  // Affine endpoint and integral relative to unknown entry temperature. Q is
  // independently reconstructed; a room mean never invents floor energy.
  let state: RoomState = { temperature_c: 0, stored_heat_c: heat };
  let decay = 1, integralDecay = 0, integralOffset = 0;
  const observationSpans = historySpans(history, reading.start_ms, reading.end_ms, estimateIndoor);
  for (const row of observationSpans) {
    const c = conditions(row), op = roomMeanObservation(coupling, lag, c.hours);
    const forcing = model.cooling_constant_per_h * c.outdoor_c + house * c.house_c + c.background_c_per_h;
    const heating = roomHeaterGain(model, c.outdoor_c) * c.watts;
    integralDecay += c.hours * op.E * decay;
    integralOffset += c.hours * (op.E * state.temperature_c +
      (lag > 0 ? op.U * state.stored_heat_c / lag : 0) + (op.V - op.U) * heating + op.V * forcing);
    state = stepRoom(roomTransition(model, c), state, c.watts);
    decay *= op.a;
  }
  const duration = (reading.end_ms - reading.start_ms) / HOUR_MS;
  const meanDecay = duration > 0 ? integralDecay / duration : 1;
  const meanOffset = duration > 0 ? integralOffset / duration : 0;
  const rho = decay / meanDecay;
  state.temperature_c += rho * (reading.mean_c - meanOffset);

  if (toMs < reading.end_ms) {
    // Future provenance is not an admission error. Infer entry and advance only
    // to the requested instant; before entry, retain that estimate without
    // reversing dissipative dynamics or relabeling the observation timestamp.
    state = { temperature_c: (reading.mean_c - meanOffset) / meanDecay, stored_heat_c: heat };
    for (const row of historySpans(history, reading.start_ms, Math.max(reading.start_ms, toMs), estimateIndoor)) {
      const c = conditions(row, false, false);
      state = stepRoom(roomTransition(model, c), state, c.watts);
    }
  } else {
    for (const row of historySpans(history, reading.end_ms, toMs, estimateIndoor)) {
      const c = conditions(row);
      state = stepRoom(roomTransition(model, c), state, c.watts);
    }
  }
  if (!finite(state.temperature_c) || !finite(state.stored_heat_c)) throw new Error("Room state could not be reconstructed from its model");
  return { ...state, observed_through: reading.end_ms, missing_power, estimated_boundary, estimated_initial_heat: lag > 0 };
}
