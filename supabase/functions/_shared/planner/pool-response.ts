/** Versioned learned source and water response. No old-calibration decoder. */
export interface PoolResponseState {
  at: string;
  pending_heat_kwh: number;
  source_depletion_kwh: number;
}
export interface PoolDynamics {
  version: 2;
  response_time_constant_h: number;
  heat_c_per_kwh: number;
  source:
    | { recovery_rate_per_h: number; heat_loss_c_per_kwh_per_kwh: number }
    | null;
  idle_c_per_h: number;
  reference_c: number;
  sample_count: number;
  rmse_c: number;
  instantaneous_rmse_c: number | null;
  constant_gain_rmse_c: number;
  recovery_evidence: {
    restarts: number;
    shortest_off_h: number | null;
    longest_off_h: number | null;
    profile: { recovery_rate_per_h: number; rmse_c: number }[];
    minimum_at_search_boundary: boolean;
    steady_heat_fraction_at_observed_peak: number | null;
  };
  initial_state: PoolResponseState;
  state: PoolResponseState;
}
export function poolHeatGain(
  model: PoolDynamics,
  depletionKwh: number,
): number {
  return model.heat_c_per_kwh -
    (model.source?.heat_loss_c_per_kwh_per_kwh ?? 0) * depletionKwh;
}
export function validatePoolDynamics(model: PoolDynamics): void {
  const finite = Number.isFinite;
  if (
    model.version !== 2 ||
    ![
      model.response_time_constant_h,
      model.heat_c_per_kwh,
      model.idle_c_per_h,
      model.reference_c,
    ].every(finite) ||
    model.response_time_constant_h < 0 || model.heat_c_per_kwh <= 0 ||
    model.idle_c_per_h > 0 ||
    model.source !== null &&
      (!model.source ||
        ![
          model.source.recovery_rate_per_h,
          model.source.heat_loss_c_per_kwh_per_kwh,
        ].every(finite) ||
        model.source.recovery_rate_per_h <= 0 ||
        model.source.heat_loss_c_per_kwh_per_kwh <= 0)
  ) throw new Error("Invalid version 2 pool response model");
  for (const state of [model.initial_state, model.state]) {
    if (
      !state || !finite(Date.parse(state.at)) ||
      !finite(state.pending_heat_kwh) || state.pending_heat_kwh < 0 ||
      !finite(state.source_depletion_kwh) || state.source_depletion_kwh < 0 ||
      poolHeatGain(model, state.source_depletion_kwh) <= 0
    ) throw new Error("Invalid pool response checkpoint");
  }
}
