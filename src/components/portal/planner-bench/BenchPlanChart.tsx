// One planner's plan for one test case, drawn by the portal's own plan chart,
// with the bench's quarter scores as the strip under it.
//
// The bench stores plans as compact series (src/lib/planner-bench/referee.ts);
// this adapts them to PlanPanels' rows so a bench plan reads exactly like the
// plan a customer sees. Every quarter is on the plan side of "now". The price
// drawn is the real one, which every planner on the bench is given. Score
// digits need a single day's width; the three-day view shows coloured cells.
//
// The last panel is the comparison the bench exists for: what both planners
// have spent by every point in the period shown. It never follows the
// toggle between the two, and it counts from the start of the period, as the
// chart's own "cost so far" does.
//
// The storage and temperature panels carry the same comparison while the
// compared plan is shown: production's battery, car and pool, dashed. Shown on
// its own the production plan has nothing to be dashed against.

import React, { useMemo } from 'react';
import PlanPanels, { type PlanCostLine, type PlanStoreLines } from '@/components/portal/energy/plan/PlanPanels';
import { projectPlanChart } from '@/lib/energy-shift/plan-chart-data';
import { benchChartData } from '@/lib/planner-bench/chart-data';
import { useLanguage } from '@/contexts/LanguageContext';
import type { BenchSeries } from '@/lib/planner-bench/types';
import type { QuarterScore } from '@/lib/planner-bench/score';
import { periodRange, type BenchDay, type BenchPeriod } from '@/lib/planner-bench/days';

const CURRENT_COLOUR = 'hsl(var(--muted-foreground))';
const TEST_COLOUR = 'var(--plan-load-2)';

interface Props {
  series: BenchSeries;
  /** Both planners' plans for the case, whichever is shown; null where a planner has none. */
  compared: { current: BenchSeries | null; test: BenchSeries | null };
  /** What each planner goes by: its branch, or its commit (PlannerBench runName). */
  names: { current: string; test: string };
  timeZone: string;
  quarters: QuarterScore[] | null;
  /** Index into the whole series of the quarter to explain, or null. */
  selected: number | null;
  onSelect: (index: number) => void;
  /** The period shown; the rule list below the chart follows the same one. */
  days: BenchDay[];
  period: BenchPeriod;
  onPeriod: (period: BenchPeriod) => void;
  /** Why the selected quarter scored what it did, under the score strip. */
  scoreDetail: React.ReactNode;
}

const BenchPlanChart: React.FC<Props> = ({ series, compared, names, timeZone, quarters, selected, onSelect, days, period, onPeriod, scoreDetail }) => {
  const { t } = useLanguage();

  const range = periodRange(days, period, series.start.length);

  const chart = useMemo(() => {
    const data = benchChartData(series);
    return projectPlanChart({ ...data, range: { from: range.from, to: range.to }, timeZone, devices: series.devices });
  }, [series, timeZone, range.from, range.to]);
  const { rows, consumption } = chart;

  const { current, test } = compared;
  const { current: currentName, test: testName } = names;
  const costLines = useMemo(() => {
    const line = (key: string, name: string, colour: string, dashed: boolean, plan: BenchSeries | null): PlanCostLine[] => {
      if (!plan) return [];
      let running = 0;
      return [{ key, name, colour, dashed, values: plan.costSek.slice(range.from, range.to).map(cost => (running += cost)) }];
    };
    return [
      ...line('current', currentName, CURRENT_COLOUR, true, current),
      ...line('test', testName, TEST_COLOUR, false, test),
    ];
  }, [current, test, range.from, range.to, currentName, testName]);

  const storeLines = useMemo((): PlanStoreLines | undefined => {
    if (!current || series === current) return undefined;
    const view = (values: readonly (number | null)[]) => values.slice(range.from, range.to);
    return { name: currentName, homeSoc: view(current.homeSoc), evSoc: view(current.carSoc), poolC: view(current.poolC) };
  }, [current, series, range.from, range.to, currentName]);

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
        scoreDetail={scoreDetail}
        realPrices={chart.realPrices}
        poolTargetC={series.comfort?.pool_target_c ?? null}
        costLines={costLines}
        storeLines={storeLines}
        selectedIndex={selectedInView}
        onQuarterClick={index => onSelect(range.from + index)}
      />
    </div>
  );
};

export default BenchPlanChart;
