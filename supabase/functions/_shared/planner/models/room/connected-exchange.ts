import { roomHeatingDirectionKnown, roomMeanObservation } from "./observation.ts";

/** Native observation contract; adapters preserve nulls and original durations. */
export interface ConnectedRoomObservation {
  start_ms: number; duration_s?: 900 | 3600; room_c: number | null; outdoor_c: number | null;
  heat_w: number | null; solar_w_per_m2: number | null; cooling: boolean | null;
  operation_fact?: string; peer_c?: Record<string, number | null>;
  /** Inference scoring mask; never a replacement measured value. */
  inference_available?: boolean;
}

/** Effective receiving rates. They do not identify reciprocal physical W/K. */
export type ExchangeDynamics = { kind: "constant"; from: string; per_h: number } | {
  kind: "log_ou"; from: string; mean_log_per_h: number; reversion_per_h: number; stationary_variance: number;
};
export interface ConnectedRoomHeater {
  gain_c_per_wh: number; lag_h: number; gain_reference_outdoor_c: number; gain_outdoor_slope_per_c: number;
}
export interface ExchangePosterior {
  through_ms: number; temperature_c: number; stored_heat_c: number;
  /** Stochastic edges in incoming order; coordinates T, Q, z, then optional unknown static centers μ. */
  log_rates: number[]; log_centers?: number[]; covariance: number[][]; observations: number;
}
export interface ConnectedRoomBasis {
  graph_owner: string | null; graph_revision: number | null; topology_hash: string;
  source_policy: string; source_revision: number; history_from: string; history_to: string;
}
/** A statistical reset redraw, frozen with the accepted response basis. Rates
 * have unbounded positive support; a constant regime has κ=V=0. This describes
 * effective exchange and does not assert a measured door event. */
export interface ConnectedExchangeResetPrior {
  from: string;
  center_mean: number;
  center_variance: number;
  log_reversion_mean: number;
  log_reversion_sd: number;
  stationary_variance_scale: number;
  constant_probability: number;
}
/** Gamma intensity, using rate (hours), not scale, parametrization. */
export interface ConnectedExchangeHazard { shape: number; rate_h: number }
/** Parameter uncertainty is retained as finite log weights, including hypotheses
 * whose probability cannot currently be represented by exp(log_weight). */
export interface ConnectedProcessBelief {
  revision: "connected_process_regimes_v2";
  reset_priors: ConnectedExchangeResetPrior[];
  initial_hazard: ConnectedExchangeHazard;
  initial_incoming: ExchangeDynamics[];
  replicas: Array<{ rng_state: number; particles: number; log_evidence: number }>;
  hypotheses: Array<{
    replica: number; multiplicity: number;
    /** Aggregate component weight within its independent numerical replica. */
    log_weight: number;
    incoming: ExchangeDynamics[]; posterior: ExchangePosterior;
    thermal_state_identified: boolean; hazards: ConnectedExchangeHazard[];
  }>;
}
/** Independent importance replicas contribute their unnormalized target mass.
 * This is not best-seed selection; even very small finite weights are retained. */
export function connectedProcessWeightedHypotheses(belief: ConnectedProcessBelief): ConnectedProcessBelief["hypotheses"] {
  const weighted = belief.hypotheses.map(h => ({ ...h, log_weight: h.log_weight + belief.replicas[h.replica].log_evidence }));
  const maximum = Math.max(...weighted.map(h => h.log_weight));
  return weighted.map(h => ({ ...h, log_weight: h.log_weight - maximum }));
}

