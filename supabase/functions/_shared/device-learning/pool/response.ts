// Learn the response of the WATER READING to compressor electricity. The
// reservoir is an effective delayed contribution: these observations cannot
// distinguish water mixing, intermediate thermal storage and sensor filtering.
import { PoolMeanObservation, type PoolObservation } from "./observations.ts";
import { solveLinearSystem } from "../linear-algebra.ts";
import type { PoolResponseSample } from "./thermal.ts";
import { type PoolDynamics } from "../../planner/pool-response.ts";
import { PoolSourceKernel, sourceDecay } from "../../planner/device-models.ts";
export type { PoolDynamics } from "../../planner/pool-response.ts";

const HOURS = 0.25, SLOT_MS = HOURS * 3_600_000;
export type PoolDynamicsFit = { fitted: PoolDynamics } | {
  rejected: "unidentifiable";
  sample_count: number;
};
/** Shared coefficients: heat gain, standing cooling, and gain lost per hour of running. */
const GLOBALS = 3;
interface Row {
  x: number[];
  z: number[];
  y: number;
}
interface Segment {
  samples: PoolResponseSample[];
  rows: Row[];
  pending: number;
  sourcePending: number;
  initialSourcePending: number;
  depletion: number;
  sourceDecay: number;
  decay: number;
  initial: number;
  initialSource: number;
}
interface Candidate {
  tau: number;
  rate: number | null;
  gain: number;
  cooling: number;
  sensitivity: number;
  mse: number;
  segments: Segment[];
}

/** Each contiguous observation sequence has its own unknown starting memory. */
function segments(
  samples: readonly PoolResponseSample[],
): PoolResponseSample[][] {
  const usable = samples.filter((s) =>
    [
      s.start_ms,
      s.water_temperature_c,
      s.next_water_temperature_c,
      s.electrical_kwh,
    ].every(Number.isFinite) && s.electrical_kwh >= 0
  )
    .slice().sort((a, b) => a.start_ms - b.start_ms);
  const result: PoolResponseSample[][] = [];
  for (const sample of usable) {
    const previous = result.at(-1)?.at(-1);
    if (!previous || sample.start_ms - previous.start_ms !== SLOT_MS) {
      result.push([]);
    }
    result.at(-1)!.push(sample);
  }
  return result;
}

/** NNLS with three shared coefficients and two local memories per chronology
 * segment. Active solves eliminate independent local 2x2 blocks, leaving at
 * most a 3x3 Schur complement even when history is fragmented. */
