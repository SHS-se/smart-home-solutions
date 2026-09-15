/** Executable battery intent, independent of manufacturer option strings. */
export type BatteryOperation =
  | "self_consumption"
  | "solar_charge"
  | "grid_charge"
  | "supply_house"
  | "export"
  | "hold";
export interface BatteryCommand {
  schema_version: 2;
  operation: BatteryOperation;
  charge_limit_w: number;
  discharge_limit_w: number;
  allow_grid_charge: boolean;
  allow_battery_export: boolean;
}
export function batteryCommand(input: {
  baseline: boolean;
  chargeW: number;
  dischargeW: number;
  loadW: number;
  pvW: number;
  chargeMaxW: number;
  dischargeMaxW: number;
  exportEnabled: boolean;
}): BatteryCommand {
  const { chargeW, dischargeW } = input;
  const residualW = Math.max(0, input.loadW - input.pvW);
  const operation: BatteryOperation = input.baseline
    ? "self_consumption"
    : chargeW > 0
    ? (chargeW <= Math.max(0, input.pvW - input.loadW) + 0.01
      ? "solar_charge"
      : "grid_charge")
    : dischargeW > 0
    ? (dischargeW > residualW + 0.01
      ? "export"
      : "supply_house")
    : "hold";
  if (operation === "export" && !input.exportEnabled) {
    throw new Error("Battery export was not authorized");
  }
  // Full house supply is a native demand-following permission. Keep a
  // deliberate partial allocation capped: the planner chose some grid import.
  const followsDemand = operation === "supply_house" && dischargeW + 0.01 >= residualW;
  return {
    schema_version: 2,
    operation,
    // Solar capture is a permission, not a forecast-sized charging request.
    charge_limit_w: input.baseline || operation === "solar_charge" ? input.chargeMaxW : chargeW,
    discharge_limit_w: input.baseline || followsDemand ? input.dischargeMaxW : dischargeW,
    allow_grid_charge: operation === "grid_charge",
    allow_battery_export: operation === "export",
  };
}
