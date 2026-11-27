/** Historical v2 publication precision, retained for regression comparison.
 * Completed v2 captures replay their recorded draw counts. */
export interface ConnectedIntegrationStatistics {
  trajectories: number;
  total: number[];
  replicates: Array<{ trajectories: number; total: number[] }>;
  infeasible: number[];
}
export interface ConnectedIntegrationLayout {
  rooms: number; nodes: number; slots: number; sets?: number; hours: number[];
  /** Native comparator certificate, using the same unconditional rejection rule. */
  proposalRejected?: boolean;
  /** Native literal-comparator deadline predicates are numerically resolved. */
  deadlineResolved: boolean;
  roomPowerW: number[]; actuatorPowerW: number[]; roomNodeIndexes: number[];
  /** Highest absolute import/export unit price; converts energy integration
   * accuracy to the same priced objective without changing that objective. */
  maximumPricePerKwh: number;
}
export interface ConnectedIntegrationAccuracy {
  converged: boolean; next_trajectories: number;
  maximum_error_ratio: number; maximum_temperature_error_c: number;
  maximum_energy_error_wh: number; maximum_shortfall_error_c_h: number;
}
const INITIAL_TRAJECTORIES = 64;
const REPLICATES = 4;
// The published thermal forecast is displayed to one decimal place. Comparator
// integrals have their own paired precision below; this is no comfort deadband.
const ENDPOINT_ACCURACY_C = .05;
const SHORTFALL_ACCURACY_C = .02;
const ENERGY_RELATIVE_ACCURACY = .02;

/** Four independent replicate estimates expose uncertainty of the numerical
 * integral. Paths within each replicate may be antithetic/low-discrepancy;
 * treating those correlated paths as independent would understate error. */
