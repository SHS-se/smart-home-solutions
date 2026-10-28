import type { MonthLedger } from './savings';
import type { BilledMonth } from './billed-months';
import { monthlyBillAmounts, recordedModeledCost, roundedSek } from './roi-pricing';
import type { EnergyBillingMonth } from '../energy-billing-series';
import type { ControlMonth } from './control-months';

/** The same months with and without the scheduler, on today's equipment.
 * Demand-free modeled costs only: an invoice never enters the estimate. */
export function savingsForecast(months: readonly MonthLedger[], subscriptionSekPerMonth: number) {
  if (!Number.isFinite(subscriptionSekPerMonth) || subscriptionSekPerMonth < 0) throw new Error('Invalid SHS subscription');
  const rows = months.map(ledger => ({ ledger, ...monthlyBillAmounts(ledger.modeled) }));
  const sum = (get: (r: typeof rows[number]) => number) => rows.reduce((n, r) => n + get(r), 0);
  // A month still in progress is charged the same share of the subscription as it has been replayed.
  const coverage = sum(r => r.ledger.coverage);
  const withoutSek = roundedSek(sum(r => r.withoutSek)), withSek = roundedSek(sum(r => r.withSek));
  const savingSek = roundedSek(withoutSek - withSek);
  const subscriptionSek = roundedSek(subscriptionSekPerMonth * coverage), netSek = roundedSek(savingSek - subscriptionSek);
  return { rows, coverage, withoutSek, withSek, savingSek, subscriptionSek, netSek,
    monthlyNetSek: coverage > 0 ? netSek / coverage : null };
}
export type SavingsForecast = ReturnType<typeof savingsForecast>;

/** What was invoiced for those months. Original bills only; a missing one stays missing. */
export function billedRecord(months: readonly string[], bills: ReadonlyMap<string, BilledMonth>) {
  const rows = months.map(month => ({ month, billedSek: bills.get(month)?.totalSek ?? null }));
  const billed = rows.flatMap(r => r.billedSek === null ? [] : [r.billedSek]);
  return { rows, billedMonths: billed.length, billedSek: billed.length ? billed.reduce((n, v) => n + v, 0) : null };
}
export type BilledRecord = ReturnType<typeof billedRecord>;

/**
 * Does the estimate price electricity the way the invoices do? The household's
 * own metered use, priced by the model, against what was billed for it.
 *
 * Both sides leave out the demand charge, as the estimate does. A month counts
 * only when it is (almost) fully metered, fully billed by original invoices, and the grid
 * invoice itemises its demand charge wherever the tariff has one: otherwise the
 * two numbers would not describe the same charges.
 */
/** A few missing meter quarters (priced as zero) cannot move a month's comparison; more than this can. */
export const MODEL_CHECK_MAX_UNMETERED = .01;
export function modelCheck(months: readonly MonthLedger[], bills: ReadonlyMap<string, BilledMonth>, invoices: ReadonlyMap<string, EnergyBillingMonth>) {
  const rows = months.flatMap(ledger => {
    const bill = bills.get(ledger.month), invoice = invoices.get(ledger.month);
    const unmetered = (ledger.gaps.gridImportQuarters + ledger.gaps.gridExportQuarters) / ledger.quarters;
    if (ledger.coverage !== 1 || unmetered > MODEL_CHECK_MAX_UNMETERED || bill?.totalSek == null || !invoice) return [];
    if (ledger.modeled.baselineBill.gridPeakSek > 0 && !(invoice.gridPeakSek > 0)) return [];
    // Invoice lines are before VAT, which the grid invoice adds as a line of its own.
    const gridBeforeVat = (invoice.gridCostSek ?? 0) - invoice.gridVatSek;
    const gridVatRate = invoice.gridVatSek > 0 && gridBeforeVat > 0 ? invoice.gridVatSek / gridBeforeVat : 0;
    const billedSek = bill.totalSek - invoice.gridPeakSek * (1 + gridVatRate);
    const pricedSek = recordedModeledCost(ledger.recorded, ledger.modeled.baselineBill);
    return [{ month: ledger.month, pricedSek, billedSek, differenceSek: pricedSek - billedSek }];
  });
  if (!rows.length) return null;
  const pricedSek = rows.reduce((n, r) => n + r.pricedSek, 0), billedSek = rows.reduce((n, r) => n + r.billedSek, 0);
  return { rows, pricedSek, billedSek, differenceSek: pricedSek - billedSek, share: billedSek > 0 ? (pricedSek - billedSek) / billedSek : null };
}
export type ModelCheck = NonNullable<ReturnType<typeof modelCheck>>;

/** A month counts as under SHS control when this share of its planning runs had every scheduled device controlled. */
export const TRACK_RECORD_MIN_CONTROL = .9;

/**
 * What SHS actually saved, in the months it controlled the home: the cost of the
 * same month without SHS, modelled from the same measurements, against the cost
 * of what really happened. Set beside what the estimate expected for those
 * months, it shows how much of the estimate is realised in practice.
 *
 * Energy only, on the estimate's prices: fixed fees are the same either way and
 * the demand charge is left out, as in the estimate.
 */
export function trackRecord(months: readonly MonthLedger[], control: readonly ControlMonth[], devices: readonly string[]) {
  const byMonth = new Map(control.map(c => [c.month, c]));
  const controlled = (month: string) => {
    const c = byMonth.get(month);
    return !!c && c.runs > 0 && devices.length > 0 && devices.every(device => (c.controlling[device] ?? 0) / c.runs >= TRACK_RECORD_MIN_CONTROL);
  };
  const rows = months.flatMap(ledger => {
    const unmetered = (ledger.gaps.gridImportQuarters + ledger.gaps.gridExportQuarters) / ledger.quarters;
    if (ledger.coverage !== 1 || unmetered > MODEL_CHECK_MAX_UNMETERED || !controlled(ledger.month)) return [];
    return [{ month: ledger.month, measuredSek: ledger.baseline.costSek - ledger.recorded.costSek, estimatedSek: ledger.baseline.costSek - ledger.scheduler.costSek }];
  });
  if (!rows.length) return null;
  const measuredSek = rows.reduce((n, r) => n + r.measuredSek, 0), estimatedSek = rows.reduce((n, r) => n + r.estimatedSek, 0);
  return { rows, measuredSek, estimatedSek, realised: estimatedSek > 0 ? measuredSek / estimatedSek : null };
}
export type TrackRecord = NonNullable<ReturnType<typeof trackRecord>>;
