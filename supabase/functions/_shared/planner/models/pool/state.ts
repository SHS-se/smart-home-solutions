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
