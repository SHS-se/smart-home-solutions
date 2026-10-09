import type { TimelineRow } from '../energy-shift/energy-timeline';
import type { ChartPrices } from '../energy-shift/plan-chart-data';
import type { BenchSeries } from './types';

/** Stored physical outputs become timeline rows without recalculating a device. */
export function benchChartData(series: BenchSeries): { rows: TimelineRow[]; prices: ChartPrices } {
  if (!Array.isArray(series.devices) || !series.deviceW || series.devices.some(d => series.deviceW[d.key]?.length !== series.start.length)) {
    throw new Error('Device projections are missing; recompute this bench evaluation.');
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
