import type { RoomMeanQuarter } from "./mean-observations.ts";
import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import {
  connectedProcessWeightedHypotheses, filterConnectedRoomExchange,
  type ConnectedExchangeHazard, type ConnectedExchangeResetPrior, type ConnectedProcessBelief,
  type ConnectedRoomResponse, type ExchangeDynamics, type ExchangePosterior,
} from "../../planner/models/room/connected-exchange.ts";

/** Numerical integration population, not a physical threshold or history window. */
export const CONNECTED_PROCESS_POINTS = 256;
export const CONNECTED_PROCESS_REPLICAS = 4;
type Hypothesis = ConnectedProcessBelief["hypotheses"][number];
export interface ConnectedProcessProgress {
  version: 2; cursor: number; model: ConnectedRoomResponse; belief: ConnectedProcessBelief;
  identified: boolean[]; numerical_failures: number; complete: boolean;
  work?: { through_ms: number; replica: number; parent: number; copy: number; rng_state: number;
    children: Hypothesis[]; candidates: Array<{ child: number; log_weight: number }>;
    continuation?: { child: Hypothesis; potential: number; retained?: number } };
}
const end = (r: RoomMeanQuarter) => r.start_ms + (r.duration_s ?? 900) * 1000;
const logAdd = (a: number, b: number) => {
  const m = Math.max(a, b);
  return m === -Infinity ? m : m + Math.log(Math.exp(a - m) + Math.exp(b - m));
};
class Random {
  constructor(public state: number) {}
  uniform(): number { this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0; return (this.state + .5) / 4294967296; }
  normal(): number { return Math.sqrt(-2 * Math.log(this.uniform())) * Math.cos(2 * Math.PI * this.uniform()); }
  gamma(shape: number): number {
    if (shape < 1) return this.gamma(shape + 1) * this.uniform() ** (1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.normal(), v = (1 + c * x) ** 3;
      if (v > 0 && Math.log(this.uniform()) < x * x / 2 + d - d * v + d * Math.log(v)) return d * v;
    }
  }
}
function sampledDynamics(prior: ConnectedExchangeResetPrior, rng: Random): ExchangeDynamics {
  const constant = rng.uniform() < prior.constant_probability;
  return { kind: "log_ou", from: prior.from, mean_log_per_h: prior.center_mean,
    reversion_per_h: constant ? 0 : Math.exp(prior.log_reversion_mean + prior.log_reversion_sd * rng.normal()),
    stationary_variance: constant ? 0 : prior.stationary_variance_scale * Math.abs(rng.normal()) };
}
/** Exact Gamma-Poisson count posterior conditional on one or more events.
 * Inversion uses the negative-binomial recurrence; tiny survival is handled by
 * the equivalent Gamma/Poisson mixture without an arbitrary count truncation. */
