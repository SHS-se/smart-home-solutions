// Learn the response of the WATER READING to compressor electricity. The
// reservoir is an effective delayed contribution: these observations cannot
// distinguish water mixing, intermediate thermal storage and sensor filtering.
import { solveLinearSystem } from "./planner/thermal-model.ts";
import type { PoolResponseSample } from "./pool-training.ts";
import { projectHeatPumpResponse, type HeatPumpResponse } from "./planner/device-models.ts";
import type { PoolStateInput } from "./planner/planning-contracts.ts";
import type { PoolDynamics } from "./planner/pool-response.ts";
export type { PoolDynamics } from "./planner/pool-response.ts";

const HOURS = 0.25, SLOT_MS = HOURS * 3_600_000;
export type PoolDynamicsFit = { fitted: PoolDynamics } | { rejected: "unidentifiable"; sample_count: number };
interface Row { x: [number, number]; z: number; y: number }
interface Segment { samples: PoolResponseSample[]; rows: Row[]; pending: number; decay: number; initial: number }
interface Candidate { tau: number; gain: number; cooling: number; mse: number; segments: Segment[] }

/** Each contiguous observation sequence has its own unknown starting memory. */
function segments(samples: readonly PoolResponseSample[]): PoolResponseSample[][] {
  const usable = samples.filter(s => [s.start_ms, s.water_temperature_c, s.next_water_temperature_c, s.electrical_kwh].every(Number.isFinite) && s.electrical_kwh >= 0)
    .slice().sort((a, b) => a.start_ms - b.start_ms);
  const result: PoolResponseSample[][] = [];
  for (const sample of usable) {
    const previous = result.at(-1)?.at(-1);
    if (!previous || sample.start_ms - previous.start_ms !== SLOT_MS) result.push([]);
    result.at(-1)!.push(sample);
  }
  return result;
}

/** Lawson–Hanson NNLS on an arrowhead normal matrix. Gain and cooling are
 * shared; each sequence's initial memory touches only its own observations.
 * Every passive solve therefore needs at most a 2x2 Schur complement, even
 * for fragmented history. Boundary variables can re-enter on a KKT violation. */
