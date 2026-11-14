const QUARTER_MS = 900_000;
const DAY_MS = 86_400_000;
export const EV_USAGE_HISTORY_DAYS = 56;

/** Quarter average SOC and metered AC energy, with null for unavailable observations. */
export type EvUsageQuarter = readonly [startMs: number, soc: number | null, chargeKwh: number | null];
export interface EvWeekdayUsage {
  /** Battery kWh per local day, Sunday first. An unseen weekday uses the mean of observed days. */
  readonly kwh: readonly number[];
  readonly days: readonly number[];
}

const weekday = (date: string) => new Date(date).getUTCDay();
type CalendarDate = (at: number) => string;

/** Find the local date boundary on the absolute quarter grid. */
function firstQuarterOfDay(ms: number, localDate: CalendarDate): number {
  const date = localDate(ms);
  let first = Math.floor(ms / QUARTER_MS) - 26 * 4, last = Math.floor(ms / QUARTER_MS);
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (localDate(middle * QUARTER_MS) < date) first = middle + 1;
    else last = middle;
  }
  return first * QUARTER_MS;
}

/** Estimate one day's battery use from its boundary levels and measured charger energy.
 * Midpoints align quarter-average SOC with half the energy in each boundary quarter. */
export function observedEvUsageDays(rows: readonly EvUsageQuarter[], beforeMs: number, localDate: CalendarDate,
  car: { capacity_kwh: number; charge_efficiency: number }) {
  const quarters = new Map(rows.filter(([start]) => start + QUARTER_MS <= beforeMs).map(row => [row[0], row]));
  if (!quarters.size) return [];
  const first = firstQuarterOfDay(Math.min(...quarters.keys()), localDate);
  const last = firstQuarterOfDay(beforeMs, localDate);
  const result: { date: string; start: number; end: number; kwh: number | null; late: boolean; missing: boolean }[] = [];
  for (let start = first; start < last;) {
    const end = firstQuarterOfDay(start + 26 * 3_600_000, localDate);
    const date = localDate(start);
    const opening = quarters.get(start)?.[1], closing = quarters.get(end)?.[1];
    let total = 0, late = false, missing = false;
    const observeGap = (at: number) => {
      if (at + 3 * QUARTER_MS > beforeMs) late = true;
      else missing = true;
    };
    if (opening == null) observeGap(start);
    if (closing == null) observeGap(end);
    for (let at = start; at <= end; at += QUARTER_MS) {
      const charge = quarters.get(at)?.[2];
      if (charge == null) observeGap(at);
      else total += charge * (at === start || at === end ? 0.5 : 1);
    }
    result.push({ date, start, end, late, missing, kwh: opening != null && closing != null && !late && !missing
      ? Math.max(0, (opening - closing) * car.capacity_kwh + total * car.charge_efficiency) : null });
    start = end;
  }
  return result;
}

export function fitWeekdayEvUsage(rows: readonly EvUsageQuarter[], captureMs: number, localDate: CalendarDate,
  car: { capacity_kwh: number; charge_efficiency: number }) {
  const captureDay = localDate(captureMs);
  const oldest = Date.parse(captureDay) - EV_USAGE_HISTORY_DAYS * DAY_MS;
  const observed = observedEvUsageDays(rows, captureMs, localDate, car).filter(day => Date.parse(day.date) >= oldest);
  const totals = Array<number>(7).fill(0), days = Array<number>(7).fill(0);
  let gaps = 0, count = 0, total = 0, late = false;
  for (const day of observed) {
    if (day.kwh === null) {
      if (day.late) late = true;
      if (day.missing) gaps++;
      continue;
    }
    const index = weekday(day.date);
    totals[index] += day.kwh;
    days[index]++;
    total += day.kwh;
    count++;
  }
  return { usage: count ? { days, kwh: totals.map((value, i) => days[i] ? value / days[i] : total / count) } : null, gaps, late };
}

/** Spread each local day's total over its actual elapsed length (including DST).
 * The first, partly elapsed quarter is scaled separately by native physics. */
export function weekdayEvUsageKw(usage: EvWeekdayUsage, starts: readonly string[], localDate: CalendarDate): number[] {
  const lengths = new Map<string, number>();
  return starts.map(start => {
    const ms = Date.parse(start);
    const date = localDate(ms);
    let hours = lengths.get(date);
    if (hours === undefined) {
      // Resolve the day's two boundaries on the same quarter grid as the plan.
      const first = firstQuarterOfDay(ms, localDate);
      hours = (firstQuarterOfDay(first + 26 * 3_600_000, localDate) - first) / 3_600_000;
      lengths.set(date, hours);
    }
    return usage.kwh[weekday(date)] / hours;
  });
}
