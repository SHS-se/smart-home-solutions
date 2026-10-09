// One price estimate drawn against the prices the market then published.
//
// The first day is the day the estimate was made, whose prices were already
// known; the days after it are the ones it estimated. Everything the table
// under the chart lists is on the chart:
//   solid line      the real price, once published;
//   dashed line     the estimate;
//   shaded gap      how far each quarter-hour was off (quarter error);
//   level marks     each day's mean, estimated and real, and the gap between
//                   them (level error).
// Series differ by line style as well as colour. The table carries the same
// figures for anyone who cannot read the chart.

import React, { useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { linearScale, niceTicks, stepBandPath, stepLinePath } from '@/lib/energy-shift/plan-chart-geometry';
import { DAY_QUARTERS, type ChartDay } from '@/lib/planner-bench/price-estimates';

const VIEW_W = 1000;
const VIEW_H = 340;
const LEFT = 46;
const RIGHT = VIEW_W - 14;
const TOP = 58;
const BOTTOM = VIEW_H - 30;
const AXIS_TEXT = 'fill-muted-foreground text-[10px] font-mono';
export const ESTIMATE_COLOUR = 'var(--plan-solar)';
export const REAL_COLOUR = 'hsl(var(--foreground))';

/** Two decimals; a value that rounds to nothing is 0.00, never −0.00. */
export const kr = (value: number, signed = false) => {
  const shown = Math.abs(value) < 0.005 ? 0 : value;
  return `${signed && shown > 0 ? '+' : ''}${shown.toFixed(2)}`;
};
const clock = (quarter: number) => `${String(Math.floor(quarter / 4)).padStart(2, '0')}:${String((quarter % 4) * 15).padStart(2, '0')}`;

interface Props {
  days: ChartDay[];
  dayLabel: (day: string) => string;
  /** The day to emphasise, shared with the table. */
  focusDay: string | null;
  onFocusDay: (day: string | null) => void;
}

const PriceEstimateChart: React.FC<Props> = ({ days, dayLabel, focusDay, onFocusDay }) => {
  const { t } = useLanguage();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ left: number; top: number } | null>(null);
  const n = days.length * DAY_QUARTERS;

  const geometry = useMemo(() => {
    const actual = days.flatMap(day => day.actual);
    const estimate = days.flatMap(day => day.estimated?.estimate ?? new Array<number | null>(DAY_QUARTERS).fill(null));
    const values = [...actual, ...estimate].filter((value): value is number => value !== null);
    const max = Math.max(0.5, ...values) * 1.1, min = Math.min(0, ...values) * 1.1;
    const x = linearScale([0, Math.max(1, n)], [LEFT, RIGHT]);
    const y = linearScale([min, max], [BOTTOM, TOP]);
    const gap = actual.map((value, i) => value === null || estimate[i] === null
      ? [NaN, NaN] as const : [Math.min(value, estimate[i]!), Math.max(value, estimate[i]!)] as const);
    return { actual, estimate, x, y, ticks: niceTicks(min, max, 4), gap };
  }, [days, n]);
  const { actual, estimate, x, y, ticks, gap } = geometry;

  const quarterAt = (clientX: number): number | null => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    const index = Math.floor((((clientX - box.left) * (VIEW_W / box.width) - LEFT) / (RIGHT - LEFT)) * n);
    return index < 0 || index >= n ? null : index;
  };
  const show = (index: number | null, at?: { left: number; top: number }) => {
    setHover(index);
    setPointer(index === null ? null : at ?? null);
    onFocusDay(index === null ? null : days[Math.floor(index / DAY_QUARTERS)].day);
  };
  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const index = quarterAt(event.clientX);
    show(index, wrap ? { left: event.clientX - wrap.left, top: event.clientY - wrap.top } : undefined);
  };
  const handleKey = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = Math.max(0, Math.min(n - 1, (hover ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1)));
    const box = svgRef.current?.getBoundingClientRect();
    show(next, box ? { left: (x(next + 0.5) / VIEW_W) * box.width, top: (TOP / VIEW_H) * box.height } : undefined);
  };

  const hovered = hover === null ? null : {
    day: days[Math.floor(hover / DAY_QUARTERS)], quarter: hover % DAY_QUARTERS, actual: actual[hover], estimate: estimate[hover],
  };

  return (
    <div ref={wrapRef} className="relative overflow-x-auto">
      <svg
        ref={svgRef} id="price-estimate-chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full min-w-[680px] select-none"
        role="img" tabIndex={0}
        aria-label={t(
          'Uppskattat pris mot verkligt pris per kvart. Tabellen under diagrammet har samma siffror. Piltangenterna flyttar markören.',
          'Estimated price against real price per quarter-hour. The table under the chart has the same figures. Arrow keys move the cursor.')}
        onPointerMove={handleMove} onPointerDown={handleMove} onPointerLeave={() => show(null)}
        onKeyDown={handleKey} onBlur={() => show(null)}
      >
        {days.map((day, d) => {
          const from = x(d * DAY_QUARTERS), to = x((d + 1) * DAY_QUARTERS), known = !day.estimated;
          return (
            <g key={day.day} data-day={day.day}>
              <rect x={from} y={TOP} width={to - from} height={BOTTOM - TOP}
                className={known ? 'fill-muted' : 'fill-transparent'} fillOpacity={known ? 0.6 : 0} />
              {focusDay === day.day && (
                <rect x={from} y={TOP} width={to - from} height={BOTTOM - TOP} fill={ESTIMATE_COLOUR} fillOpacity={0.06} />
              )}
              {d > 0 && <line x1={from} x2={from} y1={TOP - 44} y2={BOTTOM} className="stroke-border" strokeWidth={1} />}
              <text x={from + 6} y={TOP - 32} className="fill-foreground text-[11px] font-medium">{dayLabel(day.day)}</text>
              <text x={from + 6} y={TOP - 18} className={AXIS_TEXT}>
                {known
                  ? d === 0 ? t('dagen uppskattningen gjordes', 'the day the estimate was made') : t('redan publicerad då', 'already published by then')
                  : day.estimated!.leadDays === 0 ? t('samma dag', 'same day')
                    : day.estimated!.leadDays === 1 ? t('1 dag fram', '1 day ahead') : t(`${day.estimated!.leadDays} dagar fram`, `${day.estimated!.leadDays} days ahead`)}
              </text>
              <text x={from + 6} y={TOP - 6} className={AXIS_TEXT}>
                {known
                  ? d === 0 ? t('priserna redan publicerade', 'prices already published') : ''
                  : day.estimated!.was === null
                    ? t(`trodde ${kr(day.estimated!.believed)} · inte publicerat än`, `believed ${kr(day.estimated!.believed)} · not published yet`)
                    : t(`trodde ${kr(day.estimated!.believed)} · blev ${kr(day.estimated!.was)}`, `believed ${kr(day.estimated!.believed)} · was ${kr(day.estimated!.was)}`)}
              </text>
              {[0, 24, 48, 72].map(q => (
                <text key={q} x={x(d * DAY_QUARTERS + q) + (q === 0 ? 2 : 0)} y={BOTTOM + 14} textAnchor={q === 0 ? 'start' : 'middle'} className={AXIS_TEXT}>
                  {clock(q)}
                </text>
              ))}
            </g>
          );
        })}

        {ticks.map(tick => (
          <g key={tick}>
            <line x1={LEFT} x2={RIGHT} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'stroke-foreground' : 'stroke-border'} strokeWidth={1} />
            <text x={LEFT - 6} y={y(tick) + 3} textAnchor="end" className={AXIS_TEXT}>{tick.toFixed(1)}</text>
          </g>
        ))}
        <text x={LEFT - 40} y={TOP - 6} className={AXIS_TEXT}>kr/kWh</text>

        <path id="price-estimate-gap" d={stepBandPath(gap, x, y)} fill={ESTIMATE_COLOUR} fillOpacity={0.22} />
        <path id="price-estimate-real" d={stepLinePath(actual, x, y)} fill="none" stroke={REAL_COLOUR} strokeWidth={2.25} strokeLinejoin="round" />
        <path id="price-estimate-line" d={stepLinePath(estimate, x, y)} fill="none" stroke={ESTIMATE_COLOUR} strokeWidth={2.25}
          strokeLinejoin="round" strokeDasharray="6 4" />

        {/* Each estimated day's level: the mean the planner believed and the mean it turned out to be. */}
        {days.map((day, d) => {
          const e = day.estimated;
          if (!e) return null;
          const covered = e.estimate.flatMap((value, i) => value === null ? [] : [i]);
          const from = x(d * DAY_QUARTERS + covered[0]), to = x(d * DAY_QUARTERS + covered[covered.length - 1] + 1);
          const at = to - 12;
          return (
            <g key={day.day} data-level={day.day}>
              <line x1={from} x2={to} y1={y(e.believed)} y2={y(e.believed)} stroke={ESTIMATE_COLOUR} strokeWidth={1} strokeDasharray="2 3" />
              {e.was !== null && e.levelError !== null && (
                <>
                  <line x1={from} x2={to} y1={y(e.was)} y2={y(e.was)} stroke={REAL_COLOUR} strokeWidth={1} strokeOpacity={0.55} />
                  <line x1={at} x2={at} y1={y(e.believed)} y2={y(e.was)} className="stroke-foreground" strokeWidth={1.5} />
                  <line x1={at - 4} x2={at + 4} y1={y(e.believed)} y2={y(e.believed)} className="stroke-foreground" strokeWidth={1.5} />
                  <line x1={at - 4} x2={at + 4} y1={y(e.was)} y2={y(e.was)} className="stroke-foreground" strokeWidth={1.5} />
                  <text x={at - 8} y={(y(e.believed) + y(e.was)) / 2 + 3} textAnchor="end"
                    className="fill-foreground text-[10px] font-mono font-semibold" paintOrder="stroke" stroke="hsl(var(--card))" strokeWidth={3}>
                    {t('nivåfel', 'level error')} {kr(e.levelError, true)}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {hover !== null && (
          <line x1={x(hover + 0.5)} x2={x(hover + 0.5)} y1={TOP} y2={BOTTOM} className="stroke-foreground" strokeWidth={1} strokeOpacity={0.5} />
        )}
      </svg>

      {hovered && pointer && (
        <div id="price-estimate-tooltip" role="status"
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md tabular-nums"
          style={{ left: Math.max(4, pointer.left + (pointer.left > 520 ? -180 : 14)), top: Math.max(4, pointer.top - 10) }}>
          <div className="font-medium">{dayLabel(hovered.day.day)} {clock(hovered.quarter)}</div>
          <div>{t('Verkligt', 'Real')}: <span className="font-mono">{hovered.actual === null ? t('inte publicerat', 'not published') : `${kr(hovered.actual)} kr/kWh`}</span></div>
          {hovered.estimate !== null && (
            <div>{t('Uppskattat', 'Estimate')}: <span className="font-mono">{kr(hovered.estimate)} kr/kWh</span></div>
          )}
          {hovered.estimate !== null && hovered.actual !== null && (
            <div>{t('Fel', 'Error')}: <span className="font-mono font-semibold">{kr(hovered.estimate - hovered.actual, true)}</span></div>
          )}
        </div>
      )}
    </div>
  );
};

export default PriceEstimateChart;
