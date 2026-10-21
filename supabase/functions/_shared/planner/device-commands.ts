/** Executable device settings. Forecast watts never grant control authority. */
export type DeviceCommand =
  | { type: "setpoint"; target_c: number; minimum_c: number; maximum_c: number }
  | { type: "switch_schedule"; on_seconds: number }
  | { type: "permit_inhibit"; permitted: boolean }
  | { type: "variable_power"; value: number; unit: "A" }
  | { type: "unavailable"; reason: string };
