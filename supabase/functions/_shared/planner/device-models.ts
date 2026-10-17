// Device models: what a device can be told to do, and what it then does.
//
// One set, used by the planner and by everything that judges a plan (the bench
// referee and its audit import this file from the planner folder). The numbers
// in a model are data: they arrive with the household or the snapshot, and
// nothing here states one.
//
// A leaf module: it imports nothing, so a caller that needs only the models
// does not take the planner with it.

/** A car charger set in amps, the same on every phase. */
export interface ChargerModel {
  voltage_v: number;
  phase_count: number;
  /** The lowest current it can hold; below it the charger is off. */
  min_current_a: number;
  max_current_a: number;
  /** The increment between the two, A. */
  current_step_a: number;
}

/** One command a device can carry out for a quarter. */
export interface Level {
  /** The command in the device's own unit (a charger: amps). Zero is off. */
  setting: number;
  /** What it draws there, W. */
  draw_w: number;
}

/** Everything a device can be told, off first, by rising draw. */
export type Levels<L extends Level = Level> = readonly [L, ...L[]];

export class DeviceModelError extends Error {}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Off, then every current from the lowest to the highest the charger holds. */
export function chargerLevels(model: ChargerModel): Levels {
  const { voltage_v, phase_count, min_current_a, max_current_a, current_step_a } = model;
  if (![voltage_v, phase_count, min_current_a, max_current_a, current_step_a].every(value => finite(value) && value > 0)) {
    throw new DeviceModelError("A charger needs a positive voltage, phase count, current range and step.");
  }
  const steps = (max_current_a - min_current_a) / current_step_a;
  if (steps < 0 || Math.abs(steps - Math.round(steps)) > 1e-9) {
    throw new DeviceModelError("A charger's current range must be a whole number of steps.");
  }
  const levels: [Level, ...Level[]] = [{ setting: 0, draw_w: 0 }];
  for (let step = 0; step <= Math.round(steps); step++) {
    const amps = min_current_a + step * current_step_a;
    levels.push({ setting: amps, draw_w: amps * voltage_v * phase_count });
  }
  return levels;
}

/** What a device does when asked for a power: the level it runs at, and how much of the request that leaves out. */
export interface Carried<L extends Level = Level> {
  run: L;
  /** Asked for and not drawn, W; zero when the request is a level. */
  refused_w: number;
}

/**
 * The highest level that draws no more than was asked. A device cannot run
 * between two of its levels, so a request there is carried out at the lower
 * one, and a request below its lowest running level not at all. `toleranceW`
 * is how far above a level a request may sit and still be that level.
 */
export function carryOut<L extends Level>(levels: Levels<L>, wantedW: number, toleranceW = 0): Carried<L> {
  let run = levels[0];
  for (const level of levels) if (level.draw_w <= wantedW + toleranceW) run = level;
  return { run, refused_w: Math.max(0, wantedW - run.draw_w) };
}

// ---------------------------------------------------------------------------
// Stores

/** Water's specific heat capacity, kWh per m³ per °C. */
export const WATER_KWH_PER_M3_K = 1.163;

export interface BatteryModel {
  capacity_kwh: number;
  min_soc: number;
  max_soc: number;
  charge_max_w: number;
  discharge_max_w: number;
  charge_efficiency: number;
  discharge_efficiency: number;
}

export interface CarBatteryModel {
  capacity_kwh: number;
  kwh_per_km: number;
  charge_efficiency: number;
}

/** How an unheated store's temperature falls. */
export type StandingLoss =
  /** Heat lost per degree the store is above its surroundings; `surroundings_c` null is the outdoor air. */
  | { kind: "linear"; kw_per_c: number; surroundings_c: number | null }
  /** The unheated store's measured rate by its own temperature, °C per hour; `at_c` rising. */
  | { kind: "measured"; points: { at_c: number; c_per_h: number }[] };

export interface ThermalStoreModel {
  capacity_kwh_per_c: number;
  /** Learned heat-to-water response time; zero is direct transfer. */
  response_time_constant_h: number;
  loss: StandingLoss;
}

