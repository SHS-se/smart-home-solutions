import type { DynamicThermalZoneModel, EquilibriumThermalZoneModel, ThermalZoneModel } from "./thermal.ts";

/** Nullable statistical evidence never removes the room's comfort service. */
export function readThermalModel(value: unknown): ThermalZoneModel | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const number = (key: string) => row[key] == null ? NaN : Number(row[key]);
  const optional = (key: string) => row[key] == null ? null : Number(row[key]);
  const common = { heat_lag_h: optional("heat_lag_h"), solar_mean_w_per_m2: optional("solar_mean_w_per_m2"),
    r2: number("r2"), sample_count: number("sample_count"), residual_std_c: number("residual_std_c"),
    prediction_error_c: optional("prediction_error_c") };
  if (row.response_family === "equilibrium") {
    const model: EquilibriumThermalZoneModel = { ...common, response_family: "equilibrium",
      heater_c_per_w: number("heater_c_per_w"), outdoor_share: number("outdoor_share"),
      offset_c: number("offset_c"), solar_c_per_wm2: optional("solar_c_per_wm2") };
    return Object.entries(model).every(([k,v]) => k === "response_family" || v === null || Number.isFinite(v)) &&
      model.heater_c_per_w >= 0 && model.outdoor_share >= 0 && model.outdoor_share <= 1 &&
      (model.heat_lag_h ?? 0) >= 0 && (model.solar_c_per_wm2 ?? 0) >= 0 ? model : null;
  }
  // The existing untagged finite shape remains a member of the storage schema.
  if (row.response_family != null && row.response_family !== "finite" && row.response_family !== "integrator") return null;
  const integrator = row.response_family === "integrator";
  const model: DynamicThermalZoneModel = { ...common,
    ...(row.response_family ? { response_family: row.response_family as "finite" | "integrator" } : {}),
    gain_c_per_wh: number("gain_c_per_wh"), cooling_constant_per_h: number("cooling_constant_per_h"),
    background_gain_c_per_h: number("background_gain_c_per_h"),
    thermal_capacity_wh_per_c: integrator ? optional("thermal_capacity_wh_per_c") : number("thermal_capacity_wh_per_c"),
    heat_loss_w_per_c: integrator ? optional("heat_loss_w_per_c") : number("heat_loss_w_per_c"),
    time_constant_h: integrator ? optional("time_constant_h") : number("time_constant_h"),
    heating_rate_c_per_h: optional("heating_rate_c_per_h"),
    solar_gain_c_per_h_per_wm2: optional("solar_gain_c_per_h_per_wm2"),
    house_coupling_per_h: optional("house_coupling_per_h"),
  };
  if (integrator && (model.cooling_constant_per_h !== 0 || model.house_coupling_per_h !== 0 || model.time_constant_h !== null)) return null;
  return Object.entries(model).every(([k,v]) => k === "response_family" || v === null || Number.isFinite(v)) &&
    (integrator ? model.gain_c_per_wh >= 0 : model.gain_c_per_wh > 0) && model.cooling_constant_per_h >= 0 ? model : null;
}