function nonnegativeResponseFit(series: Segment[]): number[] | null {
  const global = Array.from({ length: GLOBALS }, () => Array(GLOBALS).fill(0));
  const target = Array(GLOBALS).fill(0);
  let rows = 0;
  const blocks = series.map((s) => {
    const gram = [[0, 0], [0, 0]], rhs = [0, 0], link = [[0, 0, 0], [0, 0, 0]];
    for (const r of s.rows) {
      rows++;
      // Fixed three global coefficients and two local memories. Preserve each
      // accumulator's sample order; symmetric raw products are identical.
      const [a, b, c] = r.x, [u, v] = r.z;
      target[0] += a * r.y;
      target[1] += b * r.y;
      target[2] += c * r.y;
      global[0][0] += a * a;
      global[0][1] += a * b;
      global[0][2] += a * c;
      global[1][1] += b * b;
      global[1][2] += b * c;
      global[2][2] += c * c;
      rhs[0] += u * r.y;
      rhs[1] += v * r.y;
      gram[0][0] += u * u;
      gram[0][1] += u * v;
      gram[1][1] += v * v;
      link[0][0] += u * a;
      link[0][1] += u * b;
      link[0][2] += u * c;
      link[1][0] += v * a;
      link[1][1] += v * b;
      link[1][2] += v * c;
    }
    gram[1][0] = gram[0][1];
    return { gram, rhs, link };
  });
  global[1][0] = global[0][1];
  global[2][0] = global[0][2];
  global[2][1] = global[1][2];
  const norms = [
    ...target.map((_, i) => Math.sqrt(global[i][i])),
    ...blocks.flatMap((b) => b.rhs.map((_, i) => Math.sqrt(b.gram[i][i]))),
  ];
  if (!(norms[0] > 0) || !(norms[2] > 0)) return null;
  for (let i = 0; i < GLOBALS; i++) {
    for (let j = 0; j < GLOBALS; j++) {
      global[i][j] = norms[i] && norms[j]
        ? global[i][j] / norms[i] / norms[j]
        : 0;
    }
  }
  if (!solveLinearSystem([[1, global[0][2]], [global[2][0], 1]], [0, 0])) {
    return null;
  }
  const rhs = target.map((v, i) => norms[i] ? v / norms[i] : 0);
  blocks.forEach((b, k) => {
    const offset = GLOBALS + 2 * k;
    for (let i = 0; i < 2; i++) {
      rhs.push(norms[offset + i] ? b.rhs[i] / norms[offset + i] : 0);
      for (let j = 0; j < 2; j++) {
        b.gram[i][j] = norms[offset + i] && norms[offset + j]
          ? b.gram[i][j] / norms[offset + i] / norms[offset + j]
          : 0;
      }
      for (let j = 0; j < GLOBALS; j++) {
        b.link[i][j] = norms[offset + i] && norms[j]
          ? b.link[i][j] / norms[offset + i] / norms[j]
          : 0;
      }
    }
  });
  const size = rhs.length, passive = rhs.map(() => false);
  let x = rhs.map(() => 0), iterations = 0;
  const tolerance = Number.EPSILON * Math.max(1, ...rhs.map(Math.abs)) *
    Math.max(rows, size) * 8;
  const gradient = () => {
    const w = rhs.slice();
    for (let i = 0; i < GLOBALS; i++) {
      for (let j = 0; j < GLOBALS; j++) w[i] -= global[i][j] * x[j];
    }
    blocks.forEach((b, k) => {
      const offset = GLOBALS + 2 * k;
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < GLOBALS; j++) {
          w[offset + i] -= b.link[i][j] * x[j];
          w[j] -= b.link[i][j] * x[offset + i];
        }
        for (let j = 0; j < 2; j++) {
          w[offset + i] -= b.gram[i][j] * x[offset + j];
        }
      }
    });
    return w;
  };
  const solvePassive = (): number[] | null => {
    const shared = [0, 1, 2].filter((i) => passive[i]);
    const matrix = shared.map((i) => shared.map((j) => global[i][j])),
      vector = shared.map((i) => rhs[i]);
    const locals = blocks.map((b, k) => {
      const offset = GLOBALS + 2 * k,
        active = [0, 1].filter((i) => passive[offset + i]);
      const local = active.map((i) => active.map((j) => b.gram[i][j]));
      const solve = (v: number[]) =>
        active.length
          ? solveLinearSystem(local.map((row) => row.slice()), v)
          : [];
      const y = solve(active.map((i) => rhs[offset + i]));
      const links = shared.map((j) => solve(active.map((i) => b.link[i][j])));
      if (!y || links.some((v) => !v)) return null;
      shared.forEach((i, row) => {
        for (let a = 0; a < active.length; a++) {
          vector[row] -= b.link[active[a]][i] * y[a];
        }
        shared.forEach((_j, col) => {
          for (let a = 0; a < active.length; a++) {
            matrix[row][col] -= b.link[active[a]][i] * links[col]![a];
          }
        });
      });
      return { b, offset, active, solve };
    });
    if (locals.some((v) => !v)) return null;
    const solution = shared.length ? solveLinearSystem(matrix, vector) : [];
    if (!solution || !solution.every(Number.isFinite)) return null;
    const out = rhs.map(() => 0);
    shared.forEach((i, j) => {
      out[i] = solution[j];
    });
    for (const item of locals) {
      const { b, offset, active, solve } = item!;
      const v = solve(
        active.map((i) =>
          rhs[offset + i] - b.link[i].reduce((n, c, j) => n + c * out[j], 0)
        ),
      );
      if (!v) return null;
      active.forEach((i, j) => {
        out[offset + i] = v[j];
      });
    }
    return out;
  };
  while (iterations++ < 30 * size) {
    const w = gradient();
    let entering = -1;
    for (let i = 0; i < size; i++) {
      if (
        !passive[i] && norms[i] > 0 && w[i] > tolerance &&
        (entering < 0 || w[i] > w[entering])
      ) entering = i;
    }
    if (entering < 0) return x.map((v, i) => norms[i] ? v / norms[i] : 0);
    passive[entering] = true;
    while (iterations++ < 30 * size) {
      const next = solvePassive();
      if (!next) return null;
      if (next.every((v, i) => !passive[i] || v > 0)) {
        x = next;
        break;
      }
      let fraction = 1, boundary = -1;
      next.forEach((v, i) => {
        if (!passive[i] || v > 0) return;
        const share = x[i] === v ? 0 : x[i] / (x[i] - v);
        if (share <= fraction) {
          fraction = share;
          boundary = i;
        }
      });
      x = x.map((v, i) => v + fraction * (next[i] - v));
      for (let i = 0; i < size; i++) {
        if (passive[i] && (i === boundary || x[i] <= 0)) {
          passive[i] = false;
          x[i] = 0;
        }
      }
    }
  }
  return null;
}