/** Heat inferred to be in transit survives both shutdown and replanning. */
export interface PoolThermalState { water_c: number; pending_heat_kwh: number }

export const poolInventoryC = (store: ThermalStoreModel, waterC: number, pendingHeatKwh: number): number =>
  waterC + pendingHeatKwh / store.capacity_kwh_per_c;

/** 1-exp(-x), using identical IEEE arithmetic in TS, native Rust and Wasm.
 * Platform transcendental libraries differ by ulps, which can change solver
 * decisions. Reduce to x<=1/8, evaluate expm1's convergent series, then double. */
function poolResponseRelease(x: number): number {
  if (x >= 40) return 1;
  let reduced = x, doublings = 0;
  while (reduced > 0.125) { reduced /= 2; doublings++; }
  let term = -reduced, sum = term;
  for (let n = 2; n <= 16; n++) { term *= -reduced / n; sum += term; }
  let released = -sum;
  for (let n = 0; n < doublings; n++) released *= 2 - released;
  return released;
}

/** Exact reservoir response to linear heat input with this interval's standing loss. */
function transferPoolHeat(store: ThermalStoreModel, state: PoolThermalState, heatStartW: number, slopeWPerH: number, hours: number, coolingCPerH: number): PoolThermalState {
  const tau = store.response_time_constant_h;
  const supplied = (heatStartW * hours + slopeWPerH * hours * hours / 2) / 1_000;
  const released = tau > 0 ? poolResponseRelease(hours / tau) : 1;
  const x = tau > 0 ? hours / tau : 0;
  // Endpoint weights stay nonnegative even for a descending heat ramp. The
  // series evaluates 1-(1-exp(-x))/x without cancellation in tiny intervals.
  const endWeight = x < 1e-4 ? x * (0.5 + x * (-1 / 6 + x * (1 / 24 - x / 120))) : 1 - released / x;
  const pending = tau > 0 ? state.pending_heat_kwh * (1 - released) + tau / 1_000 *
    (heatStartW * (released - endWeight) + (heatStartW + slopeWPerH * hours) * endWeight) : 0;
  return { water_c: state.water_c + (state.pending_heat_kwh + supplied - pending) / store.capacity_kwh_per_c + coolingCPerH * hours,
    pending_heat_kwh: pending };
}

/** The complete heat-transfer state after linearly changing input, including an off-tail. */
export function stepPoolThermal(store: ThermalStoreModel, state: PoolThermalState, heatStartW: number, heatEndW: number, outdoorC: number, hours: number): PoolThermalState {
  if (hours === 0) return { ...state };
  return transferPoolHeat(store, state, heatStartW, (heatEndW - heatStartW) / hours, hours, idleCPerHour(store, state.water_c, outdoorC));
}

/** What an unheated store's temperature changes by in an hour, °C. Never a warming from a measured rate. */
export function idleCPerHour(store: ThermalStoreModel, storeC: number, outdoorC: number): number {
  const { loss } = store;
  if (loss.kind === "linear") return -loss.kw_per_c * (storeC - (loss.surroundings_c ?? outdoorC)) / store.capacity_kwh_per_c;
  const { points } = loss, last = points.length - 1;
  // Between two measured temperatures the line between them; beyond the outermost, the outermost.
  let rate = storeC <= points[0].at_c ? points[0].c_per_h : points[last].c_per_h;
  for (let i = 1; i <= last && storeC > points[0].at_c; i++) {
    if (storeC <= points[i].at_c) {
      const low = points[i - 1], high = points[i];
      rate = low.c_per_h + (high.c_per_h - low.c_per_h) * (storeC - low.at_c) / (high.at_c - low.at_c);
      break;
    }
  }
  return Math.min(0, rate);
}

/** A store's temperature after `hours` with `heatW` of heat going into it. */
export function stepThermalStore(store: ThermalStoreModel, storeC: number, heatW: number, outdoorC: number, hours: number): number {
  return storeC + (heatW / 1_000 / store.capacity_kwh_per_c + idleCPerHour(store, storeC, outdoorC)) * hours;
}

