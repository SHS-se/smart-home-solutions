import { projectBaseline, type BaselineInput, type BaselineResult } from './model.ts';
import { replayScheduler, type ReplayEngine, type SchedulerReplay } from './scheduler-replay.ts';
import { scenarioBill, type BillExtras } from './scenario-bill.ts';
import { POOL_THERMOSTAT_BAND_C } from './controller.ts';
import { endCredit, problemEndCredit } from '../../../supabase/functions/_shared/planner-wasm/end-credit.ts';
import { CAR_FLOOR_SOC_DEFAULT, carPolicy, floorBreaches } from '../../../supabase/functions/_shared/planner-wasm/car-policy.ts';
import type { UnservedTrips } from './trip-ledger.ts';
import { poolInventoryC } from '../../../supabase/functions/_shared/planner/device-models.ts';
import { simulationProblem } from './simulation-state.ts';
import type { BenchSeries } from '../planner-bench/types.ts';

export function seriesService(input: BaselineInput, series: BenchSeries, actor: 'baseline' | 'scheduler' = 'baseline', unserved?: Pick<UnservedTrips, 'trips' | 'kwh'>) {
  const p = simulationProblem(input, actor), last = series.start.length - 1;
  const endBatteryKwh = p.battery ? series.homeSoc[last]! / 100 * p.battery.capacity_kwh : null;
  const endEvKwh = p.car ? series.carSoc[last]! / 100 * p.car.capacity_kwh : null;
  const endPoolC = series.poolC[last];
  // Both actors' energy is valued at one neutral price, the period's median, so
  // that neither policy grades its own homework with its own tiers.
  const terms = problemEndCredit(p);
  const neutral = { ...terms, ev: terms.ev && { ...terms.ev, tiers: [{ up_to: terms.ev.tiers.at(-1)!.up_to, sek_per_kwh: terms.reference_sek_per_kwh }] } };
  const lines = p.car && p.car_policy ? carPolicy({ battery: p.car, limitSoc: p.car_policy.limit_kwh / p.car.capacity_kwh,
    floorSetting: input.settings.comfort?.ev?.floor_soc ?? CAR_FLOOR_SOC_DEFAULT, connection: { kind: 'plugged_unknown_since' } }, p.slots, Date.parse(input.start)) : null;
  const floorHours = lines ? floorBreaches(lines, p.car!.capacity_kwh, series.carSoc.map(soc => soc! / 100 * p.car!.capacity_kwh)).filter(Boolean).length * .25 : 0;
  // The temperature at which the plain thermostat would have started heating.
  const poolStartC = p.pool_store ? p.targets.pool_c! - POOL_THERMOSTAT_BAND_C : null;
  return { minimumPoolC: p.pool_store ? Math.min(...series.poolC.filter((v): v is number => v !== null)) : null,
    belowPoolStartHours: series.poolC.reduce<number>((n, v) => n + (v !== null && poolStartC !== null && v < poolStartC ? .25 : 0), 0), endBatteryKwh, endEvKwh, endPoolC,
    floorHours, unservedTrips: unserved?.trips ?? 0, unservedKwh: unserved?.kwh ?? 0,
    endCreditSek: endCredit(neutral, { ...p.initial, pool_c: p.pool_store ? poolInventoryC(p.pool_store, p.initial.pool_c!, p.initial.pool_pending_heat_kwh!) : null },
      { battery_kwh: endBatteryKwh, ev_kwh: endEvKwh, pool_c: p.pool_store ? poolInventoryC(p.pool_store, endPoolC!, series.poolPendingHeatKwh[last]!) : null }).credit_sek };
}
export function modeledBill(input: BaselineInput, result: Pick<BaselineResult, 'ledger' | 'series'>): BillExtras {
  if (!input.tariff) throw new Error('Monthly grid tariff definitions unavailable');
  return scenarioBill(result.ledger, input.start, input.end, input.timeZone, result.series.gridImportW, input.tariff);
}

export interface ModelComparison {
  baselineBill: BillExtras; schedulerBill: BillExtras;
  baselineService: ReturnType<typeof seriesService>; schedulerService: ReturnType<typeof seriesService>;
}
/** Both models consume the same physical inputs; Actual remains invoice evidence. */
export function compareModels(input: BaselineInput, engine: ReplayEngine): { result: BaselineResult; scheduler: SchedulerReplay; modeled: ModelComparison } {
  const result = projectBaseline(input, engine, false), scheduler = replayScheduler(input, engine);
  return { result, scheduler, modeled: { baselineBill: modeledBill(input, result), schedulerBill: modeledBill(input, scheduler),
    baselineService: seriesService(input, result.series, 'baseline', result.unserved), schedulerService: seriesService(input, scheduler.series, 'scheduler', scheduler.unserved) } };
}
