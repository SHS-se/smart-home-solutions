// Both planners on one axis: what each has spent by every point in the plan.
// This is the view the bench exists for, so it never follows the current/test
// toggle. The pool's temperature is in the plan chart above, as it is for a
// customer's plan.

import React, { useMemo, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatHomeDayMonthTime, homeHourMinute } from '@/lib/energy-shift/home-time';
import type { BenchSeries } from '@/lib/planner-bench/types';

const W = 1160, L = 58, R = W - 92;
const AXIS = 'fill-muted-foreground text-[10px] font-mono';
const CURRENT = 'hsl(var(--muted-foreground))';
const TEST = 'var(--plan-load-2)';

interface Props {
  current: BenchSeries | null;
  test: BenchSeries | null;
  timeZone: string;
}

const BenchComparePanel: React.FC<Props> = ({ current, test, timeZone }) => {
  const { t } = useLanguage();
  const [hover, setHover] = useState<number | null>(null);
  const axis = test ?? current;

  const g = useMemo(() => {
    if (!axis) return null;
    const n = axis.start.length;
    const t0 = Date.parse(axis.start[0]);
    const tEnd = Date.parse(axis.start[n - 1]) + axis.hours[n - 1] * 3.6e6;
    const X = (ms: number) => L + (ms - t0) / (tEnd - t0) * (R - L);
    const x0 = axis.start.map(s => X(Date.parse(s)));
    const x1 = axis.start.map((s, i) => X(Date.parse(s) + axis.hours[i] * 3.6e6));

    const cost = { top: 26, h: 90 };
    const height = cost.top + cost.h + 26;

    const cumulative = (s: BenchSeries | null) => {
      if (!s) return null;
      let running = 0;
      return s.costSek.map(c => (running += c));
    };
    const cc = cumulative(current), ct = cumulative(test);
    const costs = [...(cc ?? []), ...(ct ?? []), 0];
    const cLo = Math.min(...costs), cHi = Math.max(10, ...costs);
    const CY = (v: number) => cost.top + cost.h - (v - cLo) / (cHi - cLo) * cost.h;

    const step = (values: (number | null)[] | null, Y: (v: number) => number) => {
      if (!values) return '';
      let d = '', pen = false;
      values.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x0[i].toFixed(1)},${Y(v).toFixed(1)}L${x1[i].toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const costTicks = (() => {
      const span = cHi - cLo, raw = span / 4;
      const mag = 10 ** Math.floor(Math.log10(raw)), unit = [1, 2, 5, 10].find(m => m * mag >= raw)! * mag;
      const out: number[] = [];
      for (let v = Math.ceil(cLo / unit) * unit; v <= cHi + 1e-9; v += unit) out.push(v);
      return out;
    })();
    const sixHours = axis.start.flatMap((s, i) => {
      const { hour, minute } = homeHourMinute(s, timeZone);
      return minute === 0 && hour % 6 === 0 ? [{ i, hour }] : [];
    });
    return { n, x0, x1, cost, height, CY, cc, ct, step, costTicks, sixHours };
  }, [axis, current, test, timeZone]);

  if (!g || !axis) return null;
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = event.currentTarget, point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const x = point.matrixTransform(svg.getScreenCTM()!.inverse()).x;
    let i = 0;
    while (i < g.n - 1 && g.x1[i] < x) i++;
    setHover(x < L || x > R ? null : i);
  };
  const fmt = (v: number | null | undefined, digits = 2) => v === null || v === undefined ? '—' : v.toFixed(digits);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${g.height}`} className="w-full min-w-[720px]" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
          role="img" aria-label={t('Kostnad för båda planerarna', 'Cost for both planners')}>
          {g.sixHours.map(({ i, hour }) => (
            <g key={i}>
              <line x1={g.x0[i]} x2={g.x0[i]} y1={16} y2={g.height - 20} className="stroke-border" strokeWidth={hour === 0 ? 1.4 : 0.6} />
              <text x={g.x0[i]} y={g.height - 6} textAnchor="middle" className={AXIS}>{`${String(hour).padStart(2, '0')}:00`}</text>
            </g>
          ))}
          <text x={L} y={g.cost.top - 10} className="fill-foreground text-[11px] font-medium">{t('Kostnad', 'What it costs')}</text>
          <text x={L + 90} y={g.cost.top - 10} className={AXIS}>{t('kr, ackumulerad nätkostnad', 'SEK, cumulative grid cost')}</text>
          {g.costTicks.map(v => (
            <g key={v}>
              <line x1={L} x2={R} y1={g.CY(v)} y2={g.CY(v)} className="stroke-border" />
              <text x={L - 8} y={g.CY(v) + 3} textAnchor="end" className={AXIS}>{v.toFixed(0)}</text>
            </g>
          ))}
          <path d={g.step(g.cc, g.CY)} fill="none" stroke={CURRENT} strokeWidth={1.6} strokeDasharray="5 3" />
          <path d={g.step(g.ct, g.CY)} fill="none" stroke={TEST} strokeWidth={2.2} />
          {g.cc && <text x={R + 7} y={g.CY(g.cc[g.cc.length - 1]) + 3} className={AXIS}>{`${g.cc[g.cc.length - 1].toFixed(0)} kr`}</text>}
          {g.ct && <text x={R + 7} y={g.CY(g.ct[g.ct.length - 1]) + 3 + (g.cc && Math.abs(g.cc[g.cc.length - 1] - g.ct[g.ct.length - 1]) < 8 ? 10 : 0)} className="text-[10px] font-mono font-medium" fill={TEST}>{`${g.ct[g.ct.length - 1].toFixed(0)} kr`}</text>}
          {hover !== null && <line x1={g.x0[hover]} x2={g.x0[hover]} y1={16} y2={g.height - 20} className="stroke-foreground" strokeDasharray="3 3" />}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground font-mono min-h-[2.5em]">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: CURRENT }} />{t('Nuvarande planerare', 'Current planner')}</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-5 border-t-2" style={{ borderColor: TEST }} />{t('Testplanerare', 'Test planner')}</span>
        {hover !== null && (
          <span>
            {formatHomeDayMonthTime(axis.start[hover], timeZone)} · {fmt(axis.importPrice[hover])} kr/kWh {axis.published[hover] ? t('publicerat', 'published') : t('uppskattat', 'estimated')}
          </span>
        )}
      </div>
    </div>
  );
};

export default BenchComparePanel;