export interface ConnectedRoomResponse {
  family: "adaptive_connected_native_v1";
  thermal: { outdoor_per_h: number; heater: ConnectedRoomHeater | null; solar_per_wm2_h: number; background_per_h: number };
  incoming: ExchangeDynamics[];
  /** White thermometer noise intensity; native means have variance intensity / hours. */
  observation_noise_c2_h: number;
  /** Unexplained thermal disturbance, separate from measurement and exchange process noise. */
  thermal_noise_c2_per_h: number;
  reference_state: ExchangePosterior;
  basis: ConnectedRoomBasis;
  evidence: Record<string, unknown>;
  process_belief?: ConnectedProcessBelief;
}
export interface ConnectedFilterDiagnostics {
  observed_intervals: number; unavailable_intervals: number; reinitializations: number;
  numerical_failures: number;
  negative_log_likelihood: number; squared_error_c2: number;
  thermal_state_identified: boolean;
}
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const nonnegative = (x: unknown): x is number => finite(x) && x >= 0;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const dynamic = (response: ConnectedRoomResponse) => response.incoming.filter((edge): edge is Extract<ExchangeDynamics, { kind: "log_ou" }> => edge.kind === "log_ou");
const matrix = (n: number) => Array.from({ length: n }, () => Array<number>(n).fill(0));

function validExchangeDynamics(edge: unknown): edge is ExchangeDynamics {
  return record(edge) && typeof edge.from === "string" && edge.from.length > 0 &&
    (edge.kind === "constant" ? nonnegative(edge.per_h) : edge.kind === "log_ou" && finite(edge.mean_log_per_h) && nonnegative(edge.reversion_per_h) && nonnegative(edge.stationary_variance));
}

