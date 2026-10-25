import type { ThermalZoneModel } from "./thermal.ts";

/** Nullable statistical evidence never removes the room's comfort service. */
export function readThermalModel(row: Record<string, unknown> | undefined): ThermalZoneModel | null {
  if (!row) return null;
  const number = (key: string) => row[key] == null ? NaN : Number(row[key]);
  const optional = (key: string) => row[key] == null ? null : Number(row[key]);
  const model: ThermalZoneModel = {
    gain_c_per_wh: number("gain_c_per_wh"), cooling_constant_per_h: number("cooling_constant_per_h"),
    background_gain_c_per_h: number("background_gain_c_per_h"),
    thermal_capacity_wh_per_c: number("thermal_capacity_wh_per_c"), heat_loss_w_per_c: number("heat_loss_w_per_c"),
    time_constant_h: number("time_constant_h"), heating_rate_c_per_h: optional("heating_rate_c_per_h"),
    solar_gain_c_per_h_per_wm2: optional("solar_gain_c_per_h_per_wm2"), solar_mean_w_per_m2: optional("solar_mean_w_per_m2"),
    r2: number("r2"), sample_count: number("sample_count"), residual_std_c: number("residual_std_c"),
    heat_lag_h: optional("heat_lag_h"), house_coupling_per_h: optional("house_coupling_per_h"),
    prediction_error_c: optional("prediction_error_c"),
  };
  return Object.values(model).every(v => v === null || Number.isFinite(v)) && model.gain_c_per_wh > 0
    && model.cooling_constant_per_h >= 0 ? model : null;
}
