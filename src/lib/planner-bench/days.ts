// The local calendar days a bench plan touches. The plan chart and the rule
// list show the same period, so both read their quarter ranges from here.

import { formatHomeDayMonth } from '@/lib/energy-shift/home-time';

/** One local day of a plan, as a [from, to) range of quarter indexes. */
export interface BenchDay { label: string; from: number; to: number }

/** A day's index, or the whole plan. */
export type BenchPeriod = number | 'all';

export function benchDays(start: readonly string[], timeZone: string): BenchDay[] {
  const out: BenchDay[] = [];
  start.forEach((at, i) => {
    const label = formatHomeDayMonth(at, timeZone);
    if (out.length && out[out.length - 1].label === label) out[out.length - 1].to = i + 1;
    else out.push({ label, from: i, to: i + 1 });
  });
  return out;
}

/** The quarters a period covers; the whole plan when the day is not there. */
export const periodRange = (days: readonly BenchDay[], period: BenchPeriod, length: number): { from: number; to: number } =>
  period === 'all' || !days.length ? { from: 0, to: length } : days[Math.min(period, days.length - 1)];
