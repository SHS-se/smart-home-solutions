/** Canonical native-mean run measurements. No model, regression or source writes. */
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { roomIntervalHours, roomIntervalSeconds } from "./mean-evidence.ts";
import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import { HEATED_SAMPLE_MIN_W } from "./regression.ts";
import type { MeasuredRoomRun, MeasuredHeatingPoint, MeasuredCoolingPoint } from "../../planner/models/room/measured-evidence.ts";

export interface HeatingRun {
  id: string; from_ms: number; on_from_ms: number; off_from_ms: number; to_ms: number;
  from: number; on: number; off: number; end: number; measured_wh: number;
}
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const known = (row: RoomMeanQuarter) => finite(row.heat_w) && row.heat_w >= 0 && roomHeatingDirectionKnown(row);
const endMs = (row: RoomMeanQuarter) => row.start_ms + roomIntervalSeconds(row) * 1000;
const midpoint = (row: RoomMeanQuarter) => (row.start_ms + endMs(row)) / 2;

/** A missing counter or operation direction is not an OFF identity. */
export function roomHeatingRuns(rows: readonly RoomMeanQuarter[]): HeatingRun[] {
  const runs: HeatingRun[] = [];
  let start = 0;
  while (start < rows.length) {
    while (start < rows.length && !known(rows[start])) start++;
    let stop = start + 1;
    while (stop < rows.length && known(rows[stop]) && rows[stop].start_ms === endMs(rows[stop - 1])) stop++;
    for (let i = start + 1; i < stop; i++) {
      if (rows[i].heat_w! <= HEATED_SAMPLE_MIN_W || rows[i - 1].heat_w! > HEATED_SAMPLE_MIN_W) continue;
      const on = i;
      while (i < stop && rows[i].heat_w! > HEATED_SAMPLE_MIN_W) i++;
      const off = i;
      if (off === stop) break;
      while (i < stop && rows[i].heat_w! <= HEATED_SAMPLE_MIN_W) i++;
      const end = i - 1, from = on - 1;
      runs.push({ id: String(rows[on].start_ms), from_ms: rows[from].start_ms,
        on_from_ms: rows[on].start_ms, off_from_ms: rows[off].start_ms, to_ms: endMs(rows[end]),
        from, on, off, end, measured_wh: rows.slice(on, off).reduce((sum, row) => sum + row.heat_w! * roomIntervalHours(row), 0) });
      i--;
    }
    start = stop;
  }
  return runs;
}

function heating(rows: readonly RoomMeanQuarter[], run: HeatingRun): MeasuredHeatingPoint | null {
  const before = rows[run.from], first = rows[run.on];
  if (!finite(before.room_c) || !finite(first.room_c)) return null;
  let peak = -1;
  for (let i = run.on; i <= run.end; i++) {
    const value = rows[i].room_c;
    // A missing later mean can hide the actual peak. Publish no primary
    // endpoint until that measured search window is complete.
    if (!finite(value)) return null;
    if (peak < 0 || value > rows[peak].room_c!) peak = i;
  }
  // A final-bin maximum is right-censored, not an observed peak.
  if (peak < 0 || peak === run.end) return null;
  const onMs = first.start_ms, peakMs = midpoint(rows[peak]), duration = peakMs - onMs;
  if (!(duration > 0)) return null;
  const startC = before.room_c + (first.room_c - before.room_c) * (onMs - midpoint(before)) / (midpoint(first) - midpoint(before));
  let energy = 0, outdoor = 0, room = 0, house = 0, houseKnown = true, covered = 0;
  const resolutions = new Set<number>();
  for (let i = run.on; i <= peak; i++) {
    const row = rows[i], overlap = Math.max(0, Math.min(peakMs, endMs(row)) - Math.max(onMs, row.start_ms));
    if (!overlap) continue;
    if (!known(row) || !finite(row.outdoor_c) || !finite(row.room_c)) return null;
    covered += overlap;
    energy += row.heat_w! * overlap / 3_600_000_000;
    outdoor += row.outdoor_c * overlap; room += row.room_c * overlap;
    if (finite(row.house_c)) house += row.house_c * overlap; else houseKnown = false;
    resolutions.add(roomIntervalSeconds(row));
  }
  if (covered !== duration || !(energy > 0)) return null;
  const rise = rows[peak].room_c! - startC;
  return { on_ms: onMs, peak_ms: peakMs, peak_end_ms: endMs(rows[peak]), energy_kwh: energy,
    hours: duration / 3_600_000, rise_c: rise, c_per_kwh: rise / energy,
    room_start_c: startC, room_peak_c: rows[peak].room_c!, room_mean_c: room / duration,
    outdoor_c: outdoor / duration, house_c: houseKnown ? house / duration : null, native_seconds: [...resolutions].sort((a, b) => a - b) };
}