function nonnegativeResponseFit(series: Segment[]): number[] | null {
  const global = [[0, 0], [0, 0]], target = [0, 0];
  let rowCount = 0;
  const nuisance = series.map(s => {
    let zz = 0, zy = 0;
    const zx = [0, 0];
    for (const r of s.rows) {
      rowCount++;
      zz += r.z * r.z; zy += r.z * r.y;
      for (let i = 0; i < 2; i++) {
        target[i] += r.x[i] * r.y; zx[i] += r.z * r.x[i];
        for (let j = 0; j < 2; j++) global[i][j] += r.x[i] * r.x[j];
      }
    }
    return { zz, zy, zx };
  });
  const norms = [Math.sqrt(global[0][0]), Math.sqrt(global[1][1]), ...nuisance.map(n => Math.sqrt(n.zz))];
  if (!(norms[0] > 0) || !(norms[1] > 0)) return null;
  const correlation = global[0][1] / norms[0] / norms[1];
  const gram = [[1, correlation], [correlation, 1]];
  // Constant power cannot identify both heat gain and standing loss.
  if (!solveLinearSystem(gram, [0, 0])) return null;
  const links = nuisance.map((n, i) => n.zz > 0 ? n.zx.map((v, j) => v / norms[j] / norms[i + 2]) : [0, 0]);
  const rhs = [...target.map((v, i) => v / norms[i]), ...nuisance.map((n, i) => n.zz > 0 ? n.zy / norms[i + 2] : 0)];
  const size = rhs.length, passive = rhs.map(() => false);
  let x = rhs.map(() => 0);
  const tolerance = Number.EPSILON * Math.max(1, ...rhs.map(Math.abs)) * Math.max(rowCount, size) * 8;
  const gradient = () => {
    const w = rhs.slice();
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) w[i] -= gram[i][j] * x[j];
    links.forEach((link, i) => {
      w[0] -= link[0] * x[i + 2]; w[1] -= link[1] * x[i + 2];
      w[i + 2] -= link[0] * x[0] + link[1] * x[1] + x[i + 2];
    });
    return w;
  };
  const solvePassive = (): number[] | null => {
    const active = [0, 1].filter(i => passive[i]);
    const matrix = active.map(i => active.map(j => gram[i][j])), vector = active.map(i => rhs[i]);
    links.forEach((link, index) => {
      if (!passive[index + 2]) return;
      active.forEach((i, row) => {
        vector[row] -= link[i] * rhs[index + 2];
        active.forEach((j, col) => { matrix[row][col] -= link[i] * link[j]; });
      });
    });
    const solution = active.length ? solveLinearSystem(matrix, vector) : [];
    if (!solution || !solution.every(Number.isFinite)) return null;
    const result = rhs.map(() => 0);
    active.forEach((i, j) => { result[i] = solution[j]; });
    links.forEach((link, index) => {
      if (passive[index + 2]) result[index + 2] = rhs[index + 2] - link[0] * result[0] - link[1] * result[1];
    });
    return result;
  };
  let iterations = 0;
  // Numerical convergence bound for NNLS, independent of heating durations.
  while (iterations++ < 30 * size) {
    const w = gradient();
    let entering = -1;
    for (let i = 0; i < size; i++) if (!passive[i] && norms[i] > 0 && w[i] > tolerance && (entering < 0 || w[i] > w[entering])) entering = i;
    if (entering < 0) return x.map((v, i) => norms[i] > 0 ? v / norms[i] : 0);
    passive[entering] = true;
    while (iterations++ < 30 * size) {
      const next = solvePassive();
      if (!next) return null;
      if (next.every((v, i) => !passive[i] || v > 0)) { x = next; break; }
      let fraction = 1, boundary = -1;
      next.forEach((v, i) => {
        if (!passive[i] || v > 0) return;
        const share = x[i] === v ? 0 : x[i] / (x[i] - v);
        if (share <= fraction) { fraction = share; boundary = i; }
      });
      x = x.map((v, i) => v + fraction * (next[i] - v));
      for (let i = 0; i < size; i++) if (passive[i] && (i === boundary || x[i] <= 0)) { passive[i] = false; x[i] = 0; }
    }
  }
  return null;
}

function candidate(groups: PoolResponseSample[][], tau: number): Candidate | null {
  const series: Segment[] = groups.map(samples => {
    let pending = 0;
    const releases = [0], decays = [tau ? 1 : 0];
    const a = tau ? Math.exp(-HOURS / tau) : 0;
    for (const s of samples) {
      const next = tau ? pending * a + s.electrical_kwh / HOURS * tau * -Math.expm1(-HOURS / tau) : 0;
      releases.push(releases.at(-1)! + pending + s.electrical_kwh - next);
      decays.push(decays.at(-1)! * a);
      pending = next;
    }
    const rows: Row[] = [];
    // Quarter changes retain every usable observation. Hour changes make a
    // quantised/filtered thermometer's complete movement visible to the fit.
    for (const width of [1, 4]) for (let i = 0; i + width <= samples.length; i++) {
      rows.push({ x: [releases[i + width] - releases[i], -width * HOURS],
        z: decays[i] - decays[i + width],
        y: samples[i + width - 1].next_water_temperature_c - samples[i].water_temperature_c });
    }
    return { samples, rows, pending, decay: decays.at(-1)!, initial: 0 };
  });
  const coefficients = nonnegativeResponseFit(series);
  if (!coefficients || !(coefficients[0] > 0)) return null;
  series.forEach((s, i) => { s.initial = coefficients[i + 2]; });
  let squared = 0, count = 0;
  for (const s of series) for (const r of s.rows) {
    squared += (r.x[0] * coefficients[0] + r.x[1] * coefficients[1] + r.z * s.initial - r.y) ** 2;
    count++;
  }
  return count ? { tau, gain: coefficients[0], cooling: coefficients[1], mse: squared / count, segments: series } : null;
}

