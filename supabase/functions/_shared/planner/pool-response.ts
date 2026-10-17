/** Prepared empirical response. This is data; learning remains outside solve. */
export interface PoolDynamics {
  version: 1;
  response_time_constant_h: number;
  heat_c_per_kwh: number;
  idle_c_per_h: number;
  reference_c: number;
  sample_count: number;
  rmse_c: number;
  instantaneous_rmse_c: number | null;
  initial_state: { at: string; pending_heat_kwh: number };
  state: { at: string; pending_heat_kwh: number };
}