function resetCount(hazard: ConnectedExchangeHazard, hours: number, rng: Random): number {
  const { shape: a, rate_h: b } = hazard, logP0 = -a * Math.log1p(hours / b), p0 = Math.exp(logP0);
  if (p0 > .01) {
    let target = rng.uniform() * -Math.expm1(logP0), probability = p0, count = 0;
    do { count++; probability *= ((a + count - 1) / count) * (hours / (b + hours)); target -= probability; }
    while (target > 0 && probability > 0);
    if (target > 0) throw new Error("Unresolved reset count probability");
    return count;
  }
  // Poisson additivity permits exact exponential waiting-time draws in bounded
  // intensity pieces. Large means use the exact gamma waiting-time identity:
  // splitting at a gamma-distributed arrival reduces the remaining mean.
  const poisson = (mean: number): number => {
    let count = 0;
    while (mean > 16) {
      const half = Math.floor(mean / 2), arrival = rng.gamma(half);
      if (arrival <= mean) { count += half; mean -= arrival; }
      else {
        // Conditional on this arrival time, the earlier arrivals are uniform.
        // A binomial draw needs only O(log(mean)) expected work after this split.
        const probability = mean / arrival;
        for (let i = 0; i < half - 1; i++) count += Number(rng.uniform() < probability);
        return count;
      }
      if (!Number.isSafeInteger(count)) throw new Error("Unrepresentable reset count");
    }
    let elapsed = 0;
    for (;;) { elapsed -= Math.log(rng.uniform()); if (elapsed > mean) return count; count++; }
  };
  for (;;) { const count = poisson(rng.gamma(a) * hours / b); if (count > 0) return count; }
}
function frozenPriors(model: ConnectedRoomResponse, rows: readonly RoomMeanQuarter[]): { priors: ConnectedExchangeResetPrior[]; initialHazard: ConnectedExchangeHazard } {
  const basisEnd = Date.parse(model.basis.history_to), accepted = rows.filter(row => end(row) <= basisEnd);
  const durations = accepted.map(r => (r.duration_s ?? 900) / 3600).sort((a, b) => a - b);
  const nativeHours = durations[Math.floor(durations.length / 2)] ?? .25;
  if (model.process_belief) {
    return { priors: structuredClone(model.process_belief.reset_priors), initialHazard: { ...model.process_belief.initial_hazard } };
  }
  const historyHours = Math.max(nativeHours, (basisEnd - Date.parse(model.basis.history_from)) / 3_600_000);
  const scale = Math.max(model.thermal.outdoor_per_h, ...model.incoming.map(e => e.kind === "constant" ? e.per_h : Math.exp(e.mean_log_per_h)));
  const priors = model.incoming.flatMap(edge => {
    const level = edge.kind === "constant" ? edge.per_h : Math.exp(edge.mean_log_per_h);
    if (level === 0) {
      if (scale === 0) return [];
      const contrasts = accepted.flatMap(row => Number.isFinite(row.room_c) && Number.isFinite(row.outdoor_c) && Number.isFinite(row.peer_c?.[edge.from]) &&
        (model.thermal.solar_per_wm2_h === 0 || Number.isFinite(row.solar_w_per_m2)) &&
        (model.thermal.heater === null ? model.evidence.unidentified_heater !== true || row.heat_w === 0 && roomHeatingDirectionKnown(row)
          : Number.isFinite(row.heat_w) && row.heat_w! >= 0 && roomHeatingDirectionKnown(row))
        ? [row.peer_c![edge.from]! - row.room_c!] : []);
      if (contrasts.length < 2 || !contrasts.some(x => Math.abs(x - contrasts[0]) > Number.EPSILON * 256 * Math.max(1, Math.abs(x), Math.abs(contrasts[0])))) return [];
    }
    const rate = level || scale;
    return [{ from: edge.from, center_mean: Math.log(rate), center_variance: Math.log1p((scale / rate) ** 2),
      log_reversion_mean: -Math.log(Math.sqrt(nativeHours * historyHours)), log_reversion_sd: Math.log(historyHours / nativeHours) / Math.sqrt(12),
      stationary_variance_scale: 1, constant_probability: .5 }];
  });
  return { priors, initialHazard: { shape: .5, rate_h: nativeHours } };
}
function initialPosterior(incoming: ExchangeDynamics[], priors: ConnectedExchangeResetPrior[], through: number): ExchangePosterior {
  const edges = incoming.filter(e => e.kind === "log_ou"), m = edges.length, n = 2 + 2 * m;
  const covariance = Array.from({ length: n }, () => Array<number>(n).fill(0));
  edges.forEach((edge, i) => {
    const variance = priors.find(p => p.from === edge.from)!.center_variance;
    covariance[2 + i][2 + i] = covariance[2 + m + i][2 + m + i] = covariance[2 + i][2 + m + i] = covariance[2 + m + i][2 + i] = variance;
  });
  const centers = edges.map(edge => edge.mean_log_per_h);
  return { through_ms: through, temperature_c: 0, stored_heat_c: 0, observations: 0, log_rates: centers, log_centers: [...centers], covariance };
}

/** Resets only selected edges. Reindexing a formerly zero edge preserves the
 * entire unselected T/Q/z/μ covariance submatrix, including cross-edge terms. */
