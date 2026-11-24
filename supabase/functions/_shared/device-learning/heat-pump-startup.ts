/**
 * A heat pump's start-up and running draw, learned from its own meter.
 *
 * User requirement, 24 November 2026: a modulating heat pump (a room heater
 * with the inverter load type) can draw several times its running power while
 * it recovers from standing idle on a cold day. Its model
 * states, per 5 °C outdoor band, the peak power of a start, the draw of the
 * hours that follow it, and the draw and peak of steady running (defrost
 * restarts included), so planning can keep starts within the house limit.
 *
 * Evidence is hourly. An hour is assembled from four complete quarters or one
 * native hour; a missing hour is unknown, never idle, and ends any start or
 * recovery it would have continued. An hour that cooled is not heating
 * evidence and is treated the same way. The model check fits the same method on
 * everything before the last 14 days and predicts those days from the hours
 * the unit actually ran and the outdoor temperature they had.
 */
import { heatingBand } from "../planner/heating-bands.ts";

export const HEAT_PUMP_STARTUP_METHOD = "heat_pump_startup_v1";
/** Below this hourly mean the compressor did not run (fan and electronics only). */
export const STANDBY_W = 100;
/** Hours after the start hour that belong to its recovery. */
export const RECOVERY_HOURS = 2;
export const CHECK_DAYS = 14;
const HOUR_MS = 3_600_000;
const MAX_LISTED_STARTS = 200;

export interface HeatPumpInterval {
  start_ms: number;
  duration_s: 900 | 3600;
  energy_kwh: number;
  /** Highest power reading in the interval; null when not observed. */
  peak_w: number | null;
  outdoor_c: number | null;
  /** True when the unit was cooling; such an interval says nothing about heating. */
  cooling?: boolean | null;
}

interface Hour { start_ms: number; mean_w: number; peak_w: number | null; outdoor_c: number | null }
type Role = { kind: "standby" } | { kind: "start" } | { kind: "recovery"; hour: number } | { kind: "running" }
  /** Running after a gap, within the hours a start in the gap could still be recovering. */
  | { kind: "unknown"; hour: number };

export interface HeatPumpStart {
  at: string;
  outdoor_c: number;
  peak_w: number | null;
  /** Mean of the start hour, which usually begins part-way through it. */
  first_hour_w: number;
}

export interface HeatPumpBand {
  band_c: number;
  outdoor_c: number;
  starts: number;
  /** Median and highest start peak in the band. */
  start_peak_w: number | null;
  start_peak_max_w: number | null;
  first_hour_w: number | null;
  /** Median draw, and highest peak, in each recovery hour after the start hour. */
  recovery_w: (number | null)[];
  recovery_peak_w: (number | null)[];
  running_hours: number;
  running_w: number | null;
  /** Highest peak in a steady running hour, defrost restarts included. */
  running_peak_w: number | null;
}

export interface HeatPumpCheckHour {
  at: string;
  outdoor_c: number;
  measured_w: number;
  predicted_w: number | null;
  measured_peak_w: number | null;
  predicted_peak_w: number | null;
  start: boolean;
}

export type HeatPumpCheck =
  | { available: false; reason: "no_training_starts" | "no_check_hours"; from: string; to: string }
  | { available: true; from: string; to: string; hours: HeatPumpCheckHour[];
    /** Mean absolute and mean signed (predicted − measured) hourly error over running hours. */
    draw_error_w: number | null; draw_bias_w: number | null; running_hours: number;
    starts: number; starts_within_peak: number; running_peak_hours: number; running_peaks_within: number };

export interface HeatPumpStartupModel {
  method: typeof HEAT_PUMP_STARTUP_METHOD;
  standby_w: number;
  recovery_hours: number;
  observed_from: string | null;
  observed_to: string | null;
  bands: HeatPumpBand[];
  /** The most recent starts, newest last. */
  starts: HeatPumpStart[];
  check: HeatPumpCheck;
}

const round = (value: number) => Math.round(value);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const maximum = (values: number[]) => values.length ? Math.max(...values) : null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const iso = (ms: number) => new Date(ms).toISOString();