/**
 * Hours for the store to lose 63 % of a surplus of heat at this temperature;
 * Infinity where it does not cool faster the warmer it is. For estimates of
 * what heat put in at one time is still there at another.
 */
export function thermalTimeConstantH(store: ThermalStoreModel, storeC: number, outdoorC: number): number {
  const perDegree = idleCPerHour(store, storeC, outdoorC) - idleCPerHour(store, storeC + 1, outdoorC);
  return perDegree > 1e-12 ? 1 / perDegree : Infinity;
}

// ---------------------------------------------------------------------------
// Heat pump

/** One steady state the machine was measured at. Its COP is `heat_w / electric_w`: derived, never stated. */
export interface OperatingPoint {
  /** The machine's own setting there, in `setting_unit`. */
  setting: number;
  /** Compressor electricity, W. */
  electric_w: number;
  /** Heat delivered to the store, W. */
  heat_w: number;
}

export interface HeatPumpModel {
  /** What the setting counts, in words (the S1256 pool function: kW of heat asked for). */
  setting_unit: string;
  /** The machine's measured states, by rising setting and rising electricity. */
  operating_points: OperatingPoint[];
  /** The setting it runs at when on. */
  selected_setting: number;
  /** `switch`: the planner turns it on and off at the selected setting. */
  control: "switch";
  /** Draw of what must run with it and heats nothing (a circulation pump), W. */
  auxiliary_w: number;
  /** Explicit transient response where the device has one; static operating points describe steady operation. */
  response?: HeatPumpResponse;
}

/** Provenance describes the measurement, rather than changing its physical response. */
export interface HeatPumpResponseEvidence {
  source: string;
  observed_start: string;
  heat_basis: string;
  heat_flow_measured: boolean;
  steady_compressor_w?: number;
  steady_delta_c?: number;
  sample_count?: number;
}

export interface HeatPumpStartupPoint {
  elapsed_seconds: number;
  electric_fraction: number;
  heat_fraction: number;
}

export type HeatPumpResponse =
  | { kind: "steady" }
  | { kind: "bergvarme"; startup: HeatPumpStartupPoint[]; evidence?: HeatPumpResponseEvidence };

/** Native command memory, owned by the device rather than the scheduler. */
export type HeaterState =
  | { kind: "off_unobserved" }
  | { kind: "off"; seconds: number }
  | { kind: "running"; seconds: number }
  | { kind: "steady" };
export interface HeaterStart { off_seconds: number | null }
export interface PublishedHeater {
  compressor_w: number; auxiliary_w: number; heat_w: number; response: HeatPumpResponse;
}

export function parseHeaterState(input: unknown): HeaterState {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DeviceModelError("Heater state is missing.");
  const state = input as Record<string, unknown>;
  if (state.kind === "off_unobserved" || state.kind === "steady") return { kind: state.kind };
  if ((state.kind === "off" || state.kind === "running") && finite(state.seconds) && state.seconds >= 0) {
    return { kind: state.kind, seconds: state.seconds };
  }
  throw new DeviceModelError("Heater state needs an explicit kind and nonnegative elapsed seconds.");
}

/** One immutable solver publication; missing dynamics never silently become steady. */
export function publishHeater(model: HeatPumpModel): PublishedHeater {
  const run = operatingPoint(model, model.selected_setting);
  return {
    compressor_w: run.electric_w, auxiliary_w: model.auxiliary_w, heat_w: run.heat_w,
    response: parseHeaterResponse(model.response),
  };
}

