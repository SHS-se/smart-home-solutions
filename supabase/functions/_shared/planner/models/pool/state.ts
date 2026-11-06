/** Reconstruct captured thermal memory from actual electricity; never refit parameters. */
import type { PoolStateInput } from "../../planning-contracts.ts";
import { type PoolDynamics, validatePoolDynamics } from "../../pool-response.ts";
import { PoolSourceKernel, sourceDecay } from "../../device-models.ts";
const SLOT_MS = 900_000;

export interface PoolElectricalInterval {
  start_ms: number;
  hours: number;
  electrical_kwh: number;
}

/** Metered partial-quarter input uses the same interval-average convention as
 * completed energy quarters. A measured zero proves zero electricity despite
 * missing switch observations; it does not invent an OFF transition. */
export function poolPartialElectricity(
  pool: PoolStateInput,
  heaterKeys: readonly string[],
  atMs: number,
): {
  intervals: PoolElectricalInterval[];
  complete: boolean;
  source: "metered_counter" | "unobserved";
  ignored: number;
} {
  const boundary = Math.floor(atMs / SLOT_MS) * SLOT_MS;
  if (boundary === atMs) return { intervals: [], complete: true, source: "metered_counter", ignored: 0 };
  const history = pool.electrical_history;
  const empty = { intervals: [], complete: false, source: "unobserved" as const, ignored: 0 };
  if (!history || Date.parse(history.start) !== boundary || Date.parse(history.end) !== atMs ||
      !Array.isArray(history.counters) || !heaterKeys.length) return empty;
  const required = new Set(heaterKeys), energy = new Map<string, number>();
  let ignored = 0;
  const duplicates = new Set<string>();
  for (const counter of history.counters) {
    if (!counter || !required.has(counter.device_key)) continue;
    const { device_key: key, start_kwh: start, end_kwh: end } = counter;
    if (energy.has(key)) duplicates.add(key);
    if (typeof start !== "number" || typeof end !== "number" ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      ignored++;
      continue;
    }
    energy.set(key, end - start);
  }
  if (energy.size !== required.size || duplicates.size) return { ...empty, ignored: ignored + duplicates.size };
  return { intervals: [{ start_ms: boundary, hours: (atMs - boundary) / 3_600_000,
    electrical_kwh: [...energy.values()].reduce((sum, kwh) => sum + kwh, 0) }],
    complete: true, source: "metered_counter", ignored };
}

/** State evidence must precede the capture it describes. This selects a
 * checkpoint, rather than rejecting a household because a source is newer.
 * Null when both fitted checkpoints are newer than the capture (a re-sent or
 * recaptured snapshot); the reconstruction then starts from a bounded state. */
export function poolDynamicsAnchor(
  model: PoolDynamics,
  atMs: number,
): PoolDynamics["state"] | null {
  const valid = (s: PoolDynamics["state"]) =>
    s && Number.isFinite(Date.parse(s.at)) &&
    Number.isFinite(s.pending_heat_kwh) && s.pending_heat_kwh >= 0;
  if (!valid(model.state) || !valid(model.initial_state)) {
    throw new Error("Pool response calibration state is malformed");
  }
  if (Date.parse(model.state.at) <= atMs) return model.state;
  if (Date.parse(model.initial_state.at) <= atMs) return model.initial_state;
  return null;
}

/** Without a checkpoint, the replay starts this long before the capture from
 * the bounded state (no in-flight heat, the most depletion any supported draw
 * can sustain). Observed energy since then tightens both bounds. */
export const UNANCHORED_REPLAY_HOURS = 24;

/** Where the replay for a capture starts: its checkpoint, or a quarter-aligned
 * bounded start when no checkpoint precedes the capture. */
export function poolReplayStart(model: PoolDynamics, atMs: number): number {
  const anchor = poolDynamicsAnchor(model, atMs);
  return anchor ? Date.parse(anchor.at)
    : Math.floor(atMs / SLOT_MS) * SLOT_MS - UNANCHORED_REPLAY_HOURS * 3_600_000;
}