export function readConnectedRoomResponse(value: unknown): ConnectedRoomResponse | null {
  if (!record(value) || value.family !== "adaptive_connected_native_v1" || !record(value.thermal) ||
    !record(value.reference_state) || !record(value.basis) || !record(value.evidence) || !Array.isArray(value.incoming)) return null;
  const t = value.thermal, h = t.heater, s = value.reference_state, b = value.basis;
  if (![t.outdoor_per_h, t.solar_per_wm2_h, value.observation_noise_c2_h, value.thermal_noise_c2_per_h].every(nonnegative) ||
    !finite(t.background_per_h) || !(Number(value.observation_noise_c2_h) > 0) ||
    h !== null && (!record(h) || ![h.gain_c_per_wh, h.lag_h].every(nonnegative) ||
      ![h.gain_reference_outdoor_c, h.gain_outdoor_slope_per_c].every(finite))) return null;
  const seen = new Set<string>();
  let dimensions = 2;
  for (const edge of value.incoming) {
    if (!validExchangeDynamics(edge) || seen.has(edge.from)) return null;
    seen.add(edge.from);
    if (edge.kind === "log_ou") dimensions++;
  }
  const edges = dimensions - 2;
  if (s.log_centers !== undefined) {
    if (!Array.isArray(s.log_centers) || s.log_centers.length !== edges || !s.log_centers.every(finite)) return null;
    dimensions += edges;
  }
  if (![s.through_ms, s.temperature_c].every(finite) || !nonnegative(s.stored_heat_c) || !Number.isSafeInteger(s.observations) || Number(s.observations) < 0 ||
    !Array.isArray(s.log_rates) || s.log_rates.length !== edges || !s.log_rates.every(finite) ||
    !Array.isArray(s.covariance) || s.covariance.length !== dimensions ||
    !s.covariance.every(row => Array.isArray(row) && row.length === dimensions && row.every(finite)) ||
    (b.graph_owner !== null && typeof b.graph_owner !== "string") ||
    (b.graph_revision !== null && (!Number.isSafeInteger(b.graph_revision) || Number(b.graph_revision) < 0)) ||
    ![b.topology_hash, b.source_policy, b.history_from, b.history_to].every(v => typeof v === "string") ||
    !Number.isFinite(Date.parse(String(b.history_from))) || !Number.isFinite(Date.parse(String(b.history_to))) ||
    !Number.isSafeInteger(b.source_revision) || Number(b.source_revision) < 0) return null;
  const covariance = s.covariance as number[][];
  if (covariance.some((row, i) => row[i] < 0 || row.some((v, j) => Math.abs(v - covariance[j][i]) >
    Number.EPSILON * 128 * Math.max(1, Math.abs(v), Math.abs(covariance[j][i])))) || !cholesky(covariance)) return null;
  if (value.process_belief !== undefined) {
    const belief = value.process_belief, incoming = value.incoming;
    if (!record(belief) || belief.revision !== "connected_process_regimes_v2" || !Array.isArray(belief.hypotheses) || !belief.hypotheses.length ||
      !Array.isArray(belief.replicas) || !belief.replicas.length || !Array.isArray(belief.reset_priors) ||
      !Array.isArray(belief.initial_incoming) || belief.initial_incoming.length !== incoming.length || belief.initial_incoming.some((e, i) => !validExchangeDynamics(e) || e.from !== (incoming[i] as ExchangeDynamics).from) ||
      !record(belief.initial_hazard) || !finite(belief.initial_hazard.shape) || belief.initial_hazard.shape <= 0 || !finite(belief.initial_hazard.rate_h) || belief.initial_hazard.rate_h <= 0) return null;
    const replicas = belief.replicas;
    if (replicas.some(r => !record(r) || !Number.isSafeInteger(r.rng_state) || Number(r.rng_state) < 0 || Number(r.rng_state) > 0xffffffff ||
      !Number.isSafeInteger(r.particles) || Number(r.particles) < 1 || !finite(r.log_evidence))) return null;
    const priorSources = new Set<string>();
    for (const prior of belief.reset_priors) {
      if (!record(prior) || typeof prior.from !== "string" || !seen.has(prior.from) || priorSources.has(prior.from) ||
        ![prior.center_mean, prior.log_reversion_mean].every(finite) ||
        ![prior.center_variance, prior.log_reversion_sd, prior.stationary_variance_scale, prior.constant_probability].every(nonnegative) || Number(prior.constant_probability) > 1) return null;
      priorSources.add(prior.from);
    }
    const counts = Array<number>(replicas.length).fill(0);
    for (const h of belief.hypotheses) {
      if (!record(h) || !finite(h.log_weight) || !Number.isSafeInteger(h.replica) || Number(h.replica) < 0 || Number(h.replica) >= replicas.length ||
        !Number.isSafeInteger(h.multiplicity) || Number(h.multiplicity) < 1 || typeof h.thermal_state_identified !== "boolean" ||
        !readConnectedRoomResponse({ ...value, process_belief: undefined, incoming: h.incoming, reference_state: h.posterior }) ||
        !Array.isArray(h.incoming) || h.incoming.length !== incoming.length || h.incoming.some((e, i) => !record(e) || e.from !== (incoming[i] as Record<string, unknown>).from) ||
        !Array.isArray(h.hazards) || h.hazards.length !== incoming.length || h.hazards.some(g => !record(g) || !finite(g.shape) || g.shape <= 0 || !finite(g.rate_h) || g.rate_h <= 0)) return null;
      counts[Number(h.replica)] += Number(h.multiplicity);
    }
    if (counts.some((count, i) => count !== (replicas[i] as Record<string, unknown>).particles)) return null;
  }
  return value as unknown as ConnectedRoomResponse;
}

/** A prediction of coefficients, not a claimed lower confidence bound on future warmth. */
export function forecastConnectedExchange(response: ConnectedRoomResponse, posterior: ExchangePosterior, elapsedHours: number): number[] {
  let j = 0;
  const m = posterior.log_rates.length, hours = Math.max(0, elapsedHours);
  return response.incoming.map(edge => {
    if (edge.kind === "constant") return edge.per_h;
    const a = Math.exp(-edge.reversion_per_h * hours), b = -Math.expm1(-edge.reversion_per_h * hours);
    const center = posterior.log_centers?.[j] ?? edge.mean_log_per_h;
    const mean = a * posterior.log_rates[j] + b * center;
    let variance = a * a * posterior.covariance[j + 2][j + 2] + -Math.expm1(-2 * edge.reversion_per_h * hours) * edge.stationary_variance;
    if (posterior.log_centers) variance += b * b * posterior.covariance[j + 2 + m][j + 2 + m] + 2 * a * b * posterior.covariance[j + 2][j + 2 + m];
    j++;
    return Math.exp(mean + variance / 2);
  });
}

