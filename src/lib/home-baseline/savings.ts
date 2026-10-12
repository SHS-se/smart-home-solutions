import { homeMonthBounds } from '../energy-shift/home-time';
import { localDay } from '../../../supabase/functions/_shared/planner-wasm/calendar';
import type { BaselineCapture, ComparisonCapture } from './browser';
import { periodComparison } from './comparison';

export function monthsBetween(from: string, to: string): string[] {
  const valid = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  if (!valid(from) || !valid(to) || from > to) throw new Error('Choose a valid month range');
  const months: string[] = [];
  for (let key = from; key <= to;) {
    months.push(key);
    if (months.length > 12) throw new Error('Select at most 12 months');
    if (key === to) break;
    const [year, month] = key.split('-').map(Number);
    key = `${String(month === 12 ? year + 1 : year).padStart(4, '0')}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}`;
  }
  return months;
}

export function monthLedger(capture: BaselineCapture) {
  const { input, result } = capture;
  const bounds = homeMonthBounds(input.start, 0, input.timeZone);
  const start = Date.parse(input.start), end = Date.parse(input.end);
  if (start !== bounds.startMs || end <= start || end > bounds.endMs) throw new Error('Savings require a calendar month period');
  const comparison = periodComparison(capture);
  return { month: localDay(input.start, input.timeZone).slice(0, 7), start: input.start, end: input.end, timeZone: input.timeZone,
    coverage: (end - start) / (bounds.endMs - bounds.startMs), baseline: result.ledger, recorded: input.recorded.ledger, comparison, gridImportCostSek: input.recorded.gridImportCostSek,
    priceArea: input.priceArea, ...captureEvidence(capture) };
}
export function comparisonMonthLedger(capture: ComparisonCapture) {
  const month = monthLedger(capture);
  return { month: month.month, start: month.start, end: month.end, timeZone: month.timeZone, coverage: month.coverage, baseline: month.baseline, recorded: month.recorded, priceArea: month.priceArea, ...captureEvidence(capture), solar: capture.input.solar, scheduler: capture.scheduler.ledger, modeled: capture.modeled, replay: { engine: capture.scheduler.engine, protocol: capture.scheduler.protocol, solves: capture.scheduler.solves } };
}
export type MonthLedger = ReturnType<typeof comparisonMonthLedger>;

/** The saved table and optional graphs expose exactly the same evidence. */
export function captureEvidence({ input }: BaselineCapture) {
  return { reconstructedPriceQuarters: input.reconstructedPriceQuarters, assumedPriceQuarters: input.assumedPriceQuarters,
    recovery: input.recovery, assumptions: { battery: input.batteryInitialAssumed, ev: input.evInitialAssumed, pool: input.poolInitialAssumed },
    quality: { missingDevices: input.evidence.missingDevices, evSocQuarters: input.evMissingSocQuarters,
      hourlyFields: input.evidence.hourlyFields }, quarters: input.problem.slots.length,
    gaps: { ...input.energyGaps, gridImportQuarters: input.recorded.missingImportQuarters, gridExportQuarters: input.recorded.missingExportQuarters } };
}

/** Positive saving means the recorded operation cost less, on the same contract. */
export function schedulerSavings(months: readonly MonthLedger[], subscriptionSekPerMonth: number | null) {
  if (subscriptionSekPerMonth !== null && (!Number.isFinite(subscriptionSekPerMonth) || subscriptionSekPerMonth < 0)) throw new Error('Invalid SHS subscription');
  const baselineSek = months.reduce((sum, month) => sum + month.baseline.costSek, 0);
  const recordedSek = months.reduce((sum, month) => sum + month.recorded.costSek, 0);
  const grossSek = baselineSek - recordedSek;
  const subscriptionSek = subscriptionSekPerMonth === null ? null : subscriptionSekPerMonth * months.reduce((sum, month) => sum + month.coverage, 0);
  return { baselineSek, recordedSek, grossSek, subscriptionSek, netSek: subscriptionSek === null ? null : grossSek - subscriptionSek };
}