/** Time the replay could not see electricity for. */
export interface PoolUnmeteredSpan {
  start_ms: number;
  end_ms: number;
}

export interface PoolResponseReconstruction {
  state: PoolDynamics["state"];
  unmetered: PoolUnmeteredSpan[];
  /** True when no fitted checkpoint preceded the capture. */
  estimated_start: boolean;
}

/** Replay actual compressor energy from the calibration checkpoint.
 *
 * Time with no electricity evidence is bounded, never assumed idle and never a
 * reason to stop: pending heat advances as if no heat arrived (a lower bound,
 * because heat is never negative) and source depletion advances as if the
 * compressor drew `ceilingKw` (an upper bound, because depletion grows with
 * power). Both bounds hold through every observed interval that follows, so the
 * result can only under-state in-flight heat and over-state depletion. A later
 * capture that finds the missing rows replays exactly, with no relearning.
 * Fully observed history takes the same kernel calls as before.
 * Throws only when no bounded state exists. */
export function reconstructPoolResponse(
  model: PoolDynamics,
  capacityKwhPerC: number,
  history: readonly PoolElectricalInterval[],
  atMs: number,
  ceilingKw: number,
): PoolResponseReconstruction {
  validatePoolDynamics(model);
  if (
    !Number.isFinite(capacityKwhPerC) || capacityKwhPerC <= 0 ||
    !Number.isFinite(atMs) || !Number.isFinite(ceilingKw)
  ) throw new Error("Invalid pool response state inputs");
  const anchor = poolDynamicsAnchor(model, atMs),
    tau = model.response_time_constant_h;
  let at = poolReplayStart(model, atMs),
    pending = anchor?.pending_heat_kwh ?? 0,
    depletion = anchor?.source_depletion_kwh ?? 0;
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
  const decay = (hours: number) => tau ? pending * sourceDecay(1 / tau, hours) : 0;
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
  const intervals = history.filter((s) =>
    s.hours > 0 && [s.start_ms, s.hours, s.electrical_kwh].every(Number.isFinite) &&
    s.electrical_kwh >= 0
  ).sort((a, b) => a.start_ms - b.start_ms);
  // A metered average above the declared ON draw is still evidence of what the
  // heater can draw, so the bound never sits below what was measured.
  const ceiling = Math.max(
    ceilingKw,
    ...intervals.map((s) => s.electrical_kwh / s.hours),
  );
  if (!anchor && source) {
    if (!(ceiling > 0)) throw new Error("Pool heater ON draw is unknown");
    depletion = ceiling / source.recovery_rate_per_h;
  }
  const unmetered: PoolUnmeteredSpan[] = [];
  const unobserved = (from: number, to: number) => {
    const hours = (to - from) / 3_600_000;
    if (kernel) {
      if (!(ceiling > 0)) throw new Error("Pool heater ON draw is unknown");
      const idle = kernel.piece(0, pending, depletion, 0, 0, hours, 0);
      const full = kernel.piece(0, pending, depletion, ceiling, 0, hours, 0);
      pending = idle.pending_heat_kwh;
      depletion = full.source_depletion_kwh;
    } else pending = decay(hours);
    unmetered.push({ start_ms: from, end_ms: to });
  };
  for (const s of intervals) {
    const end = Math.min(atMs, s.start_ms + s.hours * 3_600_000),
      begin = Math.max(at, s.start_ms);
    if (end <= begin) continue;
    if (begin > at) unobserved(at, begin);
    advance(s.electrical_kwh / s.hours, (end - begin) / 3_600_000);
    at = end;
  }
  if (atMs > at) {
    unobserved(at, atMs);
  }
  if (source && source.heat_loss_per_kwh * depletion >= 1) {
    throw new Error("Pool source memory bound exceeds the model's range");
  }
  return {
    state: {
      at: new Date(atMs).toISOString(),
      pending_heat_kwh: pending,
      source_depletion_kwh: depletion,
    },
    unmetered,
    estimated_start: !anchor,
  };
}