/** A cooling point can exist even when the onset temperature was unavailable.
 * It still needs known OFF identities and its preceding measured run energy. */
function cooling(rows: readonly RoomMeanQuarter[], run: HeatingRun, peakEnd: number): MeasuredCoolingPoint | null {
  // A room may peak while the heater is still on. Both events must precede
  // the settling interval before measuring an off-phase fall rate.
  const from = Math.max(peakEnd, rows[run.off].start_ms) + 3_600_000, to = from + 3 * 3_600_000;
  const tail = rows.slice(run.off, run.end + 1).filter(row => midpoint(row) >= from && midpoint(row) <= to &&
    known(row) && row.heat_w! <= HEATED_SAMPLE_MIN_W && finite(row.room_c) && finite(row.outdoor_c));
  if (tail.length < 3) return null;
  const span = (midpoint(tail.at(-1)!) - midpoint(tail[0])) / 3_600_000;
  if (span < 1) return null;
  const total = tail.reduce((sum, row) => sum + roomIntervalHours(row), 0);
  const mean = (get: (row: RoomMeanQuarter) => number) => tail.reduce((sum, row) => sum + roomIntervalHours(row) * get(row), 0) / total;
  const meanX = mean(row => (midpoint(row) - from) / 3_600_000), meanY = mean(row => row.room_c!);
  let xx = 0, xy = 0;
  for (const row of tail) {
    const x = (midpoint(row) - from) / 3_600_000 - meanX, w = roomIntervalHours(row);
    xx += w * x * x; xy += w * x * (row.room_c! - meanY);
  }
  if (!(xx > 0) || !(run.measured_wh > 0)) return null;
  const windowFrom = midpoint(tail[0]), windowTo = midpoint(tail.at(-1)!);
  let energy = 0;
  for (let i = run.off; i <= run.end; i++) {
    const row = rows[i], overlap = Math.max(0, Math.min(windowTo, endMs(row)) - Math.max(windowFrom, row.start_ms));
    if (overlap) energy += row.heat_w! * overlap / 3_600_000_000;
  }
  return { from_ms: midpoint(tail[0]), to_ms: midpoint(tail.at(-1)!), hours: span,
    c_per_h: -xy / xx, room_c: meanY, outdoor_c: mean(row => row.outdoor_c!),
    house_c: tail.every(row => finite(row.house_c)) ? mean(row => row.house_c!) : null,
    energy_kwh: energy };
}

export function measureRoomRuns(rows: readonly RoomMeanQuarter[]): MeasuredRoomRun[] {
  return roomHeatingRuns(rows).map(run => {
    const heat = heating(rows, run);
    let peak = run.on;
    for (let i = run.on; i <= run.end; i++) if (finite(rows[i].room_c) &&
      (!finite(rows[peak].room_c) || rows[i].room_c! > rows[peak].room_c!)) peak = i;
    const cool = finite(rows[peak].room_c) ? cooling(rows, run, endMs(rows[peak])) : null;
    const reasons: string[] = [];
    if (!heat) reasons.push("heating_window_incomplete");
    if (!cool) reasons.push("cooling_window_incomplete");
    return { id: run.id, from_ms: run.from_ms, on_ms: run.on_from_ms, off_ms: run.off_from_ms,
      to_ms: run.to_ms, energy_kwh: run.measured_wh / 1000, heating: heat, cooling: cool, reasons };
  });
}