/** Electrical/thermal response and command events come from the same device step. */
export function stepHeater(heater: PublishedHeater, state: HeaterState, on: boolean, seconds: number): {
  electric_w: number; compressor_w: number; auxiliary_w: number; heat_w: number; next: HeaterState; start: HeaterStart | null;
} {
  const age = state.kind === "steady" ? Infinity : state.kind === "running" ? state.seconds : null;
  const projected = projectHeatPumpResponse(heater.response, heater,
    [on ? heater.compressor_w + heater.auxiliary_w : 0], [seconds / 3600], age);
  const start = on && age === null ? { off_seconds: state.kind === "off" ? state.seconds : null } : null;
  const next: HeaterState = on
    ? state.kind === "steady" ? { kind: "steady" } : { kind: "running", seconds: (age ?? 0) + seconds }
    : state.kind === "off_unobserved" ? { kind: "off_unobserved" }
      : { kind: "off", seconds: (state.kind === "off" ? state.seconds : 0) + seconds };
  const auxiliary_w = on ? heater.auxiliary_w : 0;
  return { electric_w: projected.draw_w[0], compressor_w: projected.draw_w[0] - auxiliary_w,
    auxiliary_w, heat_w: heater.heat_w * projected.gain_fraction[0], next, start };
}

export interface PoolConditions extends PoolThermalState { outdoor_c: number; seconds: number; stop_c: number | null }
export interface PoolTransition extends PoolThermalState {
  electric_w: number; compressor_w: number; auxiliary_w: number; heat_w: number; next: HeaterState; start: HeaterStart | null;
}

/** First crossing on monotone temperature pieces, including an interior peak. */
function firstPoolStop(store: ThermalStoreModel, state: PoolThermalState, heatStartW: number, slopeWPerH: number, hours: number, cooling: number, stopC: number): number | null {
  if (state.water_c >= stopC) return 0;
  const tau = store.response_time_constant_h;
  const at = (h: number) => transferPoolHeat(store, state, heatStartW, slopeWPerH, h, cooling);
  const derivative = (h: number) => tau > 0 ? at(h).pending_heat_kwh / tau / store.capacity_kwh_per_c + cooling
    : (heatStartW + slopeWPerH * h) / 1_000 / store.capacity_kwh_per_c + cooling;
  const bisect = (fn: (h: number) => number, from: number, to: number) => {
    let low = from, high = to, value = fn(low);
    for (let i = 0; i < 48; i++) {
      const mid = (low + high) / 2, next = fn(mid);
      if (next === 0) return mid;
      if (Math.sign(next) === Math.sign(value)) { low = mid; value = next; } else high = mid;
    }
    return (low + high) / 2;
  };
  const pieces = [0, hours];
  if (tau > 0) {
    const pendingDerivative = (h: number) => (heatStartW + slopeWPerH * h) / 1_000 - at(h).pending_heat_kwh / tau;
    if (pendingDerivative(0) * pendingDerivative(hours) < 0) pieces.push(bisect(pendingDerivative, 0, hours));
  }
  pieces.sort((a, b) => a - b);
  const turning = [0, hours];
  for (let i = 0; i + 1 < pieces.length; i++) {
    const low = pieces[i], high = pieces[i + 1], a = derivative(low), b = derivative(high);
    if (a === 0) turning.push(low);
    if (a * b < 0) turning.push(bisect(derivative, low, high));
    if (b === 0) turning.push(high);
  }
  turning.sort((a, b) => a - b);
  for (let i = 0; i + 1 < turning.length; i++) {
    const low = turning[i], high = turning[i + 1];
    if (at(low).water_c >= stopC) return low;
    if (at(high).water_c >= stopC) return bisect(h => at(h).water_c - stopC, low, high);
  }
  return null;
}