function resetEdges(h: Hypothesis, mask: boolean[], priors: Map<string, ConnectedExchangeResetPrior>, hours: number, rng: Random): Hypothesis {
  const incoming = h.incoming.map((edge, i) => mask[i] ? sampledDynamics(priors.get(edge.from)!, rng) : edge);
  const oldEdges = h.incoming.filter(e => e.kind === "log_ou"), newEdges = incoming.filter(e => e.kind === "log_ou");
  const oldCount = oldEdges.length, count = newEdges.length, n = 2 + 2 * count;
  const oldIndex = new Map(oldEdges.map((edge, i) => [edge.from, i]));
  const mapping: Array<number | null> = [0, 1, ...Array<number | null>(2 * count).fill(null)];
  const rates: number[] = [], centers: number[] = [];
  newEdges.forEach((edge, i) => {
    const old = oldIndex.get(edge.from), reset = mask[incoming.findIndex(e => e.from === edge.from)];
    if (!reset && old !== undefined) {
      mapping[2 + i] = 2 + old; mapping[2 + count + i] = 2 + oldCount + old;
      rates.push(h.posterior.log_rates[old]); centers.push(h.posterior.log_centers![old]);
    } else { rates.push(priors.get(edge.from)!.center_mean); centers.push(priors.get(edge.from)!.center_mean); }
  });
  const covariance = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    mapping[i] !== null && mapping[j] !== null ? h.posterior.covariance[mapping[i]!][mapping[j]!] : 0));
  newEdges.forEach((edge, i) => {
    if (mapping[2 + i] !== null) return;
    const variance = priors.get(edge.from)!.center_variance;
    covariance[2 + i][2 + i] = covariance[2 + count + i][2 + count + i] = covariance[2 + i][2 + count + i] = covariance[2 + count + i][2 + i] = variance;
  });
  return { ...h, incoming, posterior: { ...h.posterior, log_rates: rates, log_centers: centers, covariance },
    hazards: h.hazards.map((hazard, i) => priors.has(incoming[i].from)
      ? { shape: hazard.shape + (mask[i] ? resetCount(hazard, hours, rng) : 0), rate_h: hazard.rate_h + hours } : hazard) };
}

/** Caller proves the exact source-qualified prefix before supplying a checkpoint.
 * The frozen prior and random states live in that checkpoint, never rederived. */
export function beginConnectedProcessInference(model: ConnectedRoomResponse, rows: readonly RoomMeanQuarter[], previous?: ConnectedProcessBelief,
  points = CONNECTED_PROCESS_POINTS): ConnectedProcessProgress {
  const { process_belief: _old, ...body } = model;
  const initialEdges = previous?.initial_incoming ?? model.process_belief?.initial_incoming ?? model.incoming;
  if (model.thermal.outdoor_per_h === 0 && initialEdges.every(edge => edge.kind === "constant" && edge.per_h === 0)) {
    body.evidence = { ...body.evidence, process_unresolved_scale_peers: initialEdges.map(edge => edge.from) };
  }
  if (previous) {
    const through = previous.hypotheses[0]?.posterior.through_ms;
    if (previous.revision !== "connected_process_regimes_v2" || through === undefined || previous.hypotheses.some(h => h.posterior.through_ms !== through)) throw new Error("Incompatible exchange posterior checkpoint");
    const first = rows.findIndex(row => end(row) > through);
    body.evidence = { ...body.evidence, process_native_hours: previous.initial_hazard.rate_h };
    return { version: 2, cursor: first < 0 ? rows.length : first, model: body, belief: structuredClone(previous),
      identified: previous.hypotheses.map(h => h.thermal_state_identified), numerical_failures: 0, complete: false };
  }
  if (!Number.isSafeInteger(points) || points < 1) throw new Error("Invalid process particle population");
  const { priors, initialHazard } = frozenPriors(model, rows), byPeer = new Map(priors.map(prior => [prior.from, prior]));
  const initialIncoming = structuredClone(model.process_belief?.initial_incoming ?? model.incoming);
  body.evidence = { ...body.evidence, process_native_hours: initialHazard.rate_h };
  const through = rows[0]?.start_ms ?? Date.parse(model.basis.history_from), hypotheses: Hypothesis[] = [];
  const replicas = [41, 317, 997, 12593].map((seed, replica) => {
    const rng = new Random(seed);
    const unique = new Map<string, Hypothesis>();
    for (let i = 0; i < points; i++) {
      const incoming = initialIncoming.map(edge => edge.kind === "constant" && edge.per_h === 0 || !byPeer.has(edge.from) ? { ...edge } : sampledDynamics(byPeer.get(edge.from)!, rng));
      const key = JSON.stringify(incoming), same = unique.get(key);
      if (same) { same.multiplicity++; same.log_weight = Math.log(same.multiplicity / points); continue; }
      unique.set(key, { replica, multiplicity: 1, log_weight: -Math.log(points), incoming,
        posterior: initialPosterior(incoming, priors, through), thermal_state_identified: false,
        hazards: model.incoming.map(() => ({ ...initialHazard })) });
    }
    hypotheses.push(...unique.values());
    return { rng_state: rng.state, particles: points, log_evidence: 0 };
  });
  return { version: 2, cursor: 0, model: body, belief: { revision: "connected_process_regimes_v2", reset_priors: priors, initial_hazard: initialHazard, initial_incoming: initialIncoming, replicas, hypotheses },
    identified: hypotheses.map(() => false), numerical_failures: 0, complete: false };
}

