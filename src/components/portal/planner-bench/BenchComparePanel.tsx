// Both planners on one axis: pool temperature, when each heats, and what each
// has spent by every point in the plan. This is the view the bench exists for,
// so it never follows the current/test toggle.

import React, { useMemo, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatHomeDayMonthTime, homeHourMinute } from '@/lib/energy-shift/home-time';
import type { BenchSeries } from '@/lib/planner-bench/types';

const W = 1160, L = 58, R = W - 92;
const AXIS = 'fill-muted-foreground text-[10px] font-mono';
const CURRENT = 'hsl(var(--muted-foreground))';
const TEST = 'var(--plan-load-2)';
const HEATING_W = 50;

interface Props {
  current: BenchSeries | null;
  test: BenchSeries | null;
  timeZone: string;
  /** Pool limits drawn as reference lines, from the case's criteria. */
  minC: number;
  comfortC: number;
}

const BenchComparePanel: React.FC<Props> = ({ current, test, timeZone, minC, comfortC }) => {
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

    const hasPool = [current, test].some(s => s?.poolC.some(v => v !== null));
    const temps = [current, test].flatMap(s => s?.poolC ?? []).filter((v): v is number => v !== null);
    const tLo = Math.floor(Math.min(minC - 0.3, ...temps) * 2) / 2;
    const tHi = Math.ceil(Math.max(comfortC + 0.3, ...temps) * 2) / 2;
    const temp = { top: 26, h: hasPool ? 130 : 0 };
    const bars = { top: temp.top + temp.h + 8, h: hasPool ? 18 : 0 };
    const cost = { top: bars.top + bars.h + (hasPool ? 42 : 0), h: 90 };
    const height = cost.top + cost.h + 26;
    const TY = (v: number) => temp.top + temp.h - (v - tLo) / (tHi - tLo) * temp.h;

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
    const ticks = (lo: number, hi: number, count: number) => {
      const stepSize = Math.max(0.5, Math.ceil((hi - lo) / count * 2) / 2);
      const out: number[] = [];
      for (let v = Math.ceil(lo / stepSize) * stepSize; v <= hi + 1e-9; v += stepSize) out.push(Math.round(v * 10) / 10);
      return out;
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
    return { n, x0, x1, hasPool, temp, bars, cost, height, TY, CY, tLo, tHi, cc, ct, step, ticks, costTicks, sixHours };
  }, [axis, current, test, minC, comfortC, timeZone]);

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
          role="img" aria-label={t('Pooltemperatur och kostnad för båda planerarna', 'Pool temperature and cost for both planners')}>
          {g.sixHours.map(({ i, hour }) => (
            <g key={i}>
              <line x1={g.x0[i]} x2={g.x0[i]} y1={16} y2={g.height - 20} className="stroke-border" strokeWidth={hour === 0 ? 1.4 : 0.6} />
              <text x={g.x0[i]} y={g.height - 6} textAnchor="middle" className={AXIS}>{`${String(hour).padStart(2, '0')}:00`}</text>
            </g>
          ))}
          {g.hasPool && (
            <>
              <text x={L} y={g.temp.top - 10} className="fill-foreground text-[11px] font-medium">{t('Pooltemperatur', 'Pool temperature')}</text>
              <text x={L + 110} y={g.temp.top - 10} className={AXIS}>{t('°C · båda planerarna', '°C · both planners')}</text>
              {g.ticks(g.tLo, g.tHi, 4).map(v => (
                <g key={v}>
                  <line x1={L} x2={R} y1={g.TY(v)} y2={g.TY(v)} className="stroke-border" />
                  <text x={L - 8} y={g.TY(v) + 3} textAnchor="end" className={AXIS}>{v.toFixed(1)}</text>
                </g>
              ))}
              <line x1={L} x2={R} y1={g.TY(minC)} y2={g.TY(minC)} stroke="hsl(var(--destructive))" strokeDasharray="5 3" />
              <text x={L + 4} y={g.TY(minC) - 3} className="text-[9px]" fill="hsl(var(--destructive))">{`${minC} °C ${t('lägsta', 'minimum')}`}</text>
              <line x1={L} x2={R} y1={g.TY(comfortC)} y2={g.TY(comfortC)} stroke="var(--plan-grid)" strokeDasharray="2 3" />
              <text x={L + 4} y={g.TY(comfortC) - 3} className="text-[9px]" fill="var(--plan-grid)">{`${comfortC} °C ${t('komfort', 'comfort')}`}</text>
              <path d={g.step(current?.poolC ?? null, g.TY)} fill="none" stroke={CURRENT} strokeWidth={1.6} strokeDasharray="5 3" />
              <path d={g.step(test?.poolC ?? null, g.TY)} fill="none" stroke={TEST} strokeWidth={2.2} />
              <text x={L - 8} y={g.bars.top + 6} textAnchor="end" className={AXIS}>{t('nuv.', 'current')}</text>
              <text x={L - 8} y={g.bars.top + 16} textAnchor="end" className={AXIS}>test</text>
              {axis.start.map((_, i) => (
                <g key={i}>
                  {current && current.poolW[i] > HEATING_W && (
                    <rect x={g.x0[i]} y={g.bars.top} width={g.x1[i] - g.x0[i] + 0.3} height={7} fill={CURRENT} />
                  )}
                  {test && test.poolW[i] > HEATING_W && (
                    <rect x={g.x0[i]} y={g.bars.top + 10} width={g.x1[i] - g.x0[i] + 0.3} height={7} fill={TEST} />
                  )}
                </g>
              ))}
            </>
          )}
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
            {g.hasPool && ` · ${t('nuv.', 'current')} ${fmt(current?.poolC[hover])} °C · test ${fmt(test?.poolC[hover])} °C`}
          </span>
        )}
      </div>
    </div>
  );
};

export default BenchComparePanel;
