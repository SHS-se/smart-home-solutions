// One planner's plan for one test case, drawn by the portal's own plan chart,
// with the bench's quarter scores as a strip along the top.
//
// The bench stores plans as compact series (src/lib/planner-bench/referee.ts);
// this adapts them to PlanPanels' rows so a bench plan reads exactly like the
// plan a customer sees. Every quarter is on the plan side of "now". Score
// digits need a single day's width; the three-day view shows coloured cells.

import React, { useEffect, useMemo, useState } from 'react';
import PlanPanels, { type PlanPanelRow } from '@/components/portal/energy/plan/PlanPanels';
import type { ConsumptionSeries } from '@/lib/energy-shift/consumption-series';
import { formatHomeDayMonth, formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import { useLanguage } from '@/contexts/LanguageContext';
import type { BenchSeries } from '@/lib/planner-bench/types';
import type { QuarterScore } from '@/lib/planner-bench/score';

/** Palette slots matching the portal's usual colours for these meters. */
const SLOTS = { pool: 2, hotWater: 1, car: 8 } as const;

interface Props {
  series: BenchSeries;
  timeZone: string;
  quarters: QuarterScore[] | null;
  /** Index into the whole series of the quarter to explain, or null. */
  selected: number | null;
  onSelect: (index: number) => void;
}

const BenchPlanChart: React.FC<Props> = ({ series, timeZone, quarters, selected, onSelect }) => {
  const { t } = useLanguage();

  /** Local calendar days the plan touches, as [from, to) quarter ranges. */
  const days = useMemo(() => {
    const out: { label: string; from: number; to: number }[] = [];
    series.start.forEach((start, i) => {
      const label = formatHomeDayMonth(start, timeZone);
      if (out.length && out[out.length - 1].label === label) out[out.length - 1].to = i + 1;
      else out.push({ label, from: i, to: i + 1 });
    });
    return out;
  }, [series, timeZone]);
  // Default to the first whole day, where the published prices are.
  const [window, setWindow] = useState<number | 'all'>(() => (days.length > 1 && days[0].to - days[0].from < 48 ? 1 : 0));
  useEffect(() => {
    if (selected === null) return;
    const day = days.findIndex(d => selected >= d.from && selected < d.to);
    if (day >= 0) setWindow(previous => previous === 'all' ? previous : day);
  }, [selected, days]);
  const range = window === 'all' ? { from: 0, to: series.start.length } : days[Math.min(window, days.length - 1)];

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
    }).slice(range.from, range.to);
  }, [series, timeZone, range.from, range.to]);

  const consumption = useMemo(() => {
    const cut = (values: number[]) => values.slice(range.from, range.to);
    const hours = cut(series.hours);
    const band = (key: keyof typeof SLOTS, name: string, all: number[]): ConsumptionSeries => {
      const values = cut(all);
      return {
        key, name, values, slot: SLOTS[key], partial: values.map(() => false),
        kwh: values.reduce((sum, w, i) => sum + w * hours[i] / 1000, 0),
      };
    };
    const bands = [
      band('pool', t('Pool', 'Pool'), series.poolW),
      band('hotWater', t('Varmvatten', 'Hot water'), series.hotWaterW),
      band('car', t('Bil', 'Car'), series.carW),
    ].filter(b => b.kwh > 0.01).sort((a, b) => b.kwh - a.kwh);
    const baseValues = cut(series.loadW).map((load, i) =>
      Math.max(0, load - series.poolW[range.from + i] - series.hotWaterW[range.from + i] - series.carW[range.from + i]));
    return { bands, baseValues };
  }, [series, t, range.from, range.to]);

  const scores = quarters?.slice(range.from, range.to).map(q => q.score) ?? undefined;
  const selectedInView = selected !== null && selected >= range.from && selected < range.to ? selected - range.from : -1;
  const tab = (active: boolean) =>
    `px-2.5 py-1 text-xs rounded-md border ${active ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Dag', 'Day')}>
        {days.map((day, index) => (
          <button key={day.label} id={`bench-day-${index}`} className={tab(window === index)} aria-pressed={window === index} onClick={() => setWindow(index)}>
            {day.label}
          </button>
        ))}
        <button id="bench-day-all" className={tab(window === 'all')} aria-pressed={window === 'all'} onClick={() => setWindow('all')}>
          {t('Alla', 'All')}
        </button>
      </div>
      <PlanPanels
        rows={rows}
        series={consumption.bands}
        baseValues={consumption.baseValues}
        consumptionIssues={rows.map(() => null)}
        dividerIndex={0}
        hasBattery={series.homeSoc.some(v => v !== null)}
        hasEvBattery={series.carSoc.some(v => v !== null)}
        quarterScores={scores}
        selectedIndex={selectedInView}
        onQuarterClick={index => onSelect(range.from + index)}
      />
    </div>
  );
};

export default BenchPlanChart;
