import { type RoomState, type RoomTransition } from "./thermal-model.ts";

/** Native observations at snapshot capture, independently of the room sensor. */
export interface ThermostatInput {
  entity_id: string;
  minimum_c: number;
  maximum_c: number;
  step_c: number;
  current_temperature_c: number;
  target_temperature_c: number;
  hvac_action: "heating" | "idle";
}

export interface RoomThermostat extends ThermostatInput {
  power_w: number;
  sensor_offset_c: number;
}

export interface ThermostatRoomState extends RoomState { heating_mask: number }
export interface ThermostatQuarter {
  hours: number;
  /** Exact constant-input transition for each equal, at most one-minute step. */
  step: RoomTransition;
  steps: number;
}

export function isThermostat(value: unknown): value is ThermostatInput {
  if (!value || typeof value !== "object") return false;
  const t = value as ThermostatInput;
  return typeof t.entity_id === "string" && t.entity_id.length > 0 &&
    [t.minimum_c, t.maximum_c, t.step_c, t.current_temperature_c, t.target_temperature_c]
      .every(v => typeof v === "number" && Number.isFinite(v)) &&
    t.step_c > 0 && t.maximum_c >= t.minimum_c &&
    t.target_temperature_c >= t.minimum_c && t.target_temperature_c <= t.maximum_c &&
    (t.hvac_action === "heating" || t.hvac_action === "idle");
}

/** Same nearest native step, halves up, as the existing HA executor. */
const nearestIndex = (t: ThermostatInput, requestedC: number) => Math.floor((requestedC - t.minimum_c) / t.step_c + .5 + 1e-9);
export function nativeTarget(t: ThermostatInput, requestedC: number): number {
  return t.minimum_c + nearestIndex(t, requestedC) * t.step_c;
}

/** Clamp the selected grid index, never clip a rounded target off its grid. */
export function supportedTarget(t: ThermostatInput, requestedC: number): number {
  const index = nearestIndex(t, requestedC);
  const last = Math.floor((t.maximum_c - t.minimum_c) / t.step_c + 1e-9);
  return Math.round((t.minimum_c + Math.max(0, Math.min(last, index)) * t.step_c) * 1e9) / 1e9;
}

export function heatingMask(thermostats: readonly RoomThermostat[]): number {
  return thermostats.reduce((mask, t, j) => mask + (t.hvac_action === "heating" ? 2 ** j : 0), 0);
}

/** All steps that can change this quarter's response, plus equivalent extremes. */
export function thermostatTargets(t: RoomThermostat, lowRoomC: number, highRoomC: number): number[] {
  const last = Math.floor((t.maximum_c - t.minimum_c) / t.step_c + 1e-9);
  const index = (c: number) => Math.max(0, Math.min(last, Math.floor((c - t.minimum_c) / t.step_c)));
  const first = index(lowRoomC + t.sensor_offset_c - .5);
  const end = Math.min(last, index(highRoomC + t.sensor_offset_c + .5) + 1);
  return Array.from({ length: end - first + 1 }, (_, j) =>
    Math.round((t.minimum_c + (first + j) * t.step_c) * 1e9) / 1e9);
}

/**
 * A target calls for heat at a 0.5 C margin (user requirement, 21 Oct 2026).
 * Heating stops at the target; in between, the observed/predicted HVAC latch
 * is retained. The native sensor follows the room with its observed offset.
 * Integrating on-cycle watts, rather than choosing fractional watts, accounts
 * for a thermostat stopping or restarting within a quarter, including a floor
 * whose delivered heat keeps changing after the electrical power stops.
 */
export function projectThermostatQuarter(q: ThermostatQuarter, thermostats: readonly RoomThermostat[],
  initial: ThermostatRoomState, targets: readonly number[], relayW: number) {
  let temperature = initial.temperature_c, delivered = initial.delivered_w, previousMask = initial.heating_mask;
  const step = q.step;
  const energy = thermostats.map(() => 0);
  const hours = q.steps > 0 ? q.hours / q.steps : 0;
  let peakW = relayW;
  for (let k = 0; k < q.steps; k++) {
    let mask = 0, watts = relayW;
    for (let j = 0; j < thermostats.length; j++) {
      const t = thermostats[j], own = temperature + t.sensor_offset_c;
      const wasOn = Math.floor(previousMask / 2 ** j) % 2 === 1;
      const on = own >= targets[j] - 1e-9 ? false :
        targets[j] - own >= .5 - 1e-9 ? true : wasOn;
      if (on) { mask += 2 ** j; watts += t.power_w; energy[j] += t.power_w * hours; }
    }
    peakW = Math.max(peakW, watts);
    temperature = step.decay * temperature + step.offset_c + step.delivered_gain_c_per_w * delivered + step.gain_c_per_w * watts;
    delivered = step.carry * delivered + (1 - step.carry) * watts;
    previousMask = mask;
  }
  return { state: { temperature_c: temperature, delivered_w: delivered, heating_mask: previousMask }, thermostat_w: energy.map(wh => q.hours > 0 ? wh / q.hours : 0), peak_w: peakW };
}