/** Hardware clips compressor time; heat already in transit keeps reaching water. */
export function stepPool(store: ThermalStoreModel, heater: PublishedHeater, heaterState: HeaterState, on: boolean, conditions: PoolConditions): PoolTransition {
  const { seconds, outdoor_c: outdoorC, stop_c: stopC } = conditions;
  if (store.response_time_constant_h === 0) return stepDirectPool(store, heater, heaterState, on,
    { ...conditions, water_c: poolInventoryC(store, conditions.water_c, conditions.pending_heat_kwh), pending_heat_kwh: 0 });
  const permitted = on && (stopC === null || conditions.water_c < stopC);
  if (!permitted) {
    const next = stepHeater(heater, heaterState, false, seconds);
    return { ...next, ...stepPoolThermal(store, conditions, 0, 0, outdoorC, seconds / 3600) };
  }
  const age = heaterState.kind === "steady" ? Infinity : heaterState.kind === "running" ? heaterState.seconds : 0;
  const response = heater.response;
  const knots = response.kind === "bergvarme" && age !== Infinity
    ? [0, ...response.startup.map(point => point.elapsed_seconds - age).filter(t => t > 0 && t < seconds), seconds] : [0, seconds];
  const fraction = (elapsed: number): number => {
    if (response.kind === "steady" || age === Infinity) return 1;
    const at = age + elapsed;
    for (let i = 1; i < response.startup.length; i++) {
      const low = response.startup[i - 1], high = response.startup[i];
      if (at <= high.elapsed_seconds) return low.heat_fraction + (high.heat_fraction - low.heat_fraction) * (at - low.elapsed_seconds) / (high.elapsed_seconds - low.elapsed_seconds);
    }
    return 1;
  };
  const cooling = idleCPerHour(store, conditions.water_c, outdoorC);
  let thermal: PoolThermalState = conditions, activeSeconds = seconds;
  for (let i = 0; i + 1 < knots.length; i++) {
    const from = knots[i], to = knots[i + 1], hours = (to - from) / 3600;
    const heat = heater.heat_w * fraction(from), slope = heater.heat_w * (fraction(to) - fraction(from)) / hours;
    const crossing = stopC === null ? null : firstPoolStop(store, thermal, heat, slope, hours, cooling, stopC);
    thermal = transferPoolHeat(store, thermal, heat, slope, crossing ?? hours, cooling);
    if (crossing !== null) { activeSeconds = from + crossing * 3600; break; }
  }
  const active = stepHeater(heater, heaterState, true, activeSeconds);
  const share = activeSeconds / seconds;
  let next = active.next;
  if (activeSeconds < seconds) {
    thermal = stepPoolThermal(store, thermal, 0, 0, outdoorC, (seconds - activeSeconds) / 3600);
    next = stepHeater(heater, active.next, false, seconds - activeSeconds).next;
  }
  return { electric_w: active.electric_w * share, compressor_w: active.compressor_w * share,
    auxiliary_w: active.auxiliary_w * share, heat_w: active.heat_w * share, ...thermal, next, start: active.start };
}

/** Direct-transfer stores keep their existing single-interval loss convention. */
function stepDirectPool(store: ThermalStoreModel, heater: PublishedHeater, state: HeaterState, on: boolean, conditions: PoolConditions): PoolTransition {
  const { water_c: waterC, outdoor_c: outdoorC, seconds, stop_c: stopC } = conditions;
  const permitted = on && (stopC === null || waterC < stopC);
  const full = stepHeater(heater, state, permitted, seconds);
  const end = stepThermalStore(store, waterC, full.heat_w, outdoorC, seconds / 3600);
  let activeSeconds = permitted ? seconds : 0;
  if (permitted && stopC !== null && end > stopC) {
    let low = 0, high = seconds;
    for (let i = 0; i < 48; i++) {
      const mid = (low + high) / 2, heat = stepHeater(heater, state, true, mid).heat_w;
      if (stepThermalStore(store, waterC, heat, outdoorC, mid / 3600) < stopC) low = mid; else high = mid;
    }
    activeSeconds = (low + high) / 2;
  }
  if (activeSeconds === 0) return { ...full, water_c: end, pending_heat_kwh: 0, start: null };
  const active = stepHeater(heater, state, true, activeSeconds), share = activeSeconds / seconds;
  const clipped = activeSeconds < seconds;
  const water = clipped ? stepThermalStore(store, stopC!, 0, outdoorC, (seconds - activeSeconds) / 3600)
    : stepThermalStore(store, waterC, active.heat_w, outdoorC, activeSeconds / 3600);
  return { electric_w: active.electric_w * share, compressor_w: active.compressor_w * share, auxiliary_w: active.auxiliary_w * share,
    heat_w: active.heat_w * share, water_c: water, pending_heat_kwh: 0,
    next: clipped ? stepHeater(heater, active.next, false, seconds - activeSeconds).next : active.next, start: active.start };
}

