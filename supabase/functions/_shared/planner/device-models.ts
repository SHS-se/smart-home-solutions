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
