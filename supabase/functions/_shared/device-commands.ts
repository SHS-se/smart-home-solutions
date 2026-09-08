/** Executable schema-7 decisions. Watt forecasts alone never grant authority. */
import type { OptimisationSnapshot } from "./energy-optimisation.ts";
import { projectZoneTemperature } from "./thermal-model.ts";

export type DeviceCommand =
  | { type: "setpoint"; target_c: number; minimum_c: number; maximum_c: number }
  | { type: "switch_schedule"; on_seconds: number }
  | { type: "permit_inhibit"; permitted: boolean }
  | { type: "variable_power"; value: number; unit: "A" }
  | { type: "unavailable"; reason: string };

export function deviceCommands(snapshot: OptimisationSnapshot, dispatch: {
  index: number;
  roomHeating: Record<string, number[]>;
  boilerPermitted: boolean;
  poolW: number;
  evCurrentA: number;
  relayPower: Record<string, number[]>;
}): Record<string, DeviceCommand> {
  const result: Record<string, DeviceCommand> = {};
  for (const model of snapshot.device_models) {
    const zone = snapshot.thermal_zones?.find((z) =>
      z.device_keys.includes(model.key)
    );
    let command: DeviceCommand = {
      type: "unavailable",
      reason: "No executable planning model for this device",
    };
    if (zone && model.control_type === "setpoint") {
      const trajectory = projectZoneTemperature(
        zone.model,
        zone.start_temperature_c,
        [
          ...(snapshot.outdoor_temperature_c as number[]),
          (snapshot.outdoor_temperature_c as number[]).at(-1)!,
        ],
        dispatch.roomHeating[zone.key],
      );
      const i = Math.min(dispatch.index + 1, zone.target_c.length - 1);
      command = {
        type: "setpoint",
        target_c: Math.min(
          zone.comfort_max_c[i],
          Math.max(zone.comfort_min_c[i], trajectory[dispatch.index + 1]),
        ),
        minimum_c: zone.comfort_min_c[i],
        maximum_c: zone.comfort_max_c[i],
      };
    } else if (
      model.control_type === "switch_schedule" && dispatch.relayPower[model.key]
    ) {
      command = {
        type: "switch_schedule",
        on_seconds: dispatch.relayPower[model.key][dispatch.index] > 0
          ? 900
          : 0,
      };
    } else if (
      model.control_type === "permit_inhibit" &&
      model.category === "hot_water" && snapshot.capabilities.boiler
    ) {
      command = { type: "permit_inhibit", permitted: dispatch.boilerPermitted };
    } else if (
      model.control_type === "variable_power" &&
      model.category === "ev_charging" && snapshot.capabilities.ev
    ) {
      command = {
        type: "variable_power",
        value: dispatch.evCurrentA,
        unit: "A",
      };
    }
    // Only relay decisions solved and simulated as full quarters are executable.
    result[model.key] = command;
  }
  return result;
}