function responseCandidate(
  groups: PoolResponseSample[][],
  tau: number,
  rate: number | null,
  observation: PoolObservation,
  peak: number,
): Candidate | null {
  const kernel = rate === null ? null : new PoolSourceKernel(1, tau, {
    recovery_rate_per_h: rate,
    heat_loss_per_kwh: 1,
  }, 1);
  const a = tau ? sourceDecay(1 / tau, HOURS) : 0;
  const constantMean = observation === "quarter_mean"
    ? new PoolMeanObservation(HOURS, 1, tau, 1, 0, null) : null;
  const sourceMean = observation === "quarter_mean" && kernel
    ? new PoolMeanObservation(HOURS, 1, tau, 1, 0, kernel.source) : null;
  const series: Segment[] = groups.map((samples) => {
    let pending = 0, released = 0;
    let raw = { water_c: 0, pending_heat_kwh: 0, source_depletion_kwh: 0 };
    let initial = { water_c: 0, pending_heat_kwh: 0, source_depletion_kwh: 1 };
    const releases = observation === "quarter_mean" ? [] : [[0, 0, 0]], decays: number[] = observation === "quarter_mean" ? [] : [tau ? 1 : 0];
    let initialDecay = tau ? 1 : 0;
    for (const sample of samples) {
      const power = sample.electrical_kwh / HOURS;
      if (observation === "quarter_mean") {
        const mean = constantMean!.read(released, pending, 0, power);
        const rawMean = sourceMean?.read(raw.water_c, raw.pending_heat_kwh, raw.source_depletion_kwh, power) ?? 0;
        const initialMean = sourceMean?.read(initial.water_c, initial.pending_heat_kwh, initial.source_depletion_kwh, power) ?? 0;
        releases.push([mean, kernel ? mean - rawMean : 0, kernel ? rawMean - initialMean : 0]);
        decays.push(tau ? initialDecay * tau / HOURS * (1 - a) : 0);
      }
      const next = tau ? pending * a + power * tau * (1 - a) : 0;
      released += pending + sample.electrical_kwh - next;
      pending = next;
      if (kernel) {
        raw = kernel.piece(
          raw.water_c,
          raw.pending_heat_kwh,
          raw.source_depletion_kwh,
          power,
          0,
          HOURS,
          0,
        );
        initial = kernel.piece(
          initial.water_c,
          initial.pending_heat_kwh,
          initial.source_depletion_kwh,
          power,
          0,
          HOURS,
          0,
        );
      }
      if (observation === "interval_start") releases.push([
        released,
        kernel ? released - raw.water_c : 0,
        kernel ? raw.water_c - initial.water_c : 0,
      ]);
      initialDecay *= a;
      if (observation === "interval_start") decays.push(initialDecay);
    }
    const rows: Row[] = [];
    for (const width of [1, 4]) {
      for (let i = 0; i + width < releases.length; i++) {
        const from = releases[i], to = releases[i + width];
        rows.push({
          x: [to[0] - from[0], -(to[1] - from[1]), -width * HOURS],
          z: [decays[i] - decays[i + width], -(to[2] - from[2])],
          y: samples[i + width - 1].next_water_temperature_c -
            samples[i].water_temperature_c,
        });
      }
    }
    return {
      samples,
      rows,
      pending,
      sourcePending: kernel ? pending - raw.pending_heat_kwh : 0,
      initialSourcePending: kernel
        ? raw.pending_heat_kwh - initial.pending_heat_kwh
        : 0,
      depletion: raw.source_depletion_kwh,
      sourceDecay: rate === null
        ? 0
        : sourceDecay(rate, samples.length * HOURS),
      decay: initialDecay,
      initial: 0,
      initialSource: 0,
    };
  });
  const c = nonnegativeResponseFit(series);
  if (!c || !(c[0] > 0)) return null;
  if (rate !== null && c[1] > 0 && !(c[0] > c[1] * peak / rate)) return null;
  if (c[1] === 0 && series.some((_s, i) => c[GLOBALS + 2 * i + 1] > 0)) {
    return null;
  }
  series.forEach((s, i) => {
    s.initial = c[GLOBALS + 2 * i];
    s.initialSource = c[GLOBALS + 2 * i + 1];
  });
  if (series.some((s) => s.initialSource >= c[0])) return null;
  let squared = 0, count = 0;
  for (const seg of series) {
    for (const row of seg.rows) {
      const predicted = row.x[0] * c[0] + row.x[1] * c[1] + row.x[2] * c[2] +
        row.z[0] * seg.initial + row.z[1] * seg.initialSource;
      squared += (predicted - row.y) ** 2;
      count++;
    }
  }
  return count
    ? {
      tau,
      rate,
      gain: c[0],
      sensitivity: c[1],
      cooling: c[2],
      mse: squared / count,
      segments: series,
    }
    : null;
}