/** Semidefinite Cholesky; only floating-point cancellation is rounded to zero. */
function cholesky(p: readonly (readonly number[])[]): number[][] | null {
  const n = p.length, l = matrix(n);
  const scale = Math.max(1, ...p.map((row, i) => Math.abs(row[i])));
  const roundoff = Number.EPSILON * 256 * n * scale;
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let value = p[i][j];
    for (let k = 0; k < j; k++) value -= l[i][k] * l[j][k];
    if (i === j) { if (value < -roundoff) return null; l[i][j] = Math.sqrt(Math.max(0, value)); }
    else if (l[j][j] > 0) l[i][j] = value / l[j][j];
    else if (Math.abs(value) > roundoff) return null;
  }
  return l;
}
function propagateRates(response: ConnectedRoomResponse, state: ExchangePosterior, hours: number): ExchangePosterior {
  const edges = dynamic(response), m = edges.length, n = state.covariance.length;
  // Sparse exact linear transform: z'=a*z+(1-a)*μ, μ'=μ. Keeping the full
  // transform preserves correlations learned from shared receiving evidence.
  const mapping: Array<Array<[number, number]>> = Array.from({ length: n }, (_, i) => [[i, 1]]);
  edges.forEach((edge, j) => {
    const a = Math.exp(-edge.reversion_per_h * hours), b = -Math.expm1(-edge.reversion_per_h * hours);
    mapping[j + 2] = state.log_centers ? [[j + 2, a], [j + 2 + m, b]] : [[j + 2, a]];
  });
  const covariance = matrix(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    for (const [u, a] of mapping[i]) for (const [v, b] of mapping[j]) covariance[i][j] += a * b * state.covariance[u][v];
  }
  const log_rates = state.log_rates.map((z, j) => {
    const edge = edges[j], a = Math.exp(-edge.reversion_per_h * hours), b = -Math.expm1(-edge.reversion_per_h * hours);
    covariance[j + 2][j + 2] += -Math.expm1(-2 * edge.reversion_per_h * hours) * edge.stationary_variance;
    return a * z + b * (state.log_centers?.[j] ?? edge.mean_log_per_h);
  });
  return { ...state, log_rates, covariance };
}

function heaterGain(response: ConnectedRoomResponse, outdoor: number): number {
  const h = response.thermal.heater;
  if (!h) return 0;
  if (h.gain_outdoor_slope_per_c === 0) return h.gain_c_per_wh;
  return finite(outdoor) ? h.gain_c_per_wh * Math.max(0, 1 + h.gain_outdoor_slope_per_c * (outdoor - h.gain_reference_outdoor_c)) : 0;
}
function knownStoredHeat(response: ConnectedRoomResponse, state: ExchangePosterior, hours: number, row?: ConnectedRoomObservation): number {
  const lag = response.thermal.heater?.lag_h ?? 0;
  if (!(lag > 0)) return 0;
  const carry = Math.exp(-hours / lag);
  const measured = row && finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row) ? row.heat_w : 0;
  return carry * state.stored_heat_c + lag * (1 - carry) * heaterGain(response, row?.outdoor_c ?? NaN) * measured;
}
function forcing(response: ConnectedRoomResponse, row: ConnectedRoomObservation, rates: readonly number[]) {
  let k = response.thermal.outdoor_per_h;
  let value = k * row.outdoor_c! + response.thermal.background_per_h + response.thermal.solar_per_wm2_h * (row.solar_w_per_m2 ?? 0);
  response.incoming.forEach((edge, i) => { if (rates[i] > 0) { k += rates[i]; value += rates[i] * row.peer_c![edge.from]!; } });
  return { k, value };
}
function inputKnown(response: ConnectedRoomResponse, row: ConnectedRoomObservation): boolean {
  if (row.inference_available === false) return false;
  const heaterKnown = response.thermal.heater === null ? response.evidence.unidentified_heater !== true || row.heat_w === 0 && roomHeatingDirectionKnown(row)
    : finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row);
  return finite(row.outdoor_c) && heaterKnown &&
    (response.thermal.solar_per_wm2_h === 0 || finite(row.solar_w_per_m2)) &&
    response.incoming.every(edge => edge.kind === "constant" && edge.per_h === 0 || finite(row.peer_c?.[edge.from]));
}

