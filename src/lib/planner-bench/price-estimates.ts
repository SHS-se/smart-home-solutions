// The planner's price estimates beside the prices the market then published.
//
// A plan covers 72 hours and the market publishes one day ahead, so most of a
// plan is priced by estimate (supabase/functions/_shared/planner/energy-price-shape.ts).
// The last estimate made for each day before it was published is kept per home
// (energy_price_estimate_days). This module turns those rows, and the real
// prices of the same days, into what the accuracy view draws and tabulates:
// every figure is worked out here from the quarters the chart shows, so the
// table and the chart cannot disagree.
//
// An estimate is a day's level times the usual shape of a day:
//   level error    how far the day's mean price was off;
//   quarter error  how far a quarter-hour was off on average, level and shape together.

export const DAY_QUARTERS = 96;
/** A day estimated in part (the plan's last day) says little about its level. */
export const MIN_SUMMARY_QUARTERS = 48;

export interface EstimateDayRow {
  home_id: string;
  home_name?: string | null;
  issued_on: string;
  issued_at: string;
  target_day: string;
  basis: string;
  timezone: string;
  /** Estimated import SEK/kWh per quarter of the local day; null where published or outside the plan. */
  quarters: (number | null)[];
}

export interface ActualDayRow {
  home_id: string;
  day: string;
  /** Published import SEK/kWh per quarter of the local day; null where the market has not published. */
  quarters: (number | null)[];
}

export interface EstimateSeries { estimates: EstimateDayRow[]; actuals: ActualDayRow[] }

/** One day of an estimate, with what it then cost. */
export interface EstimatedDay {
  day: string;
  leadDays: number;
  basis: string;
  issuedAt: string;
  /** Quarters of the day the estimate covers. */
  quarters: number;
  estimate: (number | null)[];
  /** The mean of the estimated quarters: the level the planner believed. */
  believed: number;
  /** The real mean over the same quarters; null until every one of them is published. */
  was: number | null;
  /** believed − was: positive when the estimate was too high. */
  levelError: number | null;
  /** Mean absolute error per quarter. */
  quarterError: number | null;
}

/** Everything a home estimated on one local day. */
export interface PriceEstimate {
  homeId: string;
  homeName: string;
  issuedOn: string;
  timezone: string;
  days: EstimatedDay[];
}

const number = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const quarters = (values: unknown): (number | null)[] =>
  Array.from({ length: DAY_QUARTERS }, (_, i) => number(Array.isArray(values) ? values[i] : null));
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
export const addDays = (day: string, days: number) => new Date((dayNumber(day) + days) * 86_400_000).toISOString().slice(0, 10);

const actualKey = (homeId: string, day: string) => `${homeId}/${day}`;
export const actualsByDay = (rows: readonly ActualDayRow[]) =>
  new Map(rows.map(row => [actualKey(row.home_id, row.day), quarters(row.quarters)]));

/** The estimates in the order they were made, each home's together. */
export function priceEstimates(data: EstimateSeries): PriceEstimate[] {
  const actuals = actualsByDay(data.actuals);
  const groups = new Map<string, PriceEstimate>();
  for (const row of data.estimates) {
    const estimate = quarters(row.quarters);
    const covered = estimate.flatMap((value, i) => value === null ? [] : [i]);
    if (!covered.length) continue;
    const actual = actuals.get(actualKey(row.home_id, row.target_day));
    const published = actual && covered.every(i => actual[i] !== null);
    const believed = mean(covered.map(i => estimate[i]!));
    const was = published ? mean(covered.map(i => actual[i]!)) : null;
    const id = `${row.home_id}/${row.issued_on}`;
    const group = groups.get(id) ?? {
      homeId: row.home_id, homeName: row.home_name || row.home_id.slice(0, 8), issuedOn: row.issued_on, timezone: row.timezone, days: [],
    };
    group.days.push({
      day: row.target_day, leadDays: dayNumber(row.target_day) - dayNumber(row.issued_on), basis: row.basis, issuedAt: row.issued_at,
      quarters: covered.length, estimate, believed, was,
      levelError: was === null ? null : believed - was,
      quarterError: published ? mean(covered.map(i => Math.abs(estimate[i]! - actual[i]!))) : null,
    });
    groups.set(id, group);
  }
  return [...groups.values()]
    .map(group => ({ ...group, days: group.days.sort((a, b) => a.day.localeCompare(b.day)) }))
    .sort((a, b) => a.homeId.localeCompare(b.homeId) || a.issuedOn.localeCompare(b.issuedOn));
}

export interface LeadSummary {
  lead: number;
  basis: string;
  /** Estimated days whose real prices are in. */
  days: number;
  /** Mean size of the level error. */
  levelError: number;
  /** Mean level error with its sign: positive when estimates run high. */
  bias: number;
  quarterError: number;
}

/** Mean errors per days ahead and basis, over the estimated days the market has since published. */
export function summariseEstimates(estimates: readonly PriceEstimate[]): LeadSummary[] {
  const groups = new Map<string, EstimatedDay[]>();
  for (const day of estimates.flatMap(estimate => estimate.days)) {
    if (day.levelError === null || day.quarterError === null || day.quarters < MIN_SUMMARY_QUARTERS) continue;
    const key = `${day.leadDays}/${day.basis}`;
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  return [...groups.values()].map(group => ({
    lead: group[0].leadDays, basis: group[0].basis, days: group.length,
    levelError: mean(group.map(day => Math.abs(day.levelError!))),
    bias: mean(group.map(day => day.levelError!)),
    quarterError: mean(group.map(day => day.quarterError!)),
  })).sort((a, b) => a.lead - b.lead || a.basis.localeCompare(b.basis));
}

/** One day of the chart: the real prices, and the estimate where this day was estimated. */
export interface ChartDay {
  day: string;
  actual: (number | null)[];
  estimated: EstimatedDay | null;
}

/**
 * The days an estimate is drawn over: the day it was made, whose prices were
 * already published, then every day up to the last one it estimated.
 */
export function chartDays(estimate: PriceEstimate, actuals: ReadonlyMap<string, (number | null)[]>): ChartDay[] {
  const last = estimate.days[estimate.days.length - 1].day;
  const days: ChartDay[] = [];
  for (let day = estimate.issuedOn; day <= last; day = addDays(day, 1)) {
    days.push({
      day, actual: actuals.get(actualKey(estimate.homeId, day)) ?? new Array(DAY_QUARTERS).fill(null),
      estimated: estimate.days.find(d => d.day === day) ?? null,
    });
  }
  return days;
}