function advancePopulation(state: ConnectedProcessProgress, row: RoomMeanQuarter | undefined, through: number, deadline: number): boolean {
  const priors = new Map(state.belief.reset_priors.map(p => [p.from, p]));
  const enabled = state.model.incoming.map(edge => priors.has(edge.from)), edgeCount = enabled.filter(Boolean).length;
  const proposal = edgeCount ? 1 / edgeCount : 0, subsetNormalizer = edgeCount ? -Math.expm1(edgeCount * Math.log1p(-proposal)) : 0;
  const chunk = row ? [state.model.incoming.some(edge => (priors.has(edge.from) || edge.kind !== "constant" || edge.per_h > 0) && !Number.isFinite(row.peer_c?.[edge.from]))
    ? { ...row, inference_available: false } : row] : [];
  const work = state.work ??= { through_ms: through, replica: 0, parent: 0, copy: 0,
    rng_state: state.belief.replicas[0].rng_state, children: [], candidates: [] };
  if (work.through_ms !== through) throw new Error("Changed in-flight native observation");
  do {
    const replica = work.replica, descriptor = state.belief.replicas[replica], rng = new Random(work.rng_state);
    const population = state.belief.hypotheses.filter(h => h.replica === replica), parent = population[work.parent];
    if (parent) {
      const hours = Math.max(0, through - parent.posterior.through_ms) / 3_600_000;
      const survival = parent.hazards.map((hazard, i) => enabled[i] ? -hazard.shape * Math.log1p(hours / hazard.rate_h) : 0);
      const branches: Array<{ child: Hypothesis; potential: number; retained?: number }> = [];
      for (const reset of edgeCount && hours > 0 ? [false, true] : [false]) {
        if (!reset && work.continuation) { branches.push(work.continuation); continue; }
        let mask = enabled.map(() => false);
        if (reset) { do { mask = enabled.map(active => active && rng.uniform() < proposal); } while (!mask.some(Boolean)); }
        let logPrior = 0, logProposal = 0;
        for (let i = 0; i < enabled.length; i++) if (enabled[i]) {
          logPrior += mask[i] ? Math.log(-Math.expm1(survival[i])) : survival[i];
          if (reset) logProposal += mask[i] ? Math.log(proposal) : Math.log1p(-proposal);
        }
        if (reset) logPrior -= logProposal - Math.log(subsetNormalizer);
        const child = resetEdges(parent, mask, priors, hours, rng);
        const filtered = filterConnectedRoomExchange({ ...state.model, incoming: child.incoming, reference_state: child.posterior }, chunk,
          through, child.posterior, child.thermal_state_identified);
        const potential = logPrior - filtered.diagnostics.negative_log_likelihood;
        const failed = filtered.diagnostics.numerical_failures > 0 || !Number.isFinite(potential);
        if (failed) state.numerical_failures++;
        const branch = { child: { ...child, posterior: filtered.posterior, thermal_state_identified: filtered.diagnostics.thermal_state_identified },
          potential: failed ? -Number.MAX_VALUE : potential };
        branches.push(branch); if (!reset) work.continuation = branch;
      }
      const normalizer = branches.reduce((sum, branch) => logAdd(sum, branch.potential), -Infinity);
      const failed = normalizer === -Number.MAX_VALUE || !Number.isFinite(normalizer);
      const chosen = failed || branches.length === 1 || rng.uniform() < Math.exp(branches[0].potential - normalizer) ? branches[0] : branches[1];
      // Integer references preserve exact duplicate children across JSON progress
      // checkpoints; object identity alone would change the resampling result.
      const child = chosen.retained ?? (chosen.retained = work.children.push(chosen.child) - 1);
      work.candidates.push({ child, log_weight: failed ? -Number.MAX_VALUE : parent.log_weight - Math.log(parent.multiplicity) + normalizer });
      work.rng_state = rng.state;
      if (++work.copy === parent.multiplicity) { work.parent++; work.copy = 0; delete work.continuation; }
    } else {
      const normalization = work.candidates.reduce((sum, candidate) => logAdd(sum, candidate.log_weight), -Infinity);
      if (!Number.isFinite(normalization) || normalization === -Number.MAX_VALUE) throw new Error("No finite exchange particle population");
      const weights = work.candidates.map(c => Math.exp(c.log_weight - normalization));
      const ess = 1 / weights.reduce((sum, weight) => sum + weight * weight, 0), merged = new Map<number, Hypothesis>();
      const retain = (child: number, logWeight: number) => {
        const same = merged.get(child);
        if (same) { same.log_weight = logAdd(same.log_weight, logWeight); same.multiplicity++; }
        else merged.set(child, { ...work.children[child], replica, multiplicity: 1, log_weight: logWeight });
      };
      if (ess < descriptor.particles / 2) {
        let j = 0, cumulative = weights[0];
        for (let i = 0; i < descriptor.particles; i++) {
          const point = (i + rng.uniform()) / descriptor.particles;
          while (point > cumulative && j < work.candidates.length - 1) cumulative += weights[++j];
          retain(work.candidates[j].child, -Math.log(descriptor.particles));
        }
      } else work.candidates.forEach(c => retain(c.child, c.log_weight - normalization));
      // Internal progress may contain replicas at adjacent row boundaries. Only
      // a finished native row is exposed as a reusable source-prefix belief.
      state.belief.hypotheses = [...state.belief.hypotheses.filter(h => h.replica !== replica), ...merged.values()]
        .sort((a, b) => a.replica - b.replica);
      descriptor.rng_state = rng.state; descriptor.log_evidence += normalization;
      work.replica++; work.parent = 0; work.copy = 0; work.children = []; work.candidates = []; delete work.continuation;
      if (work.replica === state.belief.replicas.length) {
        delete state.work; state.identified = state.belief.hypotheses.map(h => h.thermal_state_identified); return true;
      }
      work.rng_state = state.belief.replicas[work.replica].rng_state;
    }
  } while (performance.now() < deadline);
  return false;
}

