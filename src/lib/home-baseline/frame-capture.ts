import type { ComparisonCapture } from './browser.ts';
import type { BaselinePeriod } from './period.ts';
import type { BenchSeries } from '../planner-bench/types.ts';
import { addElectricity, emptyElectricityLedger } from './ledger.ts';
import { modeledBill, seriesService } from './model-comparison.ts';
import { withPoolState } from './pool-carry.ts';
import { currentGridPrices } from '../../../supabase/functions/_shared/energy-grid-pricing.ts';

/** Frames are views of the monthly trajectories, including the same thermal history. */
export function frameCapture(captures: readonly ComparisonCapture[], period: BaselinePeriod): ComparisonCapture {
  const parts = captures.map(capture => ({ capture, from: Math.max(0, (Date.parse(period.start) - Date.parse(capture.input.start)) / 900_000),
    to: Math.min(capture.result.series.start.length, (Date.parse(period.end) - Date.parse(capture.input.start)) / 900_000) }));
  const first = parts[0];
  if (!first || parts.some(p => !Number.isInteger(p.from) || !Number.isInteger(p.to) || p.from >= p.to)) throw new Error('Invalid monthly frame coverage');
  const project = (actor: 'result' | 'scheduler') => {
    const gather = <T>(pick: (series: BenchSeries) => readonly T[] | undefined): T[] => parts.flatMap(p => pick(p.capture[actor].series)?.slice(p.from, p.to) ?? []);
    const initial = first.capture[actor].series;
    const series: BenchSeries = { devices: initial.devices, deviceW: Object.fromEntries(initial.devices.map(device => [device.key, gather(s => s.deviceW[device.key])])),
      start: gather(s => s.start), hours: gather(s => s.hours), published: gather(s => s.published), importPrice: gather(s => s.importPrice), exportPrice: gather(s => s.exportPrice),
      solarW: gather(s => s.solarW), loadW: gather(s => s.loadW), poolW: gather(s => s.poolW), poolStart: gather(s => s.poolStart), hotWaterW: gather(s => s.hotWaterW), carW: gather(s => s.carW),
      gridImportW: gather(s => s.gridImportW), gridExportW: gather(s => s.gridExportW), batteryChargeW: gather(s => s.batteryChargeW), batteryDischargeW: gather(s => s.batteryDischargeW),
      homeStartSoc: first.from ? initial.homeSoc[first.from - 1] : initial.homeStartSoc, homeSoc: gather(s => s.homeSoc), carSoc: gather(s => s.carSoc), carKm: gather(s => s.carKm),
      carConnected: gather(s => s.carConnected), poolC: gather(s => s.poolC), poolPendingHeatKwh: gather(s => s.poolPendingHeatKwh), costSek: gather(s => s.costSek), wearSek: gather(s => s.wearSek) };
    const ledger = emptyElectricityLedger();
    series.start.forEach((_, i) => addElectricity(ledger, series.gridImportW[i] / 4000, series.gridExportW[i] / 4000, series.importPrice[i], series.exportPrice[i]));
    return { series, ledger, commands: parts.flatMap(p => p.capture[actor].commands.slice(p.from, p.to)), poolStates: parts.flatMap(p => p.capture[actor].poolStates.slice(p.from, p.to)) };
  };
  const baseline = project('result'), scheduler = project('scheduler');
  const slots = parts.flatMap(p => p.capture.input.problem.slots.slice(p.from, p.to)).map((slot, i) => ({ ...slot, start_seconds: i * 900 }));
  if (slots.length * 900_000 !== Date.parse(period.end) - Date.parse(period.start)) throw new Error('Missing monthly frame coverage');
  const rows = parts.flatMap(p => p.capture.input.recorded.rows.slice(p.from, p.to)), recordedLedger = emptyElectricityLedger();
  rows.forEach((row, i) => addElectricity(recordedLedger, (row.gridImportW ?? 0) / 4000, Math.abs(row.gridExportW ?? 0) / 4000, slots[i].import_price, slots[i].export_price));
  const priorPool = (actor: 'result' | 'scheduler', name: 'baseline' | 'scheduler') => first.from
    ? first.capture[actor].poolStates[first.from - 1]! : first.capture.input.pool!.initial[name];
  const pool = { parentHash: first.capture.input.pool!.parentHash, initial: { baseline: priorPool('result', 'baseline'), scheduler: priorPool('scheduler', 'scheduler') } };
  const p = first.capture.input.problem;
  const gridImportCostSek = rows.reduce((sum, row) => {
    const price = currentGridPrices(first.capture.input.tariff!, new Date(row.start));
    if (!price) throw new Error(`Missing grid tariff at ${row.start}`);
    return sum + (row.gridImportW ?? 0) / 4000 * price.import_price_sek_per_kwh;
  }, 0);
  const input = { ...first.capture.input, start: period.start, end: period.end, pool,
    initialObservedAt: new Date(Date.parse(period.start) - 900_000).toISOString(),
    problem: withPoolState({ ...p, slots, initial: { ...p.initial,
      battery_kwh: p.battery ? baseline.series.homeStartSoc! / 100 * p.battery.capacity_kwh : null,
      ev_kwh: p.car && first.from ? first.capture.result.series.carSoc[first.from - 1]! / 100 * p.car.capacity_kwh : p.initial.ev_kwh } }, pool.initial.baseline),
    evDemandKwh: parts.flatMap(part => part.capture.input.evDemandKwh.slice(part.from, part.to)),
    recorded: { ...first.capture.input.recorded, rows, ledger: recordedLedger,
      gridImportCostSek } };
  const result = { ...first.capture.result, ...baseline };
  const replay = { ...first.capture.scheduler, ...scheduler };
  return { input, result, scheduler: replay, engineHash: first.capture.engineHash, modeled: {
    baselineBill: modeledBill(input, result), schedulerBill: modeledBill(input, replay), baselineService: seriesService(input, result.series), schedulerService: seriesService(input, replay.series, 'scheduler') } };
}
