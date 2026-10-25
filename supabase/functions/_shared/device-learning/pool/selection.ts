/** Select source recovery with a prospective comparison, never training error.
 * First two thirds of the observed time span train both candidates; the final
 * third scores disjoint hourly changes with frozen parameters and memory.
 * Paired complete 24-hour blocks preserve residual correlation in the deterministic
 * bootstrap. Positive diagnostic lower bounds for both overall and restart
 * predictions select recovery. This is predictive evidence, not causal proof. Otherwise
 * the explicitly fitted constant family retains its learned water lag.
 * This selects calibration complexity; it never gates household planning.
 */
import { PoolMeanObservation, type PoolObservation } from "./observations.ts";
import { fitPoolDynamics, fitPoolDynamicsPair, type PoolDynamics, type PoolDynamicsFit } from "./response.ts";
import { PoolSourceKernel, type PoolThermalState, stepPoolThermal } from "../../planner/device-models.ts";
import type { PoolResponseSample } from "./thermal.ts";
const SLOT = 900000;
export interface SelectionEvidence {
  selected: "constant_gain" | "recovering_source";
  reason:
    | "supported"
    | "inconclusive"
    | "insufficient_continuity"
    | "unidentifiable";
  training_end: string | null;
  validation_end: string | null;
  hours: number;
  days: number;
  unscored_hours: number;
  restart_hours: number;
  restart_days: number;
  restart_constant_rmse_c: number | null;
  restart_recovery_rmse_c: number | null;
  restart_lower_mse_improvement: number | null;
  constant_rmse_c: number | null;
  recovery_rmse_c: number | null;
  mean_mse_improvement: number | null;
  lower_mse_improvement: number | null;
}
export type SelectionFit = PoolDynamicsFit & { selection: SelectionEvidence };
function projection(
  model: PoolDynamics,
  capacity: number,
  samples: readonly PoolResponseSample[],
  observation: PoolObservation,
) {
  const store = {
    capacity_kwh_per_c: capacity,
    response_time_constant_h: model.response_time_constant_h,
    loss: {
      kind: "measured" as const,
      points: [{ at_c: model.reference_c, c_per_h: model.idle_c_per_h }],
    },
  };
  const kernel = model.source
    ? new PoolSourceKernel(capacity, model.response_time_constant_h, {
      recovery_rate_per_h: model.source.recovery_rate_per_h,
      heat_loss_per_kwh: model.source.heat_loss_c_per_kwh_per_kwh /
        model.heat_c_per_kwh,
    }, model.heat_c_per_kwh * capacity)
    : null;
  const sourceStep = kernel?.preparePiece(.25, 0);
  let state: PoolThermalState = {
    water_c: samples[0].water_temperature_c,
    pending_heat_kwh: model.state.pending_heat_kwh,
    source_depletion_kwh: model.state.source_depletion_kwh,
  };
  const mean = new PoolMeanObservation(.25, capacity, model.response_time_constant_h,
    model.heat_c_per_kwh * capacity, model.idle_c_per_h, kernel?.source ?? null);
  const meanReading = (power: number) => mean.read(state.water_c, state.pending_heat_kwh,
    state.source_depletion_kwh ?? 0, power);
  let start = observation === "quarter_mean" ? meanReading(samples[0].electrical_kwh / .25) : state.water_c;
  let observed = samples[0].water_temperature_c;
  const errors: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i],
      power = s.electrical_kwh / .25,
      heat = power * model.heat_c_per_kwh * capacity * 1000;
    state = sourceStep
      ? sourceStep(
        state.water_c,
        state.pending_heat_kwh,
        state.source_depletion_kwh!,
        power,
        model.idle_c_per_h,
      )
      : stepPoolThermal(store, state, heat, heat, 0, .25);
    if ((i + 1) % 4 === 0 && (observation === "interval_start" || i + 1 < samples.length)) {
      const reading = observation === "quarter_mean" ? meanReading(samples[i + 1].electrical_kwh / .25) : state.water_c;
      errors.push(
        (reading - start) - (s.next_water_temperature_c - observed),
      );
      start = reading;
      observed = s.next_water_temperature_c;
    }
  }
  return {
    errors,
    state: {
      at: new Date(samples.at(-1)!.start_ms + SLOT).toISOString(),
      pending_heat_kwh: state.pending_heat_kwh,
      source_depletion_kwh: model.source ? state.source_depletion_kwh! : 0,
    },
  };
}
export function selectPoolDynamics(
  samples: readonly PoolResponseSample[],
  capacity: number,
  observation: PoolObservation = "interval_start",
): SelectionFit {
  const usable = samples.filter((s) =>
    [
      s.start_ms,
      s.water_temperature_c,
      s.next_water_temperature_c,
      s.electrical_kwh,
    ].every(Number.isFinite) && s.electrical_kwh >= 0
  ).slice().sort((a, b) => a.start_ms - b.start_ms);
  const e: SelectionEvidence = {
    selected: "constant_gain",
    reason: "insufficient_continuity",
    training_end: null,
    validation_end: null,
    hours: 0,
    days: 0,
    unscored_hours: 0,
    restart_hours: 0,
    restart_days: 0,
    restart_constant_rmse_c: null,
    restart_recovery_rmse_c: null,
    restart_lower_mse_improvement: null,
    constant_rmse_c: null,
    recovery_rmse_c: null,
    mean_mse_improvement: null,
    lower_mse_improvement: null,
  };
  const constant = (): SelectionFit => {
    const fit = fitPoolDynamics(usable, capacity, "constant_gain", observation);
    if ("rejected" in fit) e.reason = "unidentifiable";
    return { ...fit, selection: e };
  };
  if (!usable.length) return constant();
  const cut = Math.floor(
    (usable[0].start_ms +
      (usable.at(-1)!.start_ms + SLOT - usable[0].start_ms) * 2 / 3) / SLOT,
  ) * SLOT;
  e.training_end = new Date(cut).toISOString();
  e.validation_end = new Date(usable.at(-1)!.start_ms + SLOT).toISOString();
  const train = usable.filter((s) => s.start_ms < cut),
    validation = usable.filter((s) => s.start_ms >= cut);
  if (
    !train.length || !validation.length ||
    train.at(-1)!.start_ms + SLOT !== cut ||
    validation.some((s, i) => s.start_ms !== cut + i * SLOT)
  ) return constant();
  const { constant: a, recovery: b } = fitPoolDynamicsPair(train, capacity, observation);
  if (!("fitted" in a) || !("fitted" in b)) return constant();
  const pa = projection(a.fitted, capacity, validation, observation),
    pb = projection(b.fitted, capacity, validation, observation);
  // A short trailing day cannot receive the weight of a complete day. It
  // still advances measured state, but is excluded from paired inference.
  const hours = Math.floor(pa.errors.length / 24) * 24;
  pa.errors.length = hours;
  pb.errors.length = hours;
  e.unscored_hours = validation.length / 4 - hours;
  // Restart labels depend on metered electricity alone: an observed zero
  // quarter followed by positive input. Score hours overlapping the following
  // one-hour response window, without fitting another model or starting state.
  const restartHours: boolean[] = [];
  let wasOn = train.at(-1)!.electrical_kwh > 0,
    age = Infinity,
    restartHour = false;
  validation.forEach((sample, i) => {
    const on = sample.electrical_kwh > 0;
    if (on && !wasOn) age = 0;
    wasOn = on;
    restartHour ||= age < 4;
    age++;
    if ((i + 1) % 4 === 0) {
      restartHours.push(restartHour);
      restartHour = false;
    }
  });
  const days = new Map<number, number[]>();
  const restartDays = new Map<number, number[]>();
  pa.errors.forEach((x, i) => {
    const day = Math.floor(i / 24), rows = days.get(day) ?? [];
    rows.push(x * x - pb.errors[i] ** 2);
    days.set(day, rows);
    if (restartHours[i]) {
      const restartRows = restartDays.get(day) ?? [];
      restartRows.push(x * x - pb.errors[i] ** 2);
      restartDays.set(day, restartRows);
    }
  });
  const daily = [...days.values()].map((v) =>
    v.reduce((n, x) => n + x, 0) / v.length
  );
  const restartDaily = [...days.keys()].map((day) => {
    const rows = restartDays.get(day);
    return rows ? rows.reduce((n, x) => n + x, 0) / rows.length : null;
  });
  const restartA = pa.errors.filter((_v, i) => restartHours[i]);
  const restartB = pb.errors.filter((_v, i) => restartHours[i]);
  e.restart_hours = restartA.length;
  e.restart_days = restartDays.size;
  e.hours = pa.errors.length;
  e.days = daily.length;
  const mse = (v: number[]) => v.reduce((n, x) => n + x * x, 0) / v.length;
  e.constant_rmse_c = pa.errors.length ? Math.sqrt(mse(pa.errors)) : null;
  e.recovery_rmse_c = pb.errors.length ? Math.sqrt(mse(pb.errors)) : null;
  e.restart_constant_rmse_c = restartA.length ? Math.sqrt(mse(restartA)) : null;
  e.restart_recovery_rmse_c = restartB.length ? Math.sqrt(mse(restartB)) : null;
  if (daily.length >= 2) {
    e.mean_mse_improvement = daily.reduce((n, x) => n + x, 0) / daily.length;
    let seed = 1;
    const means: number[] = [], restartMeans: number[] = [];
    for (let n = 0; n < 4096; n++) {
      let sum = 0, restartSum = 0, restartCount = 0;
      for (let i = 0; i < daily.length; i++) {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        const index = Math.floor(seed / 4294967296 * daily.length);
        sum += daily[index];
        if (restartDaily[index] !== null) {
          restartSum += restartDaily[index]!;
          restartCount++;
        }
      }
      means.push(sum / daily.length);
      restartMeans.push(restartCount ? restartSum / restartCount : 0);
    }
    means.sort((a, b) => a - b);
    restartMeans.sort((a, b) => a - b);
    e.lower_mse_improvement = means[Math.floor(means.length * .05)];
    e.restart_lower_mse_improvement =
      restartMeans[Math.floor(restartMeans.length * .05)];
    e.reason = "inconclusive";
    if (
      b.fitted.source && e.lower_mse_improvement > 0 && e.restart_days >= 3 &&
      e.restart_lower_mse_improvement > 0
    ) {
      e.selected = "recovering_source";
      e.reason = "supported";
    }
  }
  const chosen = e.selected === "recovering_source" ? b.fitted : a.fitted,
    state = e.selected === "recovering_source" ? pb.state : pa.state;
  return { fitted: { ...chosen, state }, selection: e };
}