/** Fit one nonlinear time constant, including the direct-response model at 0.
 * Search resolution is relative to the observation cadence and record length;
 * there is no configured heating duration, zero-heat interval or quality gate. */
export function fitPoolDynamics(samples: readonly PoolResponseSample[], capacityKwhPerC: number): PoolDynamicsFit {
  const groups = segments(samples), count = groups.reduce((n, g) => n + g.length, 0);
  const rejected = (): PoolDynamicsFit => ({ rejected: "unidentifiable", sample_count: count });
  if (!count || !Number.isFinite(capacityKwhPerC) || !(capacityKwhPerC > 0)) return rejected();
  const direct = candidate(groups, 0);
  let best = direct;
  const maximum = Math.max(...groups.map(g => g.length * HOURS));
  const minimum = HOURS / 32;
  const steps = Math.max(1, Math.ceil(Math.log2(maximum / minimum) * 4));
  const grid = Array.from({ length: steps + 1 }, (_, i) => minimum * (maximum / minimum) ** (i / steps));
  const consider = (tau: number) => {
    const fit = candidate(groups, tau);
    if (fit && (!best || fit.mse < best.mse - 1e-14)) best = fit;
    return fit?.mse ?? Infinity;
  };
  grid.forEach(consider);
  if (!best) return rejected();
  if (best.tau > 0) {
    const i = grid.reduce((index, v, n) => Math.abs(Math.log(v / best!.tau)) < Math.abs(Math.log(grid[index] / best!.tau)) ? n : index, 0);
    let low = Math.log(grid[Math.max(0, i - 1)]), high = Math.log(grid[Math.min(grid.length - 1, i + 1)]);
    const ratio = (Math.sqrt(5) - 1) / 2;
    let a = high - ratio * (high - low), b = low + ratio * (high - low);
    let fa = consider(Math.exp(a)), fb = consider(Math.exp(b));
    for (let n = 0; n < 30; n++) {
      if (fa < fb) { high = b; b = a; fb = fa; a = high - ratio * (high - low); fa = consider(Math.exp(a)); }
      else { low = a; a = b; fa = fb; b = low + ratio * (high - low); fb = consider(Math.exp(b)); }
    }
  }
  const fit = best as Candidate, last = fit.segments.at(-1)!;
  const all = groups.flat();
  return { fitted: { version: 1, response_time_constant_h: fit.tau, heat_c_per_kwh: fit.gain,
    idle_c_per_h: -fit.cooling, reference_c: all.reduce((sum, s) => sum + s.water_temperature_c, 0) / count,
    sample_count: count, rmse_c: Math.sqrt(fit.mse), instantaneous_rmse_c: direct ? Math.sqrt(direct.mse) : null,
    initial_state: { at: new Date(fit.segments[0].samples[0].start_ms).toISOString(), pending_heat_kwh: fit.segments[0].initial * capacityKwhPerC },
    state: { at: new Date(last.samples.at(-1)!.start_ms + SLOT_MS).toISOString(),
      pending_heat_kwh: capacityKwhPerC * (last.pending * fit.gain + last.initial * last.decay) } } };
}

export interface PoolElectricalInterval { start_ms: number; hours: number; electrical_kwh: number }

/** Current-quarter on/off observations supplement completed energy counters.
 * These are estimated compressor kWh with explicit actuator provenance, not
 * invented readings and not evidence that the complete quarter was metered. */
