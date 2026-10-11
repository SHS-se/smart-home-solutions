import { projectBaseline, type BaselineInput, type BaselineResult } from './model.ts';
import { replayScheduler, type ReplayEngine, type SchedulerReplay } from './scheduler-replay.ts';
import { scenarioBill, type BillExtras } from './scenario-bill.ts';
import { endCredit, problemEndCredit } from '../../../supabase/functions/_shared/planner-wasm/end-credit.ts';
import type { BenchSeries } from '../planner-bench/types.ts';

export interface AssumptionEffect { key: 'battery' | 'ev' | 'pool'; value: number; baselineDeltaSek: number | null; schedulerDeltaSek: number | null; vsBaselineDeltaSek: number | null; vsActualDeltaSek: number | null; error: string | null }
export function seriesService(input: BaselineInput, series: BenchSeries) {
  const p = input.problem, last = series.start.length - 1;
  const endBatteryKwh = p.battery ? series.homeSoc[last]! / 100 * p.battery.capacity_kwh : null;
  const endEvKwh = p.car ? series.carSoc[last]! / 100 * p.car.capacity_kwh : null;
  const endPoolC = series.poolC[last];
  return { minimumPoolC: p.pool_store ? Math.min(...series.poolC.filter((v): v is number => v !== null)) : null,
    belowPoolStartHours: series.poolC.reduce<number>((n, v) => n + (v !== null && v < 30 ? .25 : 0), 0), endBatteryKwh, endEvKwh, endPoolC,
    endCreditSek: endCredit(problemEndCredit(p), p.initial, { battery_kwh: endBatteryKwh, ev_kwh: endEvKwh, pool_c: endPoolC }).credit_sek };
}
export function modeledBill(input: BaselineInput, result: Pick<BaselineResult, 'ledger' | 'series'>): BillExtras {
  if (!input.tariff) throw new Error('Monthly grid tariff definitions unavailable');
  return scenarioBill(result.ledger, input.start, input.end, input.timeZone, result.series.gridImportW, input.tariff);
}

/** Changes price placement only; fixed physical flows and hourly energy remain identical. */
export function pricingTiming(input: BaselineInput, baseline: BenchSeries, scheduler: BenchSeries) {
  const bounds = (series: BenchSeries) => {
    const groups = new Map<number, number[]>();
    series.start.forEach((at, i) => { if (!input.evidence.hourlyModel[i]) return; const hour = Math.floor(Date.parse(at) / 3_600_000); if (!groups.has(hour)) groups.set(hour, []); groups.get(hour)!.push(i); });
    let min = 0, max = 0;
    for (const indices of groups.values()) {
      const bought = indices.reduce((n, i) => n + series.gridImportW[i] / 4000, 0), sold = indices.reduce((n, i) => n + series.gridExportW[i] / 4000, 0);
      const buys = indices.map(i => series.importPrice[i]), sells = indices.map(i => series.exportPrice[i]);
      const current = indices.reduce((n, i) => n + series.costSek[i], 0);
      min += bought * Math.min(...buys) - sold * Math.max(...sells) - current;
      max += bought * Math.max(...buys) - sold * Math.min(...sells) - current;
    }
    return { min, max };
  };
  const b = bounds(baseline), s = bounds(scheduler);
  return { vsBaselineMinSek: b.min - s.max, vsBaselineMaxSek: b.max - s.min, vsActualMinSek: -s.max, vsActualMaxSek: -s.min };
}

export interface ModelComparison {
  baselineBill: BillExtras; schedulerBill: BillExtras;
  baselineService: ReturnType<typeof seriesService>; schedulerService: ReturnType<typeof seriesService>;
  effects: AssumptionEffect[]; timing: ReturnType<typeof pricingTiming>;
}
/** Paired scenarios never change the real invoice. No invented missing-volume bounds. */
export function compareModels(input: BaselineInput, engine: ReplayEngine): { result: BaselineResult; scheduler: SchedulerReplay; modeled: ModelComparison } {
  // Identical native requests recur once paired starting-state scenarios converge.
  // Reuse only byte-identical requests, within this calculation; nothing is persisted.
  const solved = new Map<string, ReturnType<ReplayEngine['solve']>>();
  const replayEngine: ReplayEngine = { project: engine.project, solve: problem => {
    const key = JSON.stringify(problem);
    let result = solved.get(key);
    if (!result) { result = engine.solve(problem); solved.set(key, result); }
    return result;
  } };
  const result = projectBaseline(input, engine, false), scheduler = replayScheduler(input, replayEngine);
  const baselineBill = modeledBill(input, result), schedulerBill = modeledBill(input, scheduler);
  const effects: AssumptionEffect[] = [];
  const variant = (key: AssumptionEffect['key'], value: number) => {
    const changed = { ...input, problem: { ...input.problem, initial: { ...input.problem.initial } } };
    if (key === 'battery') changed.problem.initial.battery_kwh = value / 100 * input.problem.battery!.capacity_kwh;
    if (key === 'ev') changed.problem.initial.ev_kwh = value / 100 * input.problem.car!.capacity_kwh;
    if (key === 'pool') changed.problem.initial.pool_c = value;
    try {
      const b = modeledBill(changed, projectBaseline(changed, engine, false)), s = modeledBill(changed, replayScheduler(changed, replayEngine));
      const baselineDeltaSek = b.totalSek - baselineBill.totalSek, schedulerDeltaSek = s.totalSek - schedulerBill.totalSek;
      effects.push({ key, value, baselineDeltaSek, schedulerDeltaSek, vsBaselineDeltaSek: baselineDeltaSek - schedulerDeltaSek, vsActualDeltaSek: -schedulerDeltaSek, error: null });
    } catch (error) { effects.push({ key, value, baselineDeltaSek: null, schedulerDeltaSek: null, vsBaselineDeltaSek: null, vsActualDeltaSek: null, error: error instanceof Error ? error.message : String(error) }); }
  };
  if (input.batteryInitialAssumed) variant('battery', input.problem.battery!.max_soc * 100);
  if (input.evInitialAssumed) variant('ev', 20);
  if (input.poolInitialAssumed) { variant('pool', 28); variant('pool', 30.5); }
  return { result, scheduler, modeled: { baselineBill, schedulerBill, baselineService: seriesService(input, result.series), schedulerService: seriesService(input, scheduler.series), effects,
    timing: pricingTiming(input, result.series, scheduler.series) } };
}
