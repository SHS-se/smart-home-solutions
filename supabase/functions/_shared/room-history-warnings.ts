import { planningWarning } from "./planner/planning-warnings.ts";
import { timeZoneFormatter } from "./time-zone-formatter.ts";

export const ROOM_HISTORY_QUARTER_MS = 900_000;
const LATE_QUARTERS = 2;
// This threshold controls visibility only. Each missing quarter still affects the estimate.
const WARNING_QUARTERS = 8;
const gapClock = timeZoneFormatter("sv-SE", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  hourCycle: "h23", timeZoneName: "shortOffset",
});

interface HistorySource {
  label: string;
  observed: ReadonlySet<number> | ReadonlyMap<number, number>;
}

interface MissingInterval {
  from: number;
  until: number;
  sources: string;
}

export function roomHistoryWarning(
  room: { key: string; name: string },
  code: string,
  starts: readonly number[],
  sources: readonly HistorySource[],
  consequence: string,
  timeZone: string,
) {
  const incomplete = starts.flatMap((start, index) => {
    const missing = sources.filter(source => !source.observed.has(start)).map(source => source.label);
    return missing.length ? [{ start, index, sources: missing.join(" and ") }] : [];
  });
  if (incomplete.length === 0) return;
  const older = incomplete.filter(quarter => quarter.index < starts.length - LATE_QUARTERS);
  if (older.length === 0) return planningWarning("room_heat_history_late", room.key,
    `${room.name} is waiting for its latest room history.`, consequence, { quarters: incomplete.length });
  if (older.length < WARNING_QUARTERS) return;

  const intervals: MissingInterval[] = [];
  for (const { start, sources } of older) {
    const previous = intervals.at(-1);
    const until = start + ROOM_HISTORY_QUARTER_MS;
    if (previous?.until === start && previous.sources === sources) previous.until = until;
    else intervals.push({ from: start, until, sources });
  }
  const clock = gapClock(timeZone);
  const minutes = older.length * ROOM_HISTORY_QUARTER_MS / 60_000;
  const hours = Math.floor(minutes / 60);
  const duration = minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const details = intervals.map(({ from, until, sources }) =>
    `${sources} missing from ${clock.format(from)} to ${clock.format(until)}.`);
  return planningWarning(code, room.key, `${room.name} has ${duration} of missing room history.`,
    [...details, consequence].join(" "), { quarters: older.length, intervals: JSON.stringify(intervals) });
}
