import { projectBaseline, type BaselineInput, type BaselineResult } from './model.ts';
import { replayScheduler, type ReplayEngine, type SchedulerReplay } from './scheduler-replay.ts';
import { scenarioBill, type BillExtras } from './scenario-bill.ts';
import { POOL_THERMOSTAT_BAND_C } from './controller.ts';
import { endCredit, problemEndCredit } from '../../../supabase/functions/_shared/planner-wasm/end-credit.ts';
import { poolInventoryC } from '../../../supabase/functions/_shared/planner/device-models.ts';
import { simulationProblem } from './simulation-state.ts';
import type { BenchSeries } from '../planner-bench/types.ts';

export function seriesService(input: BaselineInput, series: BenchSeries, actor: 'baseline' | 'scheduler' = 'baseline') {
  const p = simulationProblem(input, actor), last = series.start.length - 1;
  const endBatteryKwh = p.battery ? series.homeSoc[last]! / 100 * p.battery.capacity_kwh : null;
  const endEvKwh = p.car ? series.carSoc[last]! / 100 * p.car.capacity_kwh : null;
  const endPoolC = series.poolC[last];
  // The temperature at which the plain thermostat would have started heating.
  const poolStartC = p.pool_store ? p.targets.pool_c! - POOL_THERMOSTAT_BAND_C : null;
  return { minimumPoolC: p.pool_store ? Math.min(...series.poolC.filter((v): v is number => v !== null)) : null,
    belowPoolStartHours: series.poolC.reduce<number>((n, v) => n + (v !== null && poolStartC !== null && v < poolStartC ? .25 : 0), 0), endBatteryKwh, endEvKwh, endPoolC,
    endCreditSek: endCredit(problemEndCredit(p), { ...p.initial, pool_c: p.pool_store ? poolInventoryC(p.pool_store, p.initial.pool_c!, p.initial.pool_pending_heat_kwh!) : null },
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
    baselineService: seriesService(input, result.series), schedulerService: seriesService(input, scheduler.series, 'scheduler') } };
}