/** Four complete quarters, else the native hour, else nothing. */
export function heatPumpHours(intervals: readonly HeatPumpInterval[]): Hour[] {
  type Slot = { quarters: Map<number, HeatPumpInterval>; hour?: HeatPumpInterval };
  const byHour = new Map<number, Slot>();
  for (const interval of intervals) {
    if (!finite(interval.energy_kwh) || interval.energy_kwh < 0 || !Number.isFinite(interval.start_ms) ||
      interval.cooling === true) continue;
    const at = Math.floor(interval.start_ms / HOUR_MS) * HOUR_MS;
    const entry: Slot = byHour.get(at) ?? { quarters: new Map() };
    if (interval.duration_s === 3600 && interval.start_ms === at) entry.hour = interval;
    else if (interval.duration_s === 900) entry.quarters.set(interval.start_ms, interval);
    byHour.set(at, entry);
  }
  const hours: Hour[] = [];
  for (const [at, entry] of [...byHour].sort(([a], [b]) => a - b)) {
    const quarters = [...entry.quarters.values()];
    if (quarters.length === 4) {
      const peaks = quarters.map(q => q.peak_w), outdoors = quarters.map(q => q.outdoor_c).filter(finite);
      hours.push({ start_ms: at, mean_w: quarters.reduce((sum, q) => sum + q.energy_kwh, 0) * 1000,
        peak_w: peaks.every(finite) ? Math.max(...peaks as number[]) : null,
        outdoor_c: outdoors.length ? mean(outdoors) : null });
    } else if (entry.hour) {
      hours.push({ start_ms: at, mean_w: entry.hour.energy_kwh * 1000,
        peak_w: finite(entry.hour.peak_w) ? entry.hour.peak_w : null,
        outdoor_c: finite(entry.hour.outdoor_c) ? entry.hour.outdoor_c : null });
    }
  }
  return hours;
}

/** What each hour was, from the hours around it. A gap is never standby. */
function roles(hours: readonly Hour[]): Role[] {
  const result: Role[] = [];
  for (let i = 0; i < hours.length; i++) {
    const hour = hours[i];
    const previous = i > 0 && hours[i - 1].start_ms === hour.start_ms - HOUR_MS ? result[i - 1] : null;
    if (hour.mean_w < STANDBY_W) { result.push({ kind: "standby" }); continue; }
    if (!previous) { result.push({ kind: "unknown", hour: 0 }); continue; }
    if (previous.kind === "standby") { result.push({ kind: "start" }); continue; }
    if (previous.kind === "unknown") {
      result.push(previous.hour + 1 > RECOVERY_HOURS ? { kind: "running" } : { kind: "unknown", hour: previous.hour + 1 });
      continue;
    }
    const since = previous.kind === "start" ? 1 : previous.kind === "recovery" ? previous.hour + 1 : null;
    result.push(since !== null && since <= RECOVERY_HOURS ? { kind: "recovery", hour: since } : { kind: "running" });
  }
  return result;
}

function fitBands(hours: readonly Hour[], kinds: readonly Role[]): HeatPumpBand[] {
  const bands = new Map<number, { outdoor: number[]; peaks: number[]; first: number[]; starts: number;
    recovery: number[][]; recoveryPeaks: number[][]; running: number[]; runningPeaks: number[] }>();
  hours.forEach((hour, i) => {
    const role = kinds[i];
    if (hour.outdoor_c === null || role.kind === "standby" || role.kind === "unknown") return;
    const band = heatingBand(hour.outdoor_c);
    const entry = bands.get(band) ?? { outdoor: [], peaks: [], first: [], starts: 0,
      recovery: Array.from({ length: RECOVERY_HOURS }, () => []),
      recoveryPeaks: Array.from({ length: RECOVERY_HOURS }, () => []), running: [], runningPeaks: [] };
    entry.outdoor.push(hour.outdoor_c);
    if (role.kind === "start") {
      entry.starts++;
      entry.first.push(hour.mean_w);
      if (hour.peak_w !== null) entry.peaks.push(hour.peak_w);
    } else if (role.kind === "recovery") {
      entry.recovery[role.hour - 1].push(hour.mean_w);
      if (hour.peak_w !== null) entry.recoveryPeaks[role.hour - 1].push(hour.peak_w);
    } else {
      entry.running.push(hour.mean_w);
      if (hour.peak_w !== null) entry.runningPeaks.push(hour.peak_w);
    }
    bands.set(band, entry);
  });
  const value = (v: number | null) => v === null ? null : round(v);
  return [...bands].sort(([a], [b]) => a - b).map(([band_c, e]) => ({
    band_c, outdoor_c: Math.round(mean(e.outdoor)! * 10) / 10, starts: e.starts,
    start_peak_w: value(median(e.peaks)), start_peak_max_w: value(maximum(e.peaks)),
    first_hour_w: value(median(e.first)), recovery_w: e.recovery.map(samples => value(median(samples))),
    recovery_peak_w: e.recoveryPeaks.map(samples => value(maximum(samples))),
    running_hours: e.running.length, running_w: value(median(e.running)), running_peak_w: value(maximum(e.runningPeaks)),
  }));
}

