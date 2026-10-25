import type { OptimisationSnapshot, ThermalPlanningProjection } from "../../planning-contracts.ts";
/** Describe actual actuator capabilities; never infer a thermostat from a room temperature. */
export function roomProjectionControl(snapshot: OptimisationSnapshot, keys: readonly string[]):
  Pick<ThermalPlanningProjection["zones"][number], "control_type" | "load_type"> {
  const devices = snapshot.device_models.filter(device => keys.includes(device.key));
  const controls = new Set(devices.map(device => device.control_type));
  const loads = new Set(devices.map(device => device.load_type));
  return {
    control_type: controls.size === 1 && controls.has("switch_schedule") ? "switch_schedule"
      : controls.size === 1 && controls.has("setpoint") ? "setpoint" : "mixed",
    load_type: loads.size === 1 ? devices[0].load_type : "mixed",
  };
}