export function poolPartialElectricity(pool: PoolStateInput, response: HeatPumpResponse, compressorW: number, atMs: number): {
  intervals: PoolElectricalInterval[]; complete: boolean; source: "actuator_history" | "current_run_age" | "unobserved"; ignored: number;
} {
  const boundary = Math.floor(atMs / SLOT_MS) * SLOT_MS;
  const intervals: PoolElectricalInterval[] = [];
  let ignored = 0;
  const add = (start: number, end: number, age: number) => {
    const from = Math.max(boundary, start), to = Math.min(atMs, end);
    if (![start, end, age].every(Number.isFinite) || age < 0 || end < start) { ignored++; return; }
    if (to <= from) return;
    const hours = (to - from) / 3_600_000;
    const projected = projectHeatPumpResponse(response, { compressor_w: compressorW, auxiliary_w: 0 }, [compressorW], [hours], age + (from - start) / 1000);
    intervals.push({ start_ms: from, hours, electrical_kwh: projected.draw_w[0] / 1000 * hours });
  };
  const history = pool.heating_history;
  if (history) {
    if (Array.isArray(history.intervals)) for (const interval of history.intervals) {
      if (!interval || typeof interval !== "object") { ignored++; continue; }
      add(Date.parse(interval.start), Date.parse(interval.end), interval.elapsed_seconds_at_start);
    }
    else ignored++;
    return { intervals, ignored, source: "actuator_history", complete: history.complete === true && ignored === 0
      && Date.parse(history.start) <= boundary && Date.parse(history.end) >= atMs };
  }
  if (pool.heating_running && typeof pool.heating_elapsed_seconds === "number" && pool.heating_elapsed_seconds > 0) {
    const elapsed = pool.heating_elapsed_seconds, start = Math.max(boundary, atMs - elapsed * 1000);
    add(start, atMs, Math.max(0, elapsed - (atMs - start) / 1000));
    return { intervals, ignored, source: "current_run_age", complete: false };
  }
  return { intervals, ignored, source: "unobserved", complete: boundary === atMs };
}

/** State evidence must precede the capture it describes. This selects a
 * checkpoint, rather than rejecting a household because a source is newer. */
export function poolDynamicsAnchor(model: PoolDynamics, atMs: number): PoolDynamics["state"] {
  const valid = (s: PoolDynamics["state"]) => s && Number.isFinite(Date.parse(s.at)) && Number.isFinite(s.pending_heat_kwh) && s.pending_heat_kwh >= 0;
  if (!valid(model.state) || !valid(model.initial_state)) throw new Error("Pool response calibration state is malformed");
  if (Date.parse(model.state.at) <= atMs) return model.state;
  if (Date.parse(model.initial_state.at) <= atMs) return model.initial_state;
  throw new Error("Pool response has no observed starting state for this capture");
}

/** Replay actual compressor energy from the calibration checkpoint. Missing
 * history remains missing evidence; it never invalidates a household schedule.
 * Callers report its coverage alongside the fit diagnostics. */
export function poolPendingHeatAt(model: PoolDynamics, capacityKwhPerC: number,
  history: readonly PoolElectricalInterval[], atMs: number): number {
  const tau = model.response_time_constant_h;
  if (!Number.isFinite(tau) || tau < 0 || !Number.isFinite(capacityKwhPerC) || capacityKwhPerC <= 0
    || !Number.isFinite(model.heat_c_per_kwh) || model.heat_c_per_kwh <= 0 || !Number.isFinite(atMs)) throw new Error("Invalid pool response state inputs");
  const anchor = poolDynamicsAnchor(model, atMs);
  if (tau === 0) return 0;
  let at = Date.parse(anchor.at), pending = anchor.pending_heat_kwh;
  for (const s of history.slice().sort((a, b) => a.start_ms - b.start_ms)) {
    const end = Math.min(atMs, s.start_ms + s.hours * 3_600_000), begin = Math.max(at, s.start_ms);
    if (!(s.hours > 0) || ![s.start_ms, s.hours, s.electrical_kwh].every(Number.isFinite) || s.electrical_kwh < 0 || end <= begin) continue;
    pending *= Math.exp(-Math.max(0, begin - at) / 3_600_000 / tau);
    const hours = (end - begin) / 3_600_000;
    pending = pending * Math.exp(-hours / tau) + s.electrical_kwh / s.hours * model.heat_c_per_kwh * capacityKwhPerC * tau * -Math.expm1(-hours / tau);
    at = end;
  }
  return pending * Math.exp(-Math.max(0, atMs - at) / 3_600_000 / tau);
}