/** Requests may stop between conceptual particles. Only complete native rows
 * become reusable beliefs; RNG and child IDs preserve exact JSON continuation.
 * Reset time is approximated at the start of the elapsed native interval. */
export function advanceConnectedProcessInference(rows: readonly RoomMeanQuarter[], previous: ConnectedProcessProgress, throughMs: number, milliseconds = 600): ConnectedProcessProgress {
  const started = performance.now(), state = structuredClone(previous);
  if (state.version !== 2) throw new Error("Incompatible exchange inference progress");
  // Empty input is an explicit projection, including the existing direct caller
  // that supplies a completed prefix progress rather than beginning a new slice.
  if (rows.length === 0) state.cursor = 0;
  do {
    const row = rows[state.cursor];
    if (row) {
      if (!advancePopulation(state, row, end(row), started + milliseconds)) { state.complete = false; return state; }
      state.cursor++;
    } else if (state.work || state.belief.hypotheses[0].posterior.through_ms < throughMs) {
      if (!advancePopulation(state, undefined, throughMs, started + milliseconds)) { state.complete = false; return state; }
    }
    state.complete = state.cursor === rows.length && !state.work && state.belief.hypotheses.every(h => h.posterior.through_ms >= throughMs);
  } while (!state.complete && performance.now() - started < milliseconds);
  return state;
}
export function connectedProcessResponse(progress: ConnectedProcessProgress): ConnectedRoomResponse {
  if (!progress.complete) throw new Error("Incomplete exchange posterior");
  const weighted = connectedProcessWeightedHypotheses(progress.belief), winner = weighted.reduce((a, b) => a.log_weight >= b.log_weight ? a : b);
  const replicaLogs = progress.belief.replicas.map(r => r.log_evidence), normalization = replicaLogs.reduce(logAdd, -Infinity);
  const replicaESS = 1 / replicaLogs.reduce((sum, value) => sum + Math.exp(2 * (value - normalization)), 0);
  return { ...progress.model, incoming: winner.incoming, reference_state: winner.posterior, process_belief: progress.belief,
    evidence: { ...progress.model.evidence, process_inference: "locally_adapted_edge_reset_rbpf_v2", process_reset_time: "native_interval_start",
      process_points: progress.belief.replicas.reduce((sum, r) => sum + r.particles, 0), process_distinct_points: weighted.length,
      process_replica_ess: replicaESS, process_replica_log_evidence: replicaLogs,
      process_numerical_failures: progress.numerical_failures, thermal_state_identified: winner.thermal_state_identified } };
}
/** Transient prediction includes reset uncertainty. Never persist its advanced
 * clock as measured evidence; late observations must still update the cache. */
export function propagateConnectedProcessResponse(response: ConnectedRoomResponse, throughMs: number): ConnectedRoomResponse {
  if (!response.process_belief) throw new Error("Missing connected process posterior");
  let progress = beginConnectedProcessInference(response, [], response.process_belief);
  while (!progress.complete) progress = advanceConnectedProcessInference([], progress, throughMs);
  return connectedProcessResponse(progress);
}
