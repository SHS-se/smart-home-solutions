import type { TimelineRow } from './energy-timeline';
import type { ChartPrices } from './plan-chart-data';
/** Physical outputs needed for plotting; independent of planner, score and horizon. */
export interface ModelChartSeries {
  devices: import('./plan-chart-data').ChartDevice[];
  deviceW: Record<string, readonly number[]>;
  start: readonly string[];
  solarW: readonly number[];
  loadW: readonly number[];
  gridImportW: readonly number[];
  gridExportW: readonly number[];
  batteryChargeW: readonly number[];
  batteryDischargeW: readonly number[];
  homeSoc: readonly (number | null)[];
  carSoc: readonly (number | null)[];
  poolC: readonly (number | null)[];
  costSek: readonly number[];
  importPrice: readonly number[];
  exportPrice: readonly number[];
}

/** Stored physical outputs become timeline rows without recalculating a device. */
export function modelChartData(series: ModelChartSeries): { rows: TimelineRow[]; prices: ChartPrices } {
  if (!Array.isArray(series.devices) || !series.deviceW || series.devices.some(d => series.deviceW[d.key]?.length !== series.start.length)) {
    throw new Error('Device projections are missing from the model series.');
  }
  const fraction = (value: number | null) => value === null ? null : value / 100;
  return {
    prices: { kind: 'bench' },
    rows: series.start.map((start, i) => ({
      startMs: Date.parse(start), start, measured: false,
      solarW: series.solarW[i], loadW: series.loadW[i], baseW: null,
      gridImportW: series.gridImportW[i], gridExportW: -series.gridExportW[i],
      batteryChargeW: -series.batteryChargeW[i], batteryDischargeW: series.batteryDischargeW[i],
      batterySoc: fraction(series.homeSoc[i]), evSoc: fraction(series.carSoc[i]),
      deviceW: Object.fromEntries(series.devices.map(d => [d.key, series.deviceW[d.key][i]])),
      costSek: series.costSek[i], importPriceSekPerKwh: series.importPrice[i], exportPriceSekPerKwh: series.exportPrice[i],
      shadowImportSekPerKwh: null, shadowExportSekPerKwh: null, poolC: series.poolC[i],
    })),
  };
}