export function connectedIntegrationAccuracy(stats: ConnectedIntegrationStatistics, layout: ConnectedIntegrationLayout): ConnectedIntegrationAccuracy {
  const { rooms, nodes, slots, roomPowerW, actuatorPowerW } = layout;
  const sets = layout.sets ?? 3;
  const stride = (2 * rooms + 2 * nodes + actuatorPowerW.length) * slots + rooms;
  if (stats.total.length !== stride * sets || stats.infeasible.length !== sets || stats.replicates.length !== REPLICATES ||
    layout.hours.length !== slots || layout.hours.some(h => !Number.isFinite(h) || h < 0) || roomPowerW.length !== rooms || layout.roomNodeIndexes.length !== rooms || layout.roomNodeIndexes.some(i => !Number.isSafeInteger(i) || i < 0 || i >= nodes) || stats.replicates.some(r => r.total.length !== stats.total.length)) throw new Error("Invalid connected integration statistics");
  const initial = { converged: false, next_trajectories: INITIAL_TRAJECTORIES,
    maximum_error_ratio: 0, maximum_temperature_error_c: 0, maximum_energy_error_wh: 0, maximum_shortfall_error_c_h: 0 };
  if (stats.trajectories < INITIAL_TRAJECTORIES || stats.replicates.some(r => r.trajectories < 2)) return initial;
  const error = (indexes: number[], subtract: number[] = [], weights?: number[]) => {
    const means = stats.replicates.map(r => (indexes.reduce((sum, index, j) => sum + r.total[index] * (weights?.[j] ?? 1), 0) - subtract.reduce((sum, index, j) => sum + r.total[index] * (weights?.[j] ?? 1), 0)) / r.trajectories);
    const mean = means.reduce((sum, v) => sum + v, 0) / REPLICATES;
    // Two estimated standard errors are a numerical accuracy diagnostic, not
    // a claimed physical confidence bound or a service-admission threshold.
    return 2 * Math.sqrt(means.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (REPLICATES * (REPLICATES - 1)));
  };
  let ratio = 0, temperatureError = 0, energyError = 0, shortfallError = 0;
  const assess = (indexes: number[], absolute: number, relative: number, kind: "temperature" | "energy" | "cost" | "shortfall", subtract: number[] = [], weights?: number[]) => {
    const estimate = (indexes.reduce((sum, i, j) => sum + stats.total[i] * (weights?.[j] ?? 1), 0) - subtract.reduce((sum, i, j) => sum + stats.total[i] * (weights?.[j] ?? 1), 0)) / stats.trajectories;
    const numericalError = error(indexes, subtract, weights), tolerance = Math.max(absolute, relative * Math.abs(estimate));
    ratio = Math.max(ratio, tolerance > 0 ? numericalError / tolerance : numericalError === 0 ? 0 : Infinity);
    if (kind === "temperature") temperatureError = Math.max(temperatureError, numericalError);
    if (kind === "shortfall") shortfallError = Math.max(shortfallError, numericalError);
    if (kind === "energy") energyError = Math.max(energyError, numericalError);
  };
  // Electrical replay feasibility is monotone in the accumulated path set.
  // An infeasible vector cannot be selected; the feasible seed is selectable
  // only when both proposed and literal vectors are infeasible.
  const primary = [0, 1].filter(set => set < sets && stats.infeasible[set] === 0 && !(set === 0 && layout.proposalRejected && stats.infeasible[1] === 0));
  const selectable = primary.length ? primary : sets > 2 && stats.infeasible[2] === 0 ? [2] : [];
  for (const set of selectable) {
    const base = set * stride;
    for (let r = 0; r < rooms; r++) {
      const indexes = Array.from({ length: slots }, (_, q) => base + r * slots + q);
      const controlTickWh = roomPowerW[r] / 60;
      assess(indexes, controlTickWh, ENERGY_RELATIVE_ACCURACY, "energy");
      for (const i of indexes) assess([i], controlTickWh, ENERGY_RELATIVE_ACCURACY, "energy");
    }
    // Only published controlled-room endpoints enter the precision contract.
    // Passive temperatures affect their trajectories, but an internal passive
    // diagnostic must not keep an otherwise converged household plan pending.
    for (const node of layout.roomNodeIndexes) for (let q = 0; q < slots; q++) assess([base + rooms * slots + node * slots + q], ENDPOINT_ACCURACY_C, 0, "temperature");

    const actuatorStart = (2 * rooms + 2 * nodes) * slots;
    for (let a = 0; a < actuatorPowerW.length; a++) for (let q = 0; q < slots; q++) assess([base + actuatorStart + a * slots + q], actuatorPowerW[a] / 60, ENERGY_RELATIVE_ACCURACY, "energy");
  }
  // Only proposed-versus-literal is a comfort/cost comparison. Both use the
  // same path, so uncertainty common to the two command vectors cancels.
  if (primary.length === 2) {
    // The comparator integrates each room's positive-part shortfall over its
    // horizon, then every ordered prefix. Quarter values enter only its native
    // deadline predicates; resolving their magnitudes is not another policy.
    const horizonHours = layout.hours.reduce((sum, h) => sum + h, 0);
    const prefix: number[] = [], prefixWeights: number[] = [];
    for (let room = 0; room < rooms; room++) {
      const indexes = Array.from({ length: slots }, (_, q) => (rooms + 2 * nodes + room) * slots + q);
      assess(indexes, SHORTFALL_ACCURACY_C * horizonHours, 0, "shortfall", indexes.map(i => stride + i), layout.hours);
      prefix.push(...indexes); prefixWeights.push(...layout.hours);
      assess(prefix, SHORTFALL_ACCURACY_C * horizonHours * (room + 1), 0, "shortfall", prefix.map(i => stride + i), prefixWeights);
    }
    if (!layout.deadlineResolved) ratio = Infinity;
    const costStart = stride - rooms;
    for (let r = 0; r < rooms; r++) {
      const tick = roomPowerW.slice(0, r + 1).reduce((sum, watts) => sum + watts / 60, 0) * layout.maximumPricePerKwh / 1000;
      assess([costStart + r], tick, ENERGY_RELATIVE_ACCURACY, "cost", [stride + costStart + r]);
    }
  }
  return { converged: ratio <= 1, next_trajectories: stats.trajectories * 2,
    maximum_error_ratio: ratio, maximum_temperature_error_c: temperatureError, maximum_energy_error_wh: energyError, maximum_shortfall_error_c_h: shortfallError };
}
