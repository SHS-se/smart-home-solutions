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
  report: { truth_cutoff: number; pair_count: number; scores: PricePairScore[]; pairs: PricePairSummary[] };
  selected: (Omit<PricePairSummary, 'scored_count'> & { reason: string | null; training_quarters: number | null }) | null;
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