/** Parse stored response data once; malformed dynamics never become a steady model. */
export function parseHeaterResponse(input: unknown): HeatPumpResponse {
  const fail = (message: string): never => { throw new DeviceModelError(message); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("A heater response must be an object.");
  const value = input as Record<string, unknown>;
  if (value.kind === "steady") return { kind: "steady" };
  if (value.kind !== "bergvarme") fail("Unknown kind of heater response.");
  if (!Array.isArray(value.startup) || value.startup.length < 2) fail("A startup response needs at least two points.");
  const fraction = (v: unknown) => finite(v) && v >= 0;
  const startup = (value.startup as unknown[]).map((item, index): HeatPumpStartupPoint => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("A startup point must be an object.");
    const point = item as Record<string, unknown>;
    if (!finite(point.elapsed_seconds) || point.elapsed_seconds < 0) fail("Startup ages must be finite and nonnegative.");
    if (!fraction(point.electric_fraction) || !fraction(point.heat_fraction)) fail("Startup fractions must be finite and nonnegative.");
    if (point.electric_fraction === 0 && point.heat_fraction !== 0) fail("A startup response cannot deliver heat without compressor electricity.");
    if (index === 0 && point.elapsed_seconds !== 0) fail("A startup response must begin at age zero.");
    return { elapsed_seconds: point.elapsed_seconds as number, electric_fraction: point.electric_fraction as number, heat_fraction: point.heat_fraction as number };
  });
  if (startup.some((point, index) => index > 0 && point.elapsed_seconds <= startup[index - 1].elapsed_seconds)) fail("Startup ages must strictly increase.");
  const last = startup[startup.length - 1];
  if (last.electric_fraction !== 1 || last.heat_fraction !== 1) fail("A startup response must end at steady electricity and heat.");
  if (value.evidence === undefined) return { kind: "bergvarme", startup };
  if (!value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)) fail("Response evidence must be an object.");
  const evidence = value.evidence as Record<string, unknown>;
  if (![evidence.source, evidence.observed_start, evidence.heat_basis].every(v => typeof v === "string" && v.length > 0) || typeof evidence.heat_flow_measured !== "boolean") fail("Response evidence needs its source, start, heat basis and flow measurement status.");
  if (evidence.steady_compressor_w !== undefined && (!finite(evidence.steady_compressor_w) || evidence.steady_compressor_w <= 0)) fail("Evidence compressor draw must be positive.");
  if (evidence.steady_delta_c !== undefined && !finite(evidence.steady_delta_c)) fail("Evidence temperature difference must be finite.");
  if (evidence.sample_count !== undefined && (!Number.isInteger(evidence.sample_count) || (evidence.sample_count as number) <= 0)) fail("Evidence sample count must be a positive integer.");
  return { kind: "bergvarme", startup, evidence: { ...evidence } as unknown as HeatPumpResponseEvidence };
}

export interface HeatPumpResponseProjection {
  /** Interval-average electricity, including auxiliaries whenever the command is on. */
  draw_w: number[];
  /** Fraction of steady heat delivered over the commanded interval, independent of actual electric draw. */
  gain_fraction: number[];
  /** Null is off; Infinity is a confirmed steady run whose exact age is unknown. */
  elapsed_seconds_by_boundary: (number | null)[];
}

/** Exact integral of a piecewise-linear startup fraction, followed by its steady tail. */
function startupFractionSeconds(points: HeatPumpStartupPoint[], from: number, seconds: number, field: "electric_fraction" | "heat_fraction"): number {
  const steadyAt = points[points.length - 1].elapsed_seconds;
  if (from >= steadyAt) return seconds;
  const end = Math.min(steadyAt, from + seconds);
  let integral = Math.max(0, seconds - (steadyAt - from));
  for (let index = 1; index < points.length; index++) {
    const low = points[index - 1], high = points[index];
    const start = Math.max(from, low.elapsed_seconds), stop = Math.min(end, high.elapsed_seconds);
    if (stop <= start) continue;
    const slope = (high[field] - low[field]) / (high.elapsed_seconds - low.elapsed_seconds);
    const startFraction = low[field] + slope * (start - low.elapsed_seconds);
    const endFraction = low[field] + slope * (stop - low.elapsed_seconds);
    integral += (startFraction + endFraction) / 2 * (stop - start);
  }
  return integral;
}

