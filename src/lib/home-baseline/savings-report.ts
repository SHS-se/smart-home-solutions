import type { MonthLedger } from './savings';
import type { BilledMonth } from './billed-months';
import { modeledCosts } from './roi-pricing';

/** The same months with and without the scheduler, on today's equipment.
 * Demand-free modeled costs only: an invoice never enters the estimate. */
export function savingsForecast(months: readonly MonthLedger[], subscriptionSekPerMonth: number) {
  if (!Number.isFinite(subscriptionSekPerMonth) || subscriptionSekPerMonth < 0) throw new Error('Invalid SHS subscription');
  const rows = months.map(ledger => {
    const costs = modeledCosts(ledger.modeled);
    return { ledger, withoutSek: costs.baseline.totalSek, withSek: costs.scheduler.totalSek, savingSek: costs.savingSek };
  });
  const sum = (get: (r: typeof rows[number]) => number) => rows.reduce((n, r) => n + get(r), 0);
  // A month still in progress is charged the same share of the subscription as it has been replayed.
  const coverage = sum(r => r.ledger.coverage), savingSek = sum(r => r.savingSek);
  const subscriptionSek = subscriptionSekPerMonth * coverage, netSek = savingSek - subscriptionSek;
  return { rows, coverage, withoutSek: sum(r => r.withoutSek), withSek: sum(r => r.withSek), savingSek, subscriptionSek, netSek,
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
