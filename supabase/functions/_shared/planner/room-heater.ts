import type { EmpiricalDeviceModelInput } from "./planning-contracts.ts";
import type { DeviceCommand } from "./device-commands.ts";
import { heatingDraw } from "./weather-heating.ts";

/** Electrical behavior and the writable control surface are independent facts.
 * The scheduler chooses a whole-interval Boolean, never watts or a native target. */
export type RoomHeater =
  | { actuator: "switch"; power: { kind: "fixed"; on_w: number } }
  | { actuator: "setpoint"; power: { kind: "fixed"; on_w: number } | { kind: "inverter"; on_w: number; profile: EmpiricalDeviceModelInput["weather_heating"] } };

export function roomHeater(model: EmpiricalDeviceModelInput): RoomHeater | null {
  const watts = model.active_power_w;
  if (model.category !== "heating" || typeof watts !== "number" || !Number.isFinite(watts) || watts <= 0) return null;
  if (model.control_type === "switch_schedule" && model.load_type === "fixed_full_load") {
    return { actuator: "switch", power: { kind: "fixed", on_w: watts } };
  }
  if (model.control_type !== "setpoint") return null;
  if (model.load_type === "fixed_full_load" || model.load_type === "duty_cycle") {
    return { actuator: "setpoint", power: { kind: "fixed", on_w: watts } };
  }
  return model.load_type === "inverter"
    ? { actuator: "setpoint", power: { kind: "inverter", on_w: watts, profile: model.weather_heating } }
    : null;
}

export function roomHeaterDraw(heater: RoomHeater, outdoorC: number | null) {
  return heater.power.kind === "inverter" && heater.power.profile
    ? heatingDraw(heater.power.profile, outdoorC)
    : null;
}

/** Undefined is an incompatible/absent instruction, never an OFF request. */
export function roomHeaterState(heater: RoomHeater, command?: DeviceCommand): boolean | undefined {
  if (heater.actuator === "switch" && command?.type === "switch_schedule" &&
    (command.on_seconds === 0 || command.on_seconds === 900)) return command.on_seconds === 900;
  if (heater.actuator === "setpoint" && command?.type === "heating_schedule" && typeof command.heating === "boolean") return command.heating;
  return undefined;
}

export function roomHeaterCommand(heater: RoomHeater, heating: boolean): DeviceCommand {
  return heater.actuator === "switch"
    ? { type: "switch_schedule", on_seconds: heating ? 900 : 0 }
    : { type: "heating_schedule", heating };
}