/** Project nominal on/off commands using explicit run age; never hides state in a callback. */
export function projectHeatPumpResponse(
  response: HeatPumpResponse,
  power: { compressor_w: number; auxiliary_w: number },
  commands_w: readonly number[],
  duration_hours: readonly number[],
  initial_elapsed_seconds: number | null,
): HeatPumpResponseProjection {
  const model = parseHeaterResponse(response);
  const nominal = power.compressor_w + power.auxiliary_w;
  if (!finite(power.compressor_w) || power.compressor_w <= 0 || !finite(power.auxiliary_w) || power.auxiliary_w < 0 || !finite(nominal)) throw new DeviceModelError("A response needs positive compressor and nonnegative auxiliary draw.");
  if (commands_w.length !== duration_hours.length) throw new DeviceModelError("Commands and durations must cover the same intervals.");
  if (initial_elapsed_seconds !== null && !(initial_elapsed_seconds === Infinity || finite(initial_elapsed_seconds) && initial_elapsed_seconds >= 0)) throw new DeviceModelError("Initial run age must be nonnegative, confirmed steady, or off.");
  let elapsed = initial_elapsed_seconds;
  const result: HeatPumpResponseProjection = { draw_w: [], gain_fraction: [], elapsed_seconds_by_boundary: [elapsed] };
  commands_w.forEach((command, index) => {
    const hours = duration_hours[index], seconds = hours * 3600;
    if (!finite(hours) || hours <= 0 || !finite(seconds)) throw new DeviceModelError("Response intervals must have finite positive durations.");
    if (command !== 0 && command !== nominal) throw new DeviceModelError("A heat-pump command must be off or its nominal draw.");
    if (command === 0) {
      result.draw_w.push(0);
      result.gain_fraction.push(0);
      elapsed = null;
    } else {
      const age = elapsed ?? 0;
      const electric = model.kind === "steady" ? 1 : startupFractionSeconds(model.startup, age, seconds, "electric_fraction") / seconds;
      const heat = model.kind === "steady" ? 1 : startupFractionSeconds(model.startup, age, seconds, "heat_fraction") / seconds;
      result.draw_w.push(power.compressor_w * electric + power.auxiliary_w);
      result.gain_fraction.push(heat);
      elapsed = age + seconds;
      if (age !== Infinity && !finite(elapsed)) throw new DeviceModelError("Projected run age must remain finite.");
    }
    result.elapsed_seconds_by_boundary.push(elapsed);
  });
  return result;
}

/** A level that also delivers heat. */
export interface HeatLevel extends Level {
  heat_w: number;
}

export const cop = (point: OperatingPoint): number => point.heat_w / point.electric_w;

/** The machine's state at one setting: a measured point, or the line between its two neighbours. */
export function operatingPoint(model: HeatPumpModel, setting: number): OperatingPoint {
  const points = model.operating_points, last = points.length - 1;
  if (!(setting >= points[0].setting && setting <= points[last].setting)) {
    throw new DeviceModelError(`Setting ${setting} is outside what the heat pump was measured at (${points[0].setting} to ${points[last].setting}).`);
  }
  for (let i = 0; i <= last; i++) {
    if (points[i].setting === setting) return points[i];
    if (points[i].setting > setting) {
      const low = points[i - 1], high = points[i], share = (setting - low.setting) / (high.setting - low.setting);
      return { setting, electric_w: low.electric_w + (high.electric_w - low.electric_w) * share, heat_w: low.heat_w + (high.heat_w - low.heat_w) * share };
    }
  }
  return points[last];
}

