// The house a room sits in, over the plan horizon.
//
// Rooms fitted against the house temperature need it for every planned
// quarter. The house follows its own routine — the reference house lets its
// aircons rest from ten at night to five — so its last week's mean for each
// local quarter of the day is the shape, set at the level of its last day.
// Nothing here is chosen by hand: a house that changes its routine changes
// the forecast within a week, and one that changes its level within a day.

import { localSlot } from "./comfort-schedule.ts";

export interface HouseProfileRow {
  quarter_of_day: number;
  week_mean_c: number | null;
  day_mean_c: number | null;
}

const QUARTERS = 96;
/** A shape missing more than this many quarters of the day is not a shape. */
const MAX_MISSING_QUARTERS = 8;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Each start's house temperature, or null when the last week cannot say. */
export function houseTemperatureForecast(
  starts: string[],
  timezone: string,
  profile: HouseProfileRow[],
): number[] | null {
  const shape: (number | null)[] = new Array(QUARTERS).fill(null);
  const offsets: number[] = [];
  for (const row of profile) {
    const quarter = Number(row.quarter_of_day);
    if (!Number.isInteger(quarter) || quarter < 0 || quarter >= QUARTERS || !finite(row.week_mean_c)) continue;
    shape[quarter] = row.week_mean_c;
    if (finite(row.day_mean_c)) offsets.push(row.day_mean_c - row.week_mean_c);
  }
  const known = shape.flatMap((value, quarter) => value === null ? [] : [quarter]);
  if (QUARTERS - known.length > MAX_MISSING_QUARTERS) return null;
  // A missing quarter is the straight line between its known neighbours,
  // around the clock.
  const filled = shape.map((value, quarter) => {
    if (value !== null) return value;
    const before = [...known].reverse().find(q => q < quarter) ?? known.at(-1)!;
    const after = known.find(q => q > quarter) ?? known[0];
    const span = (after - before + QUARTERS) % QUARTERS || QUARTERS;
    const t = ((quarter - before + QUARTERS) % QUARTERS) / span;
    return shape[before]! + (shape[after]! - shape[before]!) * t;
  });
  const level = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
  return starts.map(start => Math.round((filled[localSlot(start, timezone).quarter] + level) * 1000) / 1000);
}
