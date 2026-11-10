/** Browser projection of the immutable TEST experiment; no model fitting here. */
export interface PricePairScore {
  lead_day: number;
  scored_quarters: number;
  origin_count: number;
  target_day_count: number;
  reduced_mae: number;
  full_mae: number;
  reduced_bias: number;
  full_bias: number;
  mae_improvement: number;
  reduced_daily_mean_mae: number;
  full_daily_mean_mae: number;
  complete_day_origins: number;
  scored_day_origins: number;
  /** Weather study only: distinct delivery days on which the candidate had the lower error. */
  day_wins?: number;
  /** Weather study only: scored deployed quarters, including those the candidate did not cover. */
  baseline_quarters?: number;
}
export interface PricePairDayScore {
  target_day: string;
  lead_day: number;
  scored_quarters: number;
  origin_count: number;
  reduced_mae: number;
  full_mae: number;
}
export interface PricePairSummary {
  id: string;
  status: 'pending' | 'paired' | 'unavailable';
  reserved_at: string;
  saved_at: string | null;
  target_count: number;
  eligible_count: number;
  scored_count: number;
}
export interface PricePairTarget {
  start: string;
  target_day: string;
  lead_day: number;
  reduced: number;
  full: number;
  actual: number | null;
  truth_sequence: number | null;
}
export interface PricePairComparison {
  enabled: boolean;
  updated_at: string;
  home_name?: string;
  report: { truth_cutoff: number; pair_count: number; scores: PricePairScore[]; pairs: PricePairSummary[]; days?: PricePairDayScore[] };
  /** Weather study replay only: the delivery days fixed as holdout before any of them was scored. */
  holdout?: { from: string; to: string } | null;
  selected: (Omit<PricePairSummary, 'scored_count'> & { reason: string | null; training_quarters: number | null; baseline_generated_at?: string }) | null;
  targets: PricePairTarget[];
}
export interface PricePairDay {
  day: string;
  leadDay: number;
  eligible: number;
  scored: number;
  expected: number;
  reducedMae: number | null;
  fullMae: number | null;
}
const QUARTER = 900_000;
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Duration of a Stockholm day, including the 92/100-quarter DST days. */
function expectedQuarters(day: string): number {
  const nominal = Date.parse(`${day}T00:00:00Z`);
  let count = 0;
  for (let at = nominal - 3 * 3_600_000; at < nominal + 26 * 3_600_000; at += QUARTER) {
    if (localDate.format(at) === day) count++;
  }
  return count;
}
export function pricePairDays(targets: readonly PricePairTarget[]): PricePairDay[] {
  const days = new Map<string, PricePairTarget[]>();
  for (const target of targets) {
    const key = target.target_day;
    const rows = days.get(key) ?? [];
    rows.push(target); days.set(key, rows);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, rows]) => {
    const scored = rows.filter((row): row is PricePairTarget & { actual: number } => row.actual !== null);
    return { day, leadDay: rows[0].lead_day, eligible: rows.length, scored: scored.length, expected: expectedQuarters(day),
      reducedMae: scored.length ? scored.reduce((sum, row) => sum + Math.abs(row.reduced - row.actual), 0) / scored.length : null,
      fullMae: scored.length ? scored.reduce((sum, row) => sum + Math.abs(row.full - row.actual), 0) / scored.length : null };
  });
}
/** UTC time grid preserves missing quarter gaps and repeated local DST hours. */
export function pricePairChartRows(targets: readonly PricePairTarget[]) {
  if (!targets.length) return [];
  const rows = new Map(targets.map(row => [Date.parse(row.start), row]));
  const times = [...rows.keys()];
  const result: { at: number; reduced: number | null; full: number | null; actual: number | null }[] = [];
  for (let at = Math.min(...times); at <= Math.max(...times); at += QUARTER) {
    const row = rows.get(at);
    result.push({ at, reduced: row?.reduced ?? null, full: row?.full ?? null, actual: row?.actual ?? null });
  }
  return result;
}

export interface WeatherPriceRule { key: 'mae' | 'days' | 'interval' | 'coverage'; met: boolean; values: number[] }
/**
 * The success criterion fixed before the holdout was scored: at each lead the candidate's error is at
 * least 5% lower and lower on at least three quarters of the delivery days, the day-resampled 90%
 * interval of the combined error difference lies below zero, and it covers at least 98% of the quarters.
 */
export function weatherPriceCriterion(scores: readonly PricePairScore[], days: readonly PricePairDayScore[]): WeatherPriceRule[] | null {
  const leads = [2, 3].map(lead => scores.find(score => score.lead_day === lead));
  if (leads.some(score => !score || score.day_wins === undefined || !score.baseline_quarters)) return null;
  const both = leads as (PricePairScore & { day_wins: number; baseline_quarters: number })[];
  const reduction = both.map(score => score.reduced_mae > 0 ? 1 - score.full_mae / score.reduced_mae : 0);
  const coverage = both.map(score => score.scored_quarters / score.baseline_quarters);
  // Quarters within a delivery day move together, so whole days are resampled.
  const byDay = new Map<string, { difference: number; quarters: number }>();
  for (const day of days) {
    const entry = byDay.get(day.target_day) ?? { difference: 0, quarters: 0 };
    entry.difference += (day.full_mae - day.reduced_mae) * day.scored_quarters; entry.quarters += day.scored_quarters;
    byDay.set(day.target_day, entry);
  }
  const blocks = [...byDay.keys()].sort().map(day => byDay.get(day)!);
  let seed = 12345;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const draws: number[] = [];
  for (let draw = 0; draw < 4000 && blocks.length; draw++) {
    let difference = 0, quarters = 0;
    for (let pick = 0; pick < blocks.length; pick++) {
      const block = blocks[Math.floor(random() * blocks.length)];
      difference += block.difference; quarters += block.quarters;
    }
    draws.push(difference / quarters);
  }
  draws.sort((left, right) => left - right);
  const interval = draws.length ? [draws[Math.floor(draws.length * 0.05)], draws[Math.floor(draws.length * 0.95)]] : [0, 0];
  return [
    { key: 'mae', met: reduction.every(value => value >= 0.05), values: reduction },
    { key: 'days', met: both.every(score => score.day_wins >= 0.75 * score.target_day_count), values: both.flatMap(score => [score.day_wins, score.target_day_count]) },
    { key: 'interval', met: draws.length > 0 && interval[1] < 0, values: interval },
    { key: 'coverage', met: coverage.every(value => value >= 0.98), values: coverage },
  ];
}
