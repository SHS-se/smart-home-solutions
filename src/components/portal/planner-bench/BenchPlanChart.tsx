// One planner's plan for one test case, drawn by the portal's own plan chart,
// with the bench's quarter scores as a strip along the top.
//
// The bench stores plans as compact series (src/lib/planner-bench/referee.ts);
// this adapts them to PlanPanels' rows so a bench plan reads exactly like the
// plan a customer sees. Every quarter is on the plan side of "now". The price
// drawn is the real one; where the lane's planner had to estimate it, its
// estimate is drawn beside it. Score
// digits need a single day's width; the three-day view shows coloured cells.

import React, { useMemo } from 'react';
import PlanPanels from '@/components/portal/energy/plan/PlanPanels';
import { projectPlanChart } from '@/lib/energy-shift/plan-chart-data';
import { benchChartData } from '@/lib/planner-bench/chart-data';
import { useLanguage } from '@/contexts/LanguageContext';
import type { BenchSeries } from '@/lib/planner-bench/types';
import type { QuarterScore } from '@/lib/planner-bench/score';
import { type LaneId } from '@/lib/planner-bench/lanes';
import { periodRange, type BenchDay, type BenchPeriod } from '@/lib/planner-bench/days';

interface Props {
  series: BenchSeries;
  /** The lane the plan was made under: it decides which prices the planner was given. */
  lane: LaneId;
  timeZone: string;
  quarters: QuarterScore[] | null;
  /** Index into the whole series of the quarter to explain, or null. */
  selected: number | null;
  onSelect: (index: number) => void;
  /** The period shown; the rule list below the chart follows the same one. */
  days: BenchDay[];
  period: BenchPeriod;
  onPeriod: (period: BenchPeriod) => void;
}

const BenchPlanChart: React.FC<Props> = ({ series, lane, timeZone, quarters, selected, onSelect, days, period, onPeriod }) => {
  const { t } = useLanguage();

  const range = periodRange(days, period, series.start.length);

  const chart = useMemo(() => {
    const data = benchChartData(series, lane);
    return projectPlanChart({ ...data, range: { from: range.from, to: range.to }, timeZone, devices: series.devices });
  }, [series, lane, timeZone, range.from, range.to]);
  const { rows, consumption } = chart;

  const scores = quarters?.slice(range.from, range.to).map(q => q.score) ?? undefined;
  const selectedInView = selected !== null && selected >= range.from && selected < range.to ? selected - range.from : -1;
  const tab = (active: boolean) =>
    `px-2.5 py-1 text-xs rounded-md border ${active ? 'bg-foreground text-background border-foreground' : 'bg-card hover:bg-muted'}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Dag', 'Day')}>
        {days.map((day, index) => (
          <button key={day.label} id={`bench-day-${index}`} className={tab(period === index)} aria-pressed={period === index} onClick={() => onPeriod(index)}>
            {day.label}
          </button>
        ))}
        <button id="bench-day-all" className={tab(period === 'all')} aria-pressed={period === 'all'} onClick={() => onPeriod('all')}>
          {t('Hela 72 h', 'Full 72 h')}
        </button>
      </div>
      <PlanPanels
        rows={rows}
        series={consumption.series}
        baseValues={consumption.baseValues}
        consumptionIssues={consumption.issues}
        dividerIndex={0}
        hasBattery={series.homeSoc.some(v => v !== null)}
        hasEvBattery={series.carSoc.some(v => v !== null)}
        quarterScores={scores}
        realPrices={chart.realPrices}
        poolTargetC={series.comfort?.pool_target_c ?? null}
        selectedIndex={selectedInView}
        onQuarterClick={index => onSelect(range.from + index)}
      />
    </div>
  );
};

export default BenchPlanChart;
