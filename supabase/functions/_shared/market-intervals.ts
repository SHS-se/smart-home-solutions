/** Duration-weighted native coverage. Conflicts and holes remain unavailable. */
export interface ValueInterval { startMs: number; endMs: number; value: number }
function segments(rows: readonly ValueInterval[], start: number, end: number,
  visit: (duration: number, values: ReadonlyMap<number, number>) => void) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid interval window');
  const events = new Map<number, { value: number; delta: number }[]>([[start, []], [end, []]]);
  for (const row of rows) {
    if (![row.startMs, row.endMs, row.value].every(Number.isFinite) || row.endMs <= row.startMs) throw new Error('Invalid native interval');
    if (row.startMs >= end || row.endMs <= start) continue;
    for (const [at, delta] of [[Math.max(start, row.startMs), 1], [Math.min(end, row.endMs), -1]]) {
      if (!events.has(at)) events.set(at, []);
      events.get(at)!.push({ value: row.value, delta });
    }
  }
  const active = new Map<number, number>();
  let previous = start;
  for (const [at, changes] of [...events].sort(([a], [b]) => a - b)) {
    if (at > previous) visit(at - previous, active);
    for (const { value, delta } of changes) {
      const count = (active.get(value) ?? 0) + delta;
      if (count) active.set(value, count); else active.delete(value);
    }
    previous = at;
  }
}
export function intervalMean(rows: readonly ValueInterval[], start: number, end: number): number | null {
  let integral = 0, complete = true;
  segments(rows, start, end, (duration, values) => {
    if (values.size !== 1) complete = false;
    else integral += values.keys().next().value! * duration;
  });
  return complete ? integral / (end - start) : null;
}
export function intervalCoverage(rows: readonly ValueInterval[], start: number, end: number) {
  let coveredMs = 0, conflictMs = 0, duplicateMs = 0;
  segments(rows, start, end, (duration, values) => {
    if (values.size > 1) conflictMs += duration;
    else if (values.size) {
      coveredMs += duration;
      if (values.values().next().value! > 1) duplicateMs += duration;
    }
  });
  return { expectedMs: end - start, coveredMs, missingMs: end - start - coveredMs - conflictMs, conflictMs, duplicateMs };
}
