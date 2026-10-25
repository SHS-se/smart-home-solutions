/** Finite native thermostat targets and whole-quarter relays, comfort before cost. */
import type { RoomTransition } from "./planner/models/room/thermal.ts";
import type { RoomThermostat, ThermostatQuarter } from "./planner/thermostat.ts";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import type { PlanningTrace } from "./planning-trace.ts";

export interface RoomQuarter extends ThermostatQuarter {
  transition: RoomTransition;
  required_c: number;
  maximum_c: number;
  maximum_w: number;
  relay_w: number[];
  fixed_relays: (boolean | null)[];
  /** Native applied targets; the original retained command stays with its caller. */
  fixed_targets_c: (number | null)[];
  import_sek_per_kwh: number;
  export_sek_per_kwh: number;
  surplus_w: number;
}
export interface RoomHeatingPlan {
  power_w: number[];
  thermostat_w: number[][];
  targets_c: number[][];
  relays_on: boolean[][];
  temperature_c: number[];
  shortfall_c: number[];
}

export const MAX_ROOM_RELAYS = 4;
/** The search runs in the existing native kernel, including during admission. */
export function planRoomHeating(startC: number, thermostats: readonly RoomThermostat[], quarters: RoomQuarter[], startDeliveredW = 0, trace?: PlanningTrace): RoomHeatingPlan {
  return nativePlanner(trace).room({ start_c: startC, start_delivered_w: startDeliveredW, thermostats, quarters }, trace);
}
