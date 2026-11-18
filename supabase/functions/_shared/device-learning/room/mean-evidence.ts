import { isolatedTemperatureCorrections } from "../temperature-evidence.ts";
import type { RoomMeanQuarter } from "./mean-observations.ts";

/** Existing quarter adapters omit duration; native observations name theirs. */
export const roomIntervalSeconds = (row: RoomMeanQuarter): number => row.duration_s ?? 900;
export const roomIntervalHours = (row: RoomMeanQuarter): number => roomIntervalSeconds(row) / 3600;

/** One correction policy for all room fits. Never borrow a point across a gap,
 * a resolution change or the caller's training/validation boundary. Raw rows
 * remain unchanged; corrections are estimates, with their count in evidence. */
export function prepareRoomMeanEvidence(input: readonly RoomMeanQuarter[], include?: (row: RoomMeanQuarter) => boolean) {
  const observed = [...input].sort((a, b) => a.start_ms - b.start_ms);
  const rows: RoomMeanQuarter[] = [];
  let count = 0, start = 0;
  while (start < observed.length) {
    const seconds = roomIntervalSeconds(observed[start]);
    const included = include?.(observed[start]) ?? true;
    let end = start + 1;
    while (end < observed.length && roomIntervalSeconds(observed[end]) === seconds &&
      observed[end].start_ms === observed[end - 1].start_ms + seconds * 1000 &&
      (include?.(observed[end]) ?? true) === included) end++;
    const segment = observed.slice(start, end);
    const estimates = included ? isolatedTemperatureCorrections(segment.map(row => ({ at: row.start_ms, c: row.room_c })), seconds * 1000) : new Map<number, number>();
    count += estimates.size;
    rows.push(...segment.map(row => estimates.has(row.start_ms) ? { ...row, room_c: estimates.get(row.start_ms)! } : row));
    start = end;
  }
  return { rows, count };
}
