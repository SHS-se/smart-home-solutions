/** Prepared empirical response. This is data; learning remains outside solve. */
export interface PoolDynamics {
  version: 1;
  response_time_constant_h: number;
  /** Gain at the start of a run. */
  heat_c_per_kwh: number;
  /** Gain lost per hour of continuous running, learned up to `heat_fade_until_h`
   * (the longest observed run) and held there beyond it. Absent on older fits. */
  heat_fade_c_per_kwh_per_h?: number;
  heat_fade_until_h?: number;
  idle_c_per_h: number;
  reference_c: number;
  sample_count: number;
  rmse_c: number;
  instantaneous_rmse_c: number | null;
  initial_state: { at: string; pending_heat_kwh: number };
  state: { at: string; pending_heat_kwh: number; run_hours?: number };
}

/** Learned gain after `runHours` of continuous running. */
export function poolHeatGain(model: PoolDynamics, runHours: number): number {
  const fade = model.heat_fade_c_per_kwh_per_h ?? 0, until = model.heat_fade_until_h ?? 0;
  return model.heat_c_per_kwh - fade * Math.min(Math.max(0, runHours), until);
}