/** Integrated white thermal forcing: endpoint variance, mean variance, and their covariance. */
function thermalNoise(k: number, hours: number, intensity: number): [number, number, number] {
  if (intensity === 0) return [0, 0, 0];
  if (Math.abs(k * hours) < 1e-3) {
    const x = k * hours;
    return [intensity * hours * (1 - x + 2 * x * x / 3),
      intensity * hours * (1 / 3 - x / 4 + 7 * x * x / 60),
      intensity * hours * (.5 - x / 2 + 7 * x * x / 24)];
  }
  const e = -Math.expm1(-k * hours) / k, e2 = -Math.expm1(-2 * k * hours) / (2 * k);
  return [intensity * e2, intensity * (hours - 2 * e + e2) / (k * k * hours * hours),
    intensity * (e - e2) / (k * hours)];
}

/** One observation, once. The joint endpoint/interval-mean transform retains their covariance.
 * OU rates use a symmetric midpoint split; native thermal means are integrated analytically.
 * Positive cubature weights avoid cancellation from negative unscented-transform weights. */
export function advanceConnectedRoomObservation(response: ConnectedRoomResponse, previous: ExchangePosterior, row: ConnectedRoomObservation): {
  posterior: ExchangePosterior; negative_log_likelihood: number; squared_error_c2: number;
} | null {
  if (!inputKnown(response, row)) return null;
  const hours = (row.duration_s ?? 900) / 3600;
  const state = propagateRates(response, previous, hours / 2);
  const center = [state.temperature_c, state.stored_heat_c, ...state.log_rates, ...(state.log_centers ?? [])], n = center.length;
  const root = cholesky(state.covariance);
  if (!root) return null;
  const lag = response.thermal.heater?.lag_h ?? 0, heat = heaterGain(response, row.outdoor_c!) * (response.thermal.heater ? row.heat_w! : 0);
  const points: number[][] = [], means: number[] = [], losses: number[] = [];
  for (let column = 0; column < n; column++) for (const sign of [-1, 1]) {
    const x = center.map((v, j) => v + sign * Math.sqrt(n) * root[j][column]);
    let z = 2;
    const rates = response.incoming.map(edge => edge.kind === "constant" ? edge.per_h : Math.exp(x[z++]));
    const { k, value } = forcing(response, row, rates), op = roomMeanObservation(k, lag, hours);
    const t = x[0], q = x[1];
    const end = op.a * t + (lag > 0 ? op.B / lag : op.a) * q + (op.effect - op.B) * heat + op.effect * value;
    const mean = op.E * t + (lag > 0 ? op.U / lag : op.E) * q + (op.V - op.U) * heat + op.V * value;
    points.push([end, lag > 0 ? op.C * q + lag * (1 - op.C) * heat : 0, ...x.slice(2)]);
    means.push(mean); losses.push(k);
  }
  const weight = 1 / points.length, next = center.map((_, j) => points.reduce((sum, p) => sum + weight * p[j], 0));
  const mean = means.reduce((sum, v) => sum + weight * v, 0), p = matrix(n), cross = Array<number>(n).fill(0);
  let variance = 0;
  points.forEach((point, at) => {
    const dy = means[at] - mean;
    variance += weight * dy * dy;
    for (let i = 0; i < n; i++) {
      cross[i] += weight * (point[i] - next[i]) * dy;
      for (let j = 0; j <= i; j++) p[i][j] += weight * (point[i] - next[i]) * (point[j] - next[j]);
    }
  });
  const noise = thermalNoise(losses.reduce((sum, k) => sum + weight * k, 0), hours, response.thermal_noise_c2_per_h);
  p[0][0] += noise[0]; variance += noise[1]; cross[0] += noise[2];
  const innovationVariance = variance + response.observation_noise_c2_h / hours;
  if (!(innovationVariance > 0) || !Number.isFinite(innovationVariance) || next.some(v => !Number.isFinite(v))) return null;
  const observed = finite(row.room_c), residual = observed ? row.room_c! - mean : 0;
  if (observed) for (let i = 0; i < n; i++) next[i] += cross[i] * residual / innovationVariance;
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    if (observed) p[i][j] -= cross[i] * cross[j] / innovationVariance;
    p[j][i] = p[i][j];
  }
  // Q is determined by measured electrical injection and the captured initial
  // stored heat. It is not an unconstrained source inferred from a warm residual.
  if (next[1] < 0 && next[1] > -Number.EPSILON * 256) next[1] = 0;
  if (next[1] < 0 || !cholesky(p)) return null;
  // Metered heater memory is a deterministic known contribution. Do not let
  // covariance roundoff or a temperature innovation manufacture stored heat.
  next[1] = knownStoredHeat(response, previous, hours, row);
  for (let i = 0; i < n; i++) { p[1][i] = 0; p[i][1] = 0; }
  const posterior = propagateRates(response, { through_ms: row.start_ms + hours * 3_600_000,
    temperature_c: next[0], stored_heat_c: next[1], log_rates: next.slice(2, 2 + state.log_rates.length),
    ...(state.log_centers ? { log_centers: next.slice(2 + state.log_rates.length) } : {}), covariance: p,
    observations: previous.observations + Number(observed) }, hours / 2);
  return { posterior, negative_log_likelihood: observed ? .5 * (Math.log(2 * Math.PI * innovationVariance) + residual ** 2 / innovationVariance) : 0,
    squared_error_c2: residual ** 2 };
}

