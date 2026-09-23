import type { OptimisationPlan, OptimisationSnapshot } from './energy-optimisation.ts';

export interface ReplanRecommendation { key: string; reason: string; occurred_at: string }
type PriceSnapshot = { slots: Array<Pick<OptimisationSnapshot['slots'][number], 'start' | 'import_price_sek_per_kwh' | 'export_price_sek_per_kwh'>> };
type MonitoredPlan = Pick<OptimisationPlan, 'issued_at' | 'valid_until' | 'battery' | 'ev_battery'> & {
  plans: { priority: { slots: Array<Pick<OptimisationPlan['plans']['priority']['slots'][number], 'start' | 'load_w' | 'battery_soc' | 'ev_soc'>> } };
};
const QUARTER = 900_000;

/** A later published quarter is a new release. Elapsed/missing prices and
 * changed measurements never extend the accepted plan. Price corrections also
 * count as a publication, but only on overlapping published rows. */
export function hasNewPublishedPrices(before: PriceSnapshot | null, next: PriceSnapshot): boolean {
  const published = (snapshot: PriceSnapshot) => snapshot.slots.filter(s =>
    s.import_price_sek_per_kwh !== null && s.export_price_sek_per_kwh !== null);
  const rows = published(next);
  if (!rows.length) return false;
  if (!before) return true;
  const previous = published(before);
  const end = Math.max(...previous.map(s => Date.parse(s.start)));
  const byStart = new Map(previous.map(s => [s.start, s]));
  return rows.some(s => Date.parse(s.start) > end || (byStart.has(s.start) && (
    s.import_price_sek_per_kwh !== byStart.get(s.start)!.import_price_sek_per_kwh ||
    s.export_price_sek_per_kwh !== byStart.get(s.start)!.export_price_sek_per_kwh)));
}

export interface DeviationActual { start_ts: string; total_load_kwh: number | null }
export function deviationRecommendations(plan: MonitoredPlan, actuals: DeviationActual[], snapshot: OptimisationSnapshot | null, now: Date): ReplanRecommendation[] {
  const result: ReplanRecommendation[] = [];
  const add = (key: string, reason: string, at = now.toISOString()) => result.push({ key, reason, occurred_at: at });
  const slots = plan.plans.priority.slots;
  const planned = new Map(slots.map(s => [Date.parse(s.start), s]));
  // Only complete quarters entirely covered by this plan. A missing quarter
  // breaks the sequence; backfilled samples cannot bridge a gap.
  const end = Math.floor(now.getTime() / QUARTER) * QUARTER;
  const start = end - 4 * QUARTER;
  const measured = new Map(actuals.map(s => [Date.parse(s.start_ts), s.total_load_kwh]));
  const deltas: { planned: number; actual: number }[] = [];
  for (let at = start; at < end; at += QUARTER) {
    const p = planned.get(at), a = measured.get(at);
    if (at < Date.parse(plan.issued_at) || !p || typeof a !== 'number' || !Number.isFinite(a)) break;
    deltas.push({ planned: p.load_w / 4000, actual: a });
  }
  if (deltas.length === 4) {
    if (deltas.every(s => Math.abs(s.actual - s.planned) > s.planned * .5)) {
      add('household_relative', 'Household energy differed from the plan by more than 50% in each of four consecutive quarters.', new Date(end).toISOString());
    }
    if (Math.abs(deltas.reduce((sum, s) => sum + s.actual - s.planned, 0)) > 6) {
      add('household_energy', 'The rolling four-quarter household energy total differed from the plan by more than 6 kWh.', new Date(end).toISOString());
    }
  }
  if (now.getTime() >= Date.parse(plan.valid_until)) add('plan_expired', 'The plan has reached the end of its 72-hour horizon. Request a new plan.');
  if (snapshot) {
    const at = Date.parse(snapshot.captured_at);
    const index = slots.findIndex(s => Date.parse(s.start) <= at && at < Date.parse(s.start) + QUARTER);
    if (index >= 0) {
      const fraction = (at - Date.parse(slots[index].start)) / QUARTER;
      for (const key of ['battery', 'ev_battery'] as const) {
        const measuredBattery = snapshot[key], original = plan[key];
        if (!measuredBattery || !original) continue;
        const field = key === 'battery' ? 'battery_soc' : 'ev_soc';
        const endSoc = slots[index][field], startSoc = index ? slots[index - 1][field] : original.soc;
        if (typeof endSoc !== 'number' || typeof startSoc !== 'number') continue;
        const expected = startSoc + (endSoc - startSoc) * fraction;
        if (Math.abs(measuredBattery.soc - expected) * measuredBattery.capacity_kwh > 4) {
          add(`${key}_energy`, `${key === 'battery' ? 'Home battery' : 'Car battery'} stored energy differs from the plan by more than 4 kWh.`, snapshot.captured_at);
        }
      }
    }
  }
  return result;
}
