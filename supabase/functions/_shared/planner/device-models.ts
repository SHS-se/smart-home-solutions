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
  loss: StandingLoss;
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
  minimum_run_s: number;
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
    if (!finite(heater.auxiliary_w) || heater.auxiliary_w < 0 || !finite(heater.minimum_run_s) || heater.minimum_run_s < 0) fail("A heat pump's auxiliary draw and minimum run cannot be negative.");
    operatingPoint(heater, heater.selected_setting);
  }
  return models;
}
