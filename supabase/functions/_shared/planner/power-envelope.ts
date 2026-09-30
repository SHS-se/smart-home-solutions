/**
 * The executable power band of one dispatchable service.
 *
 * This module exists to state §8.13 exactly once. A device that can only be
 * switched must never be bid at a fraction of its rated power: without a floor
 * `executablePowerLevels` treats zero as the minimum and bids any fraction of
 * it, so a pool relay that should draw 3.5 kW or nothing is planned at 38 W,
 * 59 W and 340 W tracking a solar peak — a modulation the relay does not have.
 *
 * That invariant used to live as `min_power_w === max_power_w` written beside
 * the pool store, next to a comment explaining why. Every store that gained a
 * power band had to remember it independently, and a device whose hardware
 * *can* modulate had no way to say so. Here it is a property of the parser: a
 * control that declares no floor is a relay, and a relay's envelope has one
 * non-zero level by construction.
 *
 * Pure: no I/O, no snapshot, no store. The two callers in `buildDispatchStores`
 * spread the result directly.
 */

import type {
  DiscreteCurrentControl,
  FixedPowerControl,
} from "./energy-optimisation.ts";

/** Any control a dispatchable service may declare. Duty cycle is not one: the
 * boiler is permitted or inhibited, never asked for a power. */
export type DispatchControl = FixedPowerControl | DiscreteCurrentControl;

export interface PowerEnvelope {
  /** The highest executable power. */
  max_power_w: number;
  /**
   * The lowest *non-zero* executable power. Zero is the separate off state and
   * is always available; this is the floor of the running band.
   */
  min_power_w: number;
  /** The executable increment above `min_power_w`. Zero means "no intermediate
   * levels": the band is exactly {`min_power_w`, `max_power_w`}. */
  power_step_w: number;
}

/**
 * The most executable levels one service may offer the dispatch search.
 *
 * `executablePowerLevels` enumerates the whole band for every candidate slot,
 * so the count multiplies through the search. Sixteen covers a 6 A–32 A
 * charger at 1 A and a pool heat pump at its native increment; beyond that the
 * extra resolution buys less than it costs.
 */
export const MAX_EXECUTABLE_LEVELS = 16;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A device with one power and off. */
export function relayEnvelope(power_w: number): PowerEnvelope {
  return { max_power_w: power_w, min_power_w: power_w, power_step_w: 0 };
}

/**
 * Coarsen a band to at most `MAX_EXECUTABLE_LEVELS` steps.
 *
 * The step is recomputed as an exact division of the band rather than scaled by
 * a factor, because `executablePowerLevels` floors a raw level onto the grid:
 * a step that does not divide the band strands `max_power_w` one increment
 * below the ceiling and the device could never be planned flat out. Choosing
 * the interval count instead keeps both ends on the grid by construction.
 *
 * Alignment to the hardware's own increment is deliberately not preserved here.
 * The integration converts watts back to the device's native unit and rounds to
 * its real step at the write boundary, which is the only place that knows it.
 */
function boundedStep(min_power_w: number, max_power_w: number, step_w: number) {
  const band = max_power_w - min_power_w;
  if (band <= 0 || step_w <= 0) return 0;
  const intervals = Math.round(band / step_w);
  if (intervals <= 1) return band;
  return band / Math.min(intervals, MAX_EXECUTABLE_LEVELS - 1);
}

/**
 * The executable band a control declares.
 *
 * `fixed_power` carries an optional floor and step. Their *absence* is the
 * statement that the device is a relay — which is what lets a new integration
 * send them to an old planner, and an old integration stay silent to a new one,
 * without either side negotiating a schema.
 */
export function powerEnvelope(control: DispatchControl): PowerEnvelope {
  if (control.type === "discrete_current") {
    const wattsPerAmp = control.phase_count * control.voltage_v;
    return {
      max_power_w: wattsPerAmp * control.max_current_a,
      min_power_w: wattsPerAmp * control.min_current_a,
      power_step_w: wattsPerAmp * control.current_step_a,
    };
  }
  const max_power_w = control.power_w;
  if (!finite(control.min_power_w) || control.min_power_w <= 0) {
    return relayEnvelope(max_power_w);
  }
  // A floor above the ceiling is a review error, not a band. Treating it as a
  // relay keeps the home planned at a power the hardware certainly has, and
  // `validateSnapshot` reports the contradiction separately.
  const min_power_w = Math.min(control.min_power_w, max_power_w);
  const step_w = finite(control.power_step_w) && control.power_step_w > 0
    ? control.power_step_w
    : 0;
  return {
    max_power_w,
    min_power_w,
    power_step_w: boundedStep(min_power_w, max_power_w, step_w),
  };
}

/**
 * Why a declared band is not usable, or null.
 *
 * Separate from `powerEnvelope` so that parsing always yields a plannable
 * envelope: a home with one badly reviewed number still gets a plan, and the
 * error reaches the customer through the snapshot report rather than by
 * refusing to plan.
 */
export function powerEnvelopeError(control: DispatchControl): string | null {
  if (control.type !== "fixed_power") return null;
  if (control.min_power_w === undefined && control.power_step_w === undefined) {
    return null;
  }
  if (control.power_step_w !== undefined && control.min_power_w === undefined) {
    return "power_step_w requires min_power_w";
  }
  if (!finite(control.min_power_w) || control.min_power_w <= 0) {
    return "min_power_w must be a positive number of watts";
  }
  if (control.min_power_w > control.power_w) {
    return "min_power_w must not exceed power_w";
  }
  if (
    control.power_step_w !== undefined &&
    (!finite(control.power_step_w) || control.power_step_w <= 0)
  ) {
    return "power_step_w must be a positive number of watts";
  }
  return null;
}