/** Variable projection learns water lag and source recovery from the same
 * metered chronology. Initial water response and source state are unknown
 * per segment. Constant gain is a nested fitted hypothesis, not a default. */
export function fitPoolDynamics(
  samples: readonly PoolResponseSample[],
  capacityKwhPerC: number,
  hypothesis: "recovering_source" | "constant_gain" = "recovering_source",
  observation: PoolObservation = "interval_start",
): PoolDynamicsFit {
  return fitDynamics(samples, capacityKwhPerC, hypothesis, observation);
}

/** Both families share the identical constant candidate search prefix. The
 * comparison owns this one invocation; no samples or fits escape into a cache. */
export function fitPoolDynamicsPair(
  samples: readonly PoolResponseSample[],
  capacityKwhPerC: number,
  observation: PoolObservation = "interval_start",
): { constant: PoolDynamicsFit; recovery: PoolDynamicsFit } {
  let constant: PoolDynamicsFit | undefined;
  const recovery = fitDynamics(samples, capacityKwhPerC, "recovering_source", observation,
    fit => { constant = fit; });
  if (!constant) throw new Error("Pool comparison did not produce its constant candidate");
  return { constant, recovery };
}

function fitDynamics(
  samples: readonly PoolResponseSample[],
  capacityKwhPerC: number,
  hypothesis: "recovering_source" | "constant_gain" = "recovering_source",
  observation: PoolObservation = "interval_start",
  captureConstant?: (fit: PoolDynamicsFit) => void,
): PoolDynamicsFit {
  const groups = segments(samples),
    count = groups.reduce((n, g) => n + g.length, 0);
  const rejected = (): PoolDynamicsFit => {
    const failure = { rejected: "unidentifiable" as const, sample_count: count };
    captureConstant?.(failure);
    return failure;
  };
  if (!count || !Number.isFinite(capacityKwhPerC) || !(capacityKwhPerC > 0)) {
    return rejected();
  }
  const peak = Math.max(...groups.flatMap(g => g.map(s => s.electrical_kwh / HOURS)));
  const maximum = Math.max(...groups.map((g) => g.length * HOURS)),
    minimum = HOURS / 32;
  const steps = Math.max(1, Math.ceil(Math.log2(maximum / minimum) * 4));
  const grid = Array.from(
    { length: steps + 1 },
    (_, i) => minimum * (maximum / minimum) ** (i / steps),
  );
  const cache = new Map<string, number>();
  let best: Candidate | null = null;
  const consider = (tau: number, rate: number | null) => {
    const key = `${tau}:${rate}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const fit = responseCandidate(groups, tau, rate, observation, peak);
    cache.set(key, fit?.mse ?? Infinity);
    if (fit && (!best || fit.mse < best.mse - 1e-18)) best = fit;
    return fit?.mse ?? Infinity;
  };
  const refine = (
    value: number,
    values: number[],
    fn: (v: number) => number,
  ) => {
    const nearest = values.reduce(
      (a, v, i) =>
        Math.abs(Math.log(v / value)) < Math.abs(Math.log(values[a] / value))
          ? i
          : a,
      0,
    );
    let low = Math.log(values[Math.max(0, nearest - 1)]),
      high = Math.log(values[Math.min(values.length - 1, nearest + 1)]);
    const ratio = (Math.sqrt(5) - 1) / 2;
    let a = high - ratio * (high - low),
      b = low + ratio * (high - low),
      fa = fn(Math.exp(a)),
      fb = fn(Math.exp(b));
    for (let n = 0; n < 24; n++) {
      if (fa < fb) {
        high = b;
        b = a;
        fb = fa;
        a = high - ratio * (high - low);
        fa = fn(Math.exp(a));
      } else {
        low = a;
        a = b;
        fa = fb;
        b = low + ratio * (high - low);
        fb = fn(Math.exp(b));
      }
    }
  };
  const direct = consider(0, null);
  grid.forEach((tau) => consider(tau, null));
  if (!best) return rejected();
  let constant = best as Candidate;
  if (constant.tau > 0) {
    refine(constant.tau, grid, (tau) => consider(tau, null));
    constant = best as Candidate;
  }
  const rates = grid.slice().reverse().map((t) => 1 / t); // Slow recovery wins numerical ties.
  captureConstant?.(finish(constant, []));
  for (const rate of hypothesis === "constant_gain" ? [] : rates) {
    for (const tau of new Set([0, constant.tau, HOURS])) {
      consider(tau, rate);
    }
  }
  for (let round = 0; hypothesis !== "constant_gain" && round < 12; round++) {
    const chosen = best as Candidate;
    if (chosen.rate === null) break;
    if (chosen.tau > 0) {
      refine(chosen.tau, grid, (tau) => consider(tau, chosen.rate));
    }
    const current = best as Candidate;
    refine(current.rate!, rates, (rate) => consider(current.tau, rate));
  }
  const fit = best as Candidate;
  const profiles = (hypothesis === "constant_gain" ? [] : rates).map((rate) => ({
    recovery_rate_per_h: rate,
    rmse_c: Math.sqrt(
      responseCandidate(groups, fit.tau, rate, observation, peak)?.mse ?? Infinity,
    ),
  })).filter((p) => Number.isFinite(p.rmse_c));
  return finish(fit, profiles);

  function finish(fit: Candidate, profiles: { recovery_rate_per_h: number; rmse_c: number }[]): PoolDynamicsFit {
    const last = fit.segments.at(-1)!;
    const source = fit.sensitivity > 0 && fit.rate !== null
      ? {
        recovery_rate_per_h: fit.rate,
        heat_loss_c_per_kwh_per_kwh: fit.sensitivity,
      }
      : null;
    const state = (s: Segment, initial: boolean) => ({
      at: new Date(
        initial ? s.samples[0].start_ms : s.samples.at(-1)!.start_ms + SLOT_MS,
      ).toISOString(),
      pending_heat_kwh: capacityKwhPerC *
        (initial
          ? s.initial
          : s.pending * fit.gain - s.sourcePending * fit.sensitivity -
            s.initialSourcePending * s.initialSource + s.initial * s.decay),
      source_depletion_kwh: source
        ? (initial
          ? s.initialSource / fit.sensitivity
          : s.depletion + s.sourceDecay * s.initialSource / fit.sensitivity)
        : 0,
    });
    const rests: number[] = [];
    for (const group of groups) {
      let idle = 0, seen = false;
      for (const s of group) {
        if (s.electrical_kwh > 0) {
          if (seen && idle) rests.push(idle);
          seen = true;
          idle = 0;
        } else if (seen) idle += HOURS;
      }
    }
    return {
      fitted: {
        version: 2,
        response_time_constant_h: fit.tau,
        heat_c_per_kwh: fit.gain,
        source,
        idle_c_per_h: -fit.cooling,
        reference_c:
          groups.flat().reduce((n, s) => n + s.water_temperature_c, 0) / count,
        sample_count: count,
        rmse_c: Math.sqrt(fit.mse),
        instantaneous_rmse_c: Number.isFinite(direct) ? Math.sqrt(direct) : null,
        constant_gain_rmse_c: Math.sqrt(constant.mse),
        recovery_evidence: {
          restarts: rests.length,
          shortest_off_h: rests.length ? Math.min(...rests) : null,
          longest_off_h: rests.length ? Math.max(...rests) : null,
          steady_heat_fraction_at_observed_peak: source
            ? 1 - fit.sensitivity * Math.max(
                  ...groups.flat().map((s) => s.electrical_kwh / HOURS),
                ) /
                (fit.gain * source.recovery_rate_per_h)
            : null,
          profile: profiles,
          minimum_at_search_boundary: source !== null &&
            (fit.rate === rates[0] || fit.rate === rates.at(-1)),
        },
        initial_state: state(fit.segments[0], true),
        state: state(last, false),
      },
    };
  }
}