/** The first native mean determines an entry boundary through the same observation
 * operator. Unknown prehistory supplies no invented stored heater heat. */
export function initializeConnectedRoomState(response: ConnectedRoomResponse, row: ConnectedRoomObservation,
  ratesFrom?: ExchangePosterior): ExchangePosterior | null {
  if (!finite(row.room_c) || !inputKnown(response, row)) return null;
  const edges = dynamic(response), centers = ratesFrom?.log_centers, n = edges.length + 2 + (centers ? edges.length : 0), covariance = matrix(n);
  const logs = ratesFrom?.log_rates ?? edges.map(edge => edge.mean_log_per_h);
  edges.forEach((edge, i) => { covariance[i + 2][i + 2] = ratesFrom?.covariance[i + 2][i + 2] ?? edge.stationary_variance; });
  if (ratesFrom) for (let i = 2; i < n; i++) for (let j = 2; j < n; j++) covariance[i][j] = ratesFrom.covariance[i][j];
  const lag = response.thermal.heater?.lag_h ?? 0;
  const knownStored = ratesFrom && lag > 0 ? ratesFrom.stored_heat_c * Math.exp(-Math.max(0, row.start_ms - ratesFrom.through_ms) / 3_600_000 / lag) : 0;
  const seed = { through_ms: row.start_ms, temperature_c: row.room_c, stored_heat_c: knownStored, log_rates: logs, ...(centers ? { log_centers: centers } : {}), covariance, observations: 0 };
  const { k, value } = forcing(response, row, forecastConnectedExchange(response, seed, 0));
  const hours = (row.duration_s ?? 900) / 3600, op = roomMeanObservation(k, lag, hours);
  const heat = heaterGain(response, row.outdoor_c!) * (response.thermal.heater ? row.heat_w! : 0);
  seed.temperature_c = (row.room_c - (lag > 0 ? op.U / lag : op.E) * knownStored - (op.V - op.U) * heat - op.V * value) / op.E;
  // This mean has already located the entry state; don't score it twice.
  covariance[0][0] = response.observation_noise_c2_h / (hours * op.E ** 2);
  const advanced = advanceConnectedRoomObservation(response, seed, { ...row, room_c: null });
  return advanced ? { ...advanced.posterior, observations: (ratesFrom?.observations ?? 0) + 1 } : null;
}

