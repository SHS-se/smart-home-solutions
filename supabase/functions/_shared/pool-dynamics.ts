// Learn the response of the WATER READING to compressor electricity. The
// reservoir is an effective delayed contribution: these observations cannot
// distinguish water mixing, intermediate thermal storage and sensor filtering.
import { solveLinearSystem } from "./planner/thermal-model.ts";
import type { PoolResponseSample } from "./pool-training.ts";
import {
  type HeatPumpResponse,
  projectHeatPumpResponse,
} from "./planner/device-models.ts";
import type { PoolStateInput } from "./planner/planning-contracts.ts";
import {
  type PoolDynamics,
  validatePoolDynamics,
} from "./planner/pool-response.ts";
import { PoolSourceKernel, sourceDecay } from "./planner/device-models.ts";
export type { PoolDynamics } from "./planner/pool-response.ts";

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
      for (let i = 0; i < GLOBALS; i++) {
        target[i] += r.x[i] * r.y;
        for (let j = 0; j < GLOBALS; j++) global[i][j] += r.x[i] * r.x[j];
      }
      for (let i = 0; i < 2; i++) {
        rhs[i] += r.z[i] * r.y;
        for (let j = 0; j < 2; j++) gram[i][j] += r.z[i] * r.z[j];
        for (let j = 0; j < GLOBALS; j++) link[i][j] += r.z[i] * r.x[j];
      }
    }
    return { gram, rhs, link };
  });
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
): Candidate | null {
  const kernel = rate === null ? null : new PoolSourceKernel(1, tau, {
    recovery_rate_per_h: rate,
    heat_loss_per_kwh: 1,
  }, 1);
  const a = tau ? sourceDecay(1 / tau, HOURS) : 0;
  const series: Segment[] = groups.map((samples) => {
    let pending = 0, released = 0;
    let raw = { water_c: 0, pending_heat_kwh: 0, source_depletion_kwh: 0 };
    let initial = { water_c: 0, pending_heat_kwh: 0, source_depletion_kwh: 1 };
    const releases = [[0, 0, 0]], decays = [tau ? 1 : 0];
    for (const sample of samples) {
      const power = sample.electrical_kwh / HOURS;
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
      releases.push([
        released,
        kernel ? released - raw.water_c : 0,
        kernel ? raw.water_c - initial.water_c : 0,
      ]);
      decays.push(decays.at(-1)! * a);
    }
    const rows: Row[] = [];
    for (const width of [1, 4]) {
      for (let i = 0; i + width <= samples.length; i++) {
        const v = releases[i + width].map((x, j) => x - releases[i][j]);
        rows.push({
          x: [v[0], -v[1], -width * HOURS],
          z: [decays[i] - decays[i + width], -v[2]],
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
      decay: decays.at(-1)!,
      initial: 0,
      initialSource: 0,
    };
  });
  const c = nonnegativeResponseFit(series);
  if (!c || !(c[0] > 0)) return null;
  const peak = Math.max(
    ...groups.flatMap((g) => g.map((s) => s.electrical_kwh / HOURS)),
  );
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
): PoolDynamicsFit {
  const groups = segments(samples),
    count = groups.reduce((n, g) => n + g.length, 0);
  const rejected = (): PoolDynamicsFit => ({
    rejected: "unidentifiable",
    sample_count: count,
  });
  if (!count || !Number.isFinite(capacityKwhPerC) || !(capacityKwhPerC > 0)) {
    return rejected();
  }
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
    const fit = responseCandidate(groups, tau, rate);
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
  const fit = best as Candidate, last = fit.segments.at(-1)!;
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
  const profiles = rates.map((rate) => ({
    recovery_rate_per_h: rate,
    rmse_c: Math.sqrt(
      responseCandidate(groups, fit.tau, rate)?.mse ?? Infinity,
    ),
  })).filter((p) => Number.isFinite(p.rmse_c));
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

export interface PoolElectricalInterval {
  start_ms: number;
  hours: number;
  electrical_kwh: number;
}

/** Current-quarter on/off observations supplement completed energy counters.
 * These are estimated compressor kWh with explicit actuator provenance, not
 * invented readings and not evidence that the complete quarter was metered. */
export function poolPartialElectricity(
  pool: PoolStateInput,
  response: HeatPumpResponse,
  compressorW: number,
  atMs: number,
): {
  intervals: PoolElectricalInterval[];
  complete: boolean;
  source: "actuator_history" | "current_run_age" | "unobserved";
  ignored: number;
} {
  const boundary = Math.floor(atMs / SLOT_MS) * SLOT_MS;
  const intervals: PoolElectricalInterval[] = [];
  let ignored = 0;
  const add = (start: number, end: number, age: number) => {
    const from = Math.max(boundary, start), to = Math.min(atMs, end);
    if (![start, end, age].every(Number.isFinite) || age < 0 || end < start) {
      ignored++;
      return;
    }
    if (to <= from) return;
    const hours = (to - from) / 3_600_000;
    const projected = projectHeatPumpResponse(
      response,
      { compressor_w: compressorW, auxiliary_w: 0 },
      [compressorW],
      [hours],
      age + (from - start) / 1000,
    );
    intervals.push({
      start_ms: from,
      hours,
      electrical_kwh: projected.draw_w[0] / 1000 * hours,
    });
  };
  const history = pool.heating_history;
  if (history) {
    if (Array.isArray(history.intervals)) {
      for (const interval of history.intervals) {
        if (!interval || typeof interval !== "object") {
          ignored++;
          continue;
        }
        add(
          Date.parse(interval.start),
          Date.parse(interval.end),
          interval.elapsed_seconds_at_start,
        );
      }
    } else ignored++;
    return {
      intervals,
      ignored,
      source: "actuator_history",
      complete: history.complete === true && ignored === 0 &&
        Date.parse(history.start) <= boundary &&
        Date.parse(history.end) >= atMs,
    };
  }
  if (
    pool.heating_running && typeof pool.heating_elapsed_seconds === "number" &&
    pool.heating_elapsed_seconds > 0
  ) {
    const elapsed = pool.heating_elapsed_seconds,
      start = Math.max(boundary, atMs - elapsed * 1000);
    add(start, atMs, Math.max(0, elapsed - (atMs - start) / 1000));
    return { intervals, ignored, source: "current_run_age", complete: false };
  }
  return {
    intervals,
    ignored,
    source: "unobserved",
    complete: boundary === atMs,
  };
}

/** State evidence must precede the capture it describes. This selects a
 * checkpoint, rather than rejecting a household because a source is newer. */
export function poolDynamicsAnchor(
  model: PoolDynamics,
  atMs: number,
): PoolDynamics["state"] {
  const valid = (s: PoolDynamics["state"]) =>
    s && Number.isFinite(Date.parse(s.at)) &&
    Number.isFinite(s.pending_heat_kwh) && s.pending_heat_kwh >= 0;
  if (!valid(model.state) || !valid(model.initial_state)) {
    throw new Error("Pool response calibration state is malformed");
  }
  if (Date.parse(model.state.at) <= atMs) return model.state;
  if (Date.parse(model.initial_state.at) <= atMs) return model.initial_state;
  throw new Error(
    "Pool response has no observed starting state for this capture",
  );
}

/** Replay actual compressor energy from the calibration checkpoint. Missing
 * history remains missing evidence; it never invalidates a household schedule.
 * Callers report its coverage alongside the fit diagnostics. */
export function poolResponseStateAt(
  model: PoolDynamics,
  capacityKwhPerC: number,
  history: readonly PoolElectricalInterval[],
  atMs: number,
): PoolDynamics["state"] {
  validatePoolDynamics(model);
  if (
    !Number.isFinite(capacityKwhPerC) || capacityKwhPerC <= 0 ||
    !Number.isFinite(atMs)
  ) throw new Error("Invalid pool response state inputs");
  const anchor = poolDynamicsAnchor(model, atMs),
    tau = model.response_time_constant_h;
  let at = Date.parse(anchor.at),
    pending = anchor.pending_heat_kwh,
    depletion = anchor.source_depletion_kwh;
  const source = model.source
    ? {
      recovery_rate_per_h: model.source.recovery_rate_per_h,
      heat_loss_per_kwh: model.source.heat_loss_c_per_kwh_per_kwh /
        model.heat_c_per_kwh,
    }
    : null;
  const kernel = source
    ? new PoolSourceKernel(
      capacityKwhPerC,
      tau,
      source,
      model.heat_c_per_kwh * capacityKwhPerC,
    )
    : null;
  const advance = (power: number, hours: number) => {
    if (kernel) {
      const q = kernel.piece(0, pending, depletion, power, 0, hours, 0);
      pending = q.pending_heat_kwh;
      depletion = q.source_depletion_kwh;
    } else {pending = tau
        ? pending * sourceDecay(1 / tau, hours) +
          power * model.heat_c_per_kwh * capacityKwhPerC * tau *
            (1 - sourceDecay(1 / tau, hours))
        : 0;}
  };
  for (const s of history.slice().sort((a, b) => a.start_ms - b.start_ms)) {
    const end = Math.min(atMs, s.start_ms + s.hours * 3_600_000),
      begin = Math.max(at, s.start_ms);
    if (
      !(s.hours > 0) ||
      ![s.start_ms, s.hours, s.electrical_kwh].every(Number.isFinite) ||
      s.electrical_kwh < 0 || end <= begin
    ) continue;
    if (begin > at) {
      throw new Error("Pool response memory has missing compressor history");
    }
    advance(s.electrical_kwh / s.hours, (end - begin) / 3_600_000);
    at = end;
  }
  if (atMs > at) {
    throw new Error("Pool response memory has missing compressor history");
  }
  return {
    at: new Date(atMs).toISOString(),
    pending_heat_kwh: pending,
    source_depletion_kwh: depletion,
  };
}