/** Off, then the selected setting: its draw includes what must run with it, its heat does not. */
export function heatPumpLevels(model: HeatPumpModel): Levels<HeatLevel> {
  const run = operatingPoint(model, model.selected_setting);
  return [{ setting: 0, draw_w: 0, heat_w: 0 }, { setting: run.setting, draw_w: run.electric_w + model.auxiliary_w, heat_w: run.heat_w }];
}

/** Grid electricity a degree in the store costs at this level, everything that runs with it included, kWh. */
export const electricKwhPerDegree = (store: ThermalStoreModel, level: HeatLevel): number =>
  store.capacity_kwh_per_c * level.draw_w / level.heat_w;

// ---------------------------------------------------------------------------
// A household's devices

export interface DeviceModels {
  battery: BatteryModel;
  car: { battery: CarBatteryModel; charger: ChargerModel };
  pool: { store: ThermalStoreModel; heater: HeatPumpModel };
}

/**
 * Device models, checked once so that nothing that steps them has to: the
 * whole household's, or the ones a snapshot carries. Throws on a model no
 * device could have; fills nothing in.
 */
export function parseDeviceModels<T extends Partial<DeviceModels>>(input: T): T {
  const models: T = JSON.parse(JSON.stringify(input));
  const fail = (message: string): never => { throw new DeviceModelError(message); };
  const positive = (value: unknown) => finite(value) && value > 0;
  const share = (value: unknown) => finite(value) && value > 0 && value <= 1;

  const { battery, car, pool } = models;
  if (battery) {
    if (!positive(battery.capacity_kwh) || !positive(battery.charge_max_w) || !positive(battery.discharge_max_w)) fail("A battery needs a capacity and charge and discharge powers.");
    if (!finite(battery.min_soc) || !finite(battery.max_soc) || battery.min_soc < 0 || battery.max_soc > 1 || battery.min_soc >= battery.max_soc) fail("A battery's limits must lie in order between empty and full.");
    if (!share(battery.charge_efficiency) || !share(battery.discharge_efficiency)) fail("A battery's efficiencies are shares between zero and one.");
  }
  if (car) {
    if (!car.battery || !positive(car.battery.capacity_kwh) || !positive(car.battery.kwh_per_km) || !share(car.battery.charge_efficiency)) fail("A car needs a capacity, a consumption and a charge efficiency.");
    chargerLevels(car.charger);
  }
  if (pool) {
    const { store, heater } = pool;
    if (!store || !positive(store.capacity_kwh_per_c)) fail("A thermal store needs a heat capacity.");
    if (!finite(store.response_time_constant_h) || store.response_time_constant_h < 0) fail("A thermal store needs an explicit nonnegative heat-transfer response time.");
    if (store.loss?.kind === "linear") {
      if (!finite(store.loss.kw_per_c) || store.loss.kw_per_c < 0 || !(store.loss.surroundings_c === null || finite(store.loss.surroundings_c))) fail("A linear loss needs a rate and its surroundings.");
    } else if (store.loss?.kind === "measured") {
      const { points } = store.loss;
      if (!Array.isArray(points) || !points.length || !points.every((p, i) => finite(p.at_c) && finite(p.c_per_h) && (i === 0 || p.at_c > points[i - 1].at_c))) fail("A measured loss needs points at rising temperatures.");
    } else fail("Unknown kind of standing loss.");

    const points = heater?.operating_points;
    if (!Array.isArray(points) || !points.length) fail("A heat pump needs at least one measured operating point.");
    points.forEach((point, i) => {
      if (!positive(point.setting) || !positive(point.electric_w) || !positive(point.heat_w)) fail("An operating point needs a setting, electricity and heat.");
      if (i > 0 && !(point.setting > points[i - 1].setting && point.electric_w > points[i - 1].electric_w)) fail("Operating points must rise in setting and in electricity.");
    });
    if (heater.control !== "switch") fail("A heat pump the planner sets the power of is not modelled yet.");
    if (!finite(heater.auxiliary_w) || heater.auxiliary_w < 0) fail("A heat pump's auxiliary draw cannot be negative.");
    if (heater.response !== undefined) heater.response = parseHeaterResponse(heater.response);
    operatingPoint(heater, heater.selected_setting);
  }
  return models;
}
