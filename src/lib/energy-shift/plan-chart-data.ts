// One interpretation of model-produced physical trajectories for both plan charts.
// This module converts display units and splits electrical meters; it contains no device physics.
import { activeDeviceKeys, type TimelineRow, type TimelineRange } from './energy-timeline';
import { splitConsumption } from './consumption-series';
import { formatHomeDayMonthTime } from './home-time';

export interface PlanPanelRow {
  startMs: number;
  /** Axis label for this quarter, already localised. */
  label: string;
  measured: boolean;
  missing?: boolean;
  /**
   * Power, in watts. Signs are ignored: import and export are separate fields,
   * as are charge and discharge, so which way the energy went is already
   * carried by which field it is in (see power-flows.ts).
   */
  solarW: number | null;
  loadW: number | null;
  gridImportW: number | null;
  gridExportW: number | null;
  batteryChargeW: number | null;
  batteryDischargeW: number | null;
  /** Percentages, not fractions. */
  homeSoc: number | null;
  evSoc: number | null;
  importPriceSekPerKwh: number | null;
  exportPriceSekPerKwh: number | null;
  /**
   * Whether the market actually quoted this quarter, or the planner's shape
   * estimator supplied the number. Day-ahead covers one day of a three-day
   * horizon, so this is false for most of a plan.
   */
  importPriceQuoted: boolean;
  /**
   * Where the row's price is the real one and the planner planned with
   * another: what it expected instead. Only the planner bench sets it.
   */
  plannerImportPriceSekPerKwh?: number | null;
  /** Running net cost from the start of the window. */
  cumulativeCostSek: number;
  /** Pool water, °C: measured on the past side, the plan's projection on the future side. */
  poolTemperatureC?: number | null;
}

export interface ChartDevice { key: string; name: string; schedulable: boolean }
export type ChartPrices = { kind: 'live' } | {
  kind: 'bench'; known: readonly boolean[]; believed: readonly (number | null)[];
};
const quoted = (value: number | null) => value !== null && Number.isFinite(value);
const priced = (value: number | null, shadow: number | null) => quoted(value) ? value
  : shadow !== null && Number.isFinite(shadow) ? shadow : null;

export function projectPlanChart(input: {
  rows: readonly TimelineRow[]; range: TimelineRange; timeZone: string;
  devices: readonly ChartDevice[]; prices: ChartPrices;
}) {
  const { rows, range, timeZone, devices, prices } = input;
  if (prices.kind === 'bench' && (prices.known.length !== rows.length || prices.believed.length !== rows.length)) {
    throw new Error('Bench price evidence must align with its physical trajectory.');
  }
  const view = rows.slice(range.from, range.to);
  let running = 0;
  const panelRows: PlanPanelRow[] = view.map((row, i) => {
    running += row.costSek ?? 0;
    const index = range.from + i;
    return {
      startMs: row.startMs, label: formatHomeDayMonthTime(row.start, timeZone),
      measured: row.measured, missing: row.missing,
      solarW: row.solarW, loadW: row.loadW, gridImportW: row.gridImportW, gridExportW: row.gridExportW,
      batteryChargeW: row.batteryChargeW, batteryDischargeW: row.batteryDischargeW,
      homeSoc: row.batterySoc === null ? null : row.batterySoc * 100,
      evSoc: row.evSoc === null ? null : row.evSoc * 100,
      importPriceSekPerKwh: prices.kind === 'bench' ? row.importPriceSekPerKwh : priced(row.importPriceSekPerKwh, row.shadowImportSekPerKwh),
      exportPriceSekPerKwh: prices.kind === 'bench' ? row.exportPriceSekPerKwh : priced(row.exportPriceSekPerKwh, row.shadowExportSekPerKwh),
      importPriceQuoted: prices.kind === 'bench' ? prices.known[index] : quoted(row.importPriceSekPerKwh),
      ...(prices.kind === 'bench' ? { plannerImportPriceSekPerKwh: prices.known[index] ? null : prices.believed[index] } : {}),
      cumulativeCostSek: running, poolTemperatureC: row.poolC ?? null,
    };
  });
  const catalogue = new Map(devices.map(d => [d.key, d]));
  const active = new Set([...activeDeviceKeys(rows, range), ...devices.filter(d => d.schedulable).map(d => d.key)]);
  const consumption = splitConsumption([...active].map(key => ({
    key, name: catalogue.get(key)?.name ?? key,
    values: view.map(row => row.deviceW[key] ?? NaN), schedulable: catalogue.get(key)?.schedulable ?? false,
  })), view.map(row => row.loadW));
  return { rows: panelRows, consumption, realPrices: prices.kind === 'bench' };
}