/** Recompute from the supplied evidence prefix. Callers may supply a checkpoint
 * only after verifying every prefix block's identity against received evidence. */
export function filterConnectedRoomExchange(response: ConnectedRoomResponse, rows: readonly ConnectedRoomObservation[], throughMs: number,
  initial?: ExchangePosterior, initialThermalStateIdentified = true): { posterior: ExchangePosterior; diagnostics: ConnectedFilterDiagnostics } {
  let state = initial ?? null, identified = initial !== undefined && initialThermalStateIdentified;
  const diagnostics: ConnectedFilterDiagnostics = { observed_intervals: 0, unavailable_intervals: 0, reinitializations: 0,
    numerical_failures: 0, negative_log_likelihood: 0, squared_error_c2: 0, thermal_state_identified: false };
  for (const row of rows) {
    const end = row.start_ms + (row.duration_s ?? 900) * 1000;
    if (end > throughMs || initial && row.start_ms < initial.through_ms) continue;
    if (state && row.start_ms > state.through_ms) {
      const h = (row.start_ms - state.through_ms) / 3_600_000, lag = response.thermal.heater?.lag_h ?? 0;
      state = { ...propagateRates(response, state, h), stored_heat_c: lag > 0 ? state.stored_heat_c * Math.exp(-h / lag) : 0, through_ms: row.start_ms };
      identified = false;
    }
    if (!state || !identified) {
      const seeded = initializeConnectedRoomState(response, row, state ?? undefined);
      if (seeded) { state = seeded; identified = true; diagnostics.reinitializations++; diagnostics.observed_intervals++; continue; }
    }
    const next = state && identified ? advanceConnectedRoomObservation(response, state, row) : null;
    if (next) {
      state = next.posterior; diagnostics.observed_intervals += Number(finite(row.room_c));
      diagnostics.negative_log_likelihood += next.negative_log_likelihood; diagnostics.squared_error_c2 += next.squared_error_c2;
    } else {
      diagnostics.unavailable_intervals++; identified = false;
      if (inputKnown(response, row) && finite(row.room_c)) diagnostics.numerical_failures++;
      if (state) {
        const h = Math.max(0, end - state.through_ms) / 3_600_000;
        // Missing measured electricity adds no useful heat, but cannot erase stored heat.
        state = { ...propagateRates(response, state, h), stored_heat_c: knownStoredHeat(response, state, h, row), through_ms: end };
      }
    }
  }
  // Parameter/posterior absence never invents a thermal starting observation.
  // The caller retains empirical comfort when no supported state exists.
  state ??= structuredClone(response.reference_state);
  if (state.through_ms < throughMs) {
    const hours = (throughMs - state.through_ms) / 3_600_000;
    state = { ...propagateRates(response, state, hours), stored_heat_c: knownStoredHeat(response, state, hours), through_ms: throughMs };
    identified = false;
  }
  diagnostics.thermal_state_identified = identified;
  return { posterior: state, diagnostics };
}