/** The band nearest the outdoor temperature that states the value; a tie takes the colder band. */
function nearest(bands: readonly HeatPumpBand[], outdoorC: number, pick: (band: HeatPumpBand) => number | null): number | null {
  const target = heatingBand(outdoorC);
  let best: { distance: number; band_c: number; value: number } | null = null;
  for (const band of bands) {
    const value = pick(band);
    if (value === null) continue;
    const distance = Math.abs(band.band_c - target);
    if (!best || distance < best.distance || (distance === best.distance && band.band_c < best.band_c)) {
      best = { distance, band_c: band.band_c, value };
    }
  }
  return best?.value ?? null;
}

function check(hours: readonly Hour[], kinds: readonly Role[], fromMs: number, toMs: number): HeatPumpCheck {
  const from = iso(fromMs), to = iso(toMs);
  const before = hours.findIndex(hour => hour.start_ms >= fromMs);
  const split = before < 0 ? hours.length : before;
  const training = fitBands(hours.slice(0, split), kinds.slice(0, split));
  if (!training.some(band => band.first_hour_w !== null)) return { available: false, reason: "no_training_starts", from, to };
  const checked: HeatPumpCheckHour[] = [];
  for (let i = split; i < hours.length; i++) {
    const hour = hours[i], role = kinds[i];
    if (hour.outdoor_c === null || role.kind === "standby" || role.kind === "unknown") continue;
    const at = hour.outdoor_c;
    const running = nearest(training, at, band => band.running_w);
    const predicted = role.kind === "start" ? nearest(training, at, band => band.first_hour_w)
      : role.kind === "recovery" ? nearest(training, at, band => band.recovery_w[role.hour - 1]) ?? running : running;
    const runningPeak = nearest(training, at, band => band.running_peak_w);
    const peak = role.kind === "start" ? nearest(training, at, band => band.start_peak_max_w)
      : role.kind === "recovery" ? nearest(training, at, band => band.recovery_peak_w[role.hour - 1]) ?? runningPeak
      : runningPeak;
    checked.push({ at: iso(hour.start_ms), outdoor_c: Math.round(at * 10) / 10, measured_w: round(hour.mean_w),
      predicted_w: predicted, measured_peak_w: hour.peak_w === null ? null : round(hour.peak_w),
      predicted_peak_w: peak, start: role.kind === "start" });
  }
  if (!checked.length) return { available: false, reason: "no_check_hours", from, to };
  const drawn = checked.filter(hour => hour.predicted_w !== null);
  const errors = drawn.map(hour => hour.predicted_w! - hour.measured_w);
  const peaks = checked.filter(hour => hour.measured_peak_w !== null && hour.predicted_peak_w !== null);
  const starts = peaks.filter(hour => hour.start), running = peaks.filter(hour => !hour.start);
  const within = (hour: HeatPumpCheckHour) => hour.measured_peak_w! <= hour.predicted_peak_w!;
  const error = mean(errors.map(Math.abs)), bias = mean(errors);
  return { available: true, from, to, hours: checked,
    draw_error_w: error === null ? null : round(error), draw_bias_w: bias === null ? null : round(bias),
    running_hours: drawn.length, starts: starts.length, starts_within_peak: starts.filter(within).length,
    running_peak_hours: running.length, running_peaks_within: running.filter(within).length };
}

/** Recomputed from the stored intervals on every refit; nothing here is measured state of its own. */
export function learnHeatPumpStartup(intervals: readonly HeatPumpInterval[], nowMs: number): HeatPumpStartupModel {
  const hours = heatPumpHours(intervals).filter(hour => hour.start_ms + HOUR_MS <= nowMs);
  const kinds = roles(hours);
  const starts: HeatPumpStart[] = [];
  hours.forEach((hour, i) => {
    if (kinds[i].kind === "start" && hour.outdoor_c !== null) starts.push({ at: iso(hour.start_ms),
      outdoor_c: Math.round(hour.outdoor_c * 10) / 10, peak_w: hour.peak_w === null ? null : round(hour.peak_w),
      first_hour_w: round(hour.mean_w) });
  });
  const checkTo = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  return {
    method: HEAT_PUMP_STARTUP_METHOD, standby_w: STANDBY_W, recovery_hours: RECOVERY_HOURS,
    observed_from: hours.length ? iso(hours[0].start_ms) : null,
    observed_to: hours.length ? iso(hours[hours.length - 1].start_ms + HOUR_MS) : null,
    bands: fitBands(hours, kinds),
    starts: starts.slice(-MAX_LISTED_STARTS),
    check: check(hours, kinds, checkTo - CHECK_DAYS * 24 * HOUR_MS, checkTo),
  };
}
