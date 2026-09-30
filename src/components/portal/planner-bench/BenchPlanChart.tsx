// One planner's plan for one test case, drawn by the portal's own plan chart.
//
// The bench stores plans as compact series (src/lib/planner-bench/series.ts);
// this adapts them to PlanPanels' rows so a bench plan reads exactly like the
// plan a customer sees. Every quarter is on the plan side of "now".

import React, { useMemo } from 'react';
import PlanPanels, { type PlanPanelRow } from '@/components/portal/energy/plan/PlanPanels';
import type { ConsumptionSeries } from '@/lib/energy-shift/consumption-series';
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import { useLanguage } from '@/contexts/LanguageContext';
import type { BenchSeries } from '@/lib/planner-bench/types';

/** Palette slots matching the portal's usual colours for these meters. */
const SLOTS = { pool: 2, hotWater: 1, car: 8 } as const;

const BenchPlanChart: React.FC<{ series: BenchSeries; timeZone: string }> = ({ series, timeZone }) => {
  const { t } = useLanguage();
  const n = series.start.length;

  const rows = useMemo<PlanPanelRow[]>(() => {
    let running = 0;
    return series.start.map((start, i) => {
      running += series.costSek[i];
      return {
        startMs: Date.parse(start),
        label: formatHomeDayMonthTime(start, timeZone),
        measured: false,
        solarW: series.solarW[i],
        loadW: series.loadW[i],
        gridImportW: series.gridImportW[i],
        gridExportW: series.gridExportW[i],
        batteryChargeW: series.batteryChargeW[i],
        batteryDischargeW: series.batteryDischargeW[i],
        homeSoc: series.homeSoc[i],
        evSoc: series.carSoc[i],
        importPriceSekPerKwh: series.importPrice[i],
        exportPriceSekPerKwh: series.exportPrice[i],
        importPriceQuoted: series.published[i] === 1,
        cumulativeCostSek: running,
      };
    });
  }, [series, timeZone]);

  const consumption = useMemo(() => {
    const band = (key: keyof typeof SLOTS, name: string, values: number[]): ConsumptionSeries => ({
      key, name, values, slot: SLOTS[key], partial: values.map(() => false),
      kwh: values.reduce((sum, w, i) => sum + w * series.hours[i] / 1000, 0),
    });
    const bands = [
      band('pool', t('Pool', 'Pool'), series.poolW),
      band('hotWater', t('Varmvatten', 'Hot water'), series.hotWaterW),
      band('car', t('Bil', 'Car'), series.carW),
    ].filter(b => b.kwh > 0.01).sort((a, b) => b.kwh - a.kwh);
    const baseValues = series.loadW.map((load, i) =>
      Math.max(0, load - series.poolW[i] - series.hotWaterW[i] - series.carW[i]));
    return { bands, baseValues };
  }, [series, t]);

  return (
    <PlanPanels
      rows={rows}
      series={consumption.bands}
      baseValues={consumption.baseValues}
      consumptionIssues={Array.from({ length: n }, () => null)}
      dividerIndex={0}
      hasBattery={series.homeSoc.some(v => v !== null)}
      hasEvBattery={series.carSoc.some(v => v !== null)}
    />
  );
};

export default BenchPlanChart;
