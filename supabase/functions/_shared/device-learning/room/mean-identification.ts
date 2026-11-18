export interface RoomSteadyResponse {
  heater_c_per_w: number;
  outdoor_share: number;
  offset_c: number;
  solar_c_per_wm2: number | null;
}

export interface RoomIntegratorResponse {
  heater_c_per_wh: number;
  background_c_per_h: number;
  solar_c_per_h_per_wm2: number | null;
}

export interface RoomResponseSelection {
  criterion: "conditional_aicc";
  selected: "finite_response" | "equilibrium_response" | "integrator_response" | "unavailable";
  observation_pairs: number;
  finite_parameters: number | null;
  equilibrium_parameters: number | null;
  integrator_parameters: number | null;
  finite_aicc: number | null;
  equilibrium_aicc: number | null;
  integrator_aicc: number | null;
  steady_response: RoomSteadyResponse | null;
  integrator_response: RoomIntegratorResponse | null;
  finite_lag_h: number | null;
  equilibrium_lag_h: number | null;
  integrator_lag_h: number | null;
  unavailable_reason: "finite_score_undefined" | "equilibrium_score_undefined" | "integrator_score_undefined" |
    "limiting_families_unidentified" | null;
  equilibrium_lags_evaluated?: number[];
  equilibrium_validation_pairs?: number;
  equilibrium_validation_mse_c2?: number | null;
  equilibrium_holdout_selected_lag_h?: number | null;
  integrator_lags_evaluated?: number[];
  integrator_validation_pairs?: number;
  integrator_validation_mse_c2?: number | null;
  integrator_holdout_selected_lag_h?: number | null;
}

interface FitScore { mse: number; parameters: number }

export function conditionalAicc(pairs: number, fit: FitScore | null): number | null {
  if (!fit || pairs <= fit.parameters + 1 || !Number.isFinite(fit.mse) || fit.mse < 0) return null;
  // MIN_VALUE only represents floating-point zero; it is not a noise floor.
  return pairs * Math.log(Math.max(Number.MIN_VALUE, fit.mse)) + 2 * fit.parameters +
    2 * fit.parameters * (fit.parameters + 1) / (pairs - fit.parameters - 1);
}

/** Relative conditional-prediction model selection, NOT a confidence test.
 * All families see identical observations, forcing, lag grid, and initial-state
 * nuisance segments. Parameter counts include initial states and variance.
 * Serial errors, feedback, and error in observed starting temperatures can
 * bias both families: this comparison cannot establish physical correctness.
 */
export function compareFiniteRoomResponse(pairs: number, finite: FitScore | null,
  equilibrium: (FitScore & { steady: RoomSteadyResponse; lag_h: number }) | null,
  integrator: (FitScore & { response: RoomIntegratorResponse; lag_h: number }) | null,
  finiteLag: number | null): RoomResponseSelection {
  const finiteScore = conditionalAicc(pairs, finite), equilibriumScore = conditionalAicc(pairs, equilibrium);
  const integratorScore = conditionalAicc(pairs, integrator);
  const unavailableReason = finite && finiteScore === null ? "finite_score_undefined" :
    equilibrium && equilibriumScore === null ? "equilibrium_score_undefined" :
    integrator && integratorScore === null ? "integrator_score_undefined" :
    !equilibrium && !integrator ? "limiting_families_unidentified" : null;
  const alternatives = [
    { selected: "equilibrium_response" as const, score: equilibriumScore },
    { selected: "integrator_response" as const, score: integratorScore },
  ].filter((candidate): candidate is typeof candidate & { score: number } => candidate.score !== null);
  const alternative = alternatives.reduce<(typeof alternatives)[number] | null>((best, candidate) =>
    !best || candidate.score < best.score ? candidate : best, null);
  const selected = unavailableReason ? "unavailable" : !finite && alternative ? alternative.selected :
    finiteScore === null ? "unavailable" : alternative && alternative.score <= finiteScore ? alternative.selected : "finite_response";
  return {
    criterion: "conditional_aicc",
    selected,
    observation_pairs: pairs, finite_parameters: finite?.parameters ?? null,
    equilibrium_parameters: equilibrium?.parameters ?? null,
    integrator_parameters: integrator?.parameters ?? null,
    finite_aicc: finiteScore, equilibrium_aicc: equilibriumScore,
    integrator_aicc: integratorScore,
    steady_response: equilibrium?.steady ?? null,
    integrator_response: integrator?.response ?? null,
    finite_lag_h: finiteLag, equilibrium_lag_h: equilibrium?.lag_h ?? null,
    integrator_lag_h: integrator?.lag_h ?? null,
    unavailable_reason: unavailableReason,
  };
}
