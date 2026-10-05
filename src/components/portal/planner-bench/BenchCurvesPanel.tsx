// The value curves each planner actually planned a test case with.
//
// A curve says what one more unit in a store (a kWh in the battery, a degree
// in the pool, a kilometre in the car) is worth at each level. Planners work
// them out per case, so this is the place to see what a version decided a
// store was worth, and how that differs from the current planner. The curves
// are the ones the planner reported with its plan, never rebuilt here.

import React from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import type { UsedCurve } from '@/lib/planner-bench/types';
import { curvePlotPoints } from '@/lib/planner-bench/curve-plot';

const W = 280, H = 120, PAD = { l: 34, r: 8, t: 8, b: 18 };
const STORES: { key: string; sv: string; en: string }[] = [
  { key: 'battery', sv: 'Hembatteri', en: 'Home battery' },
  { key: 'pool', sv: 'Pool', en: 'Pool' },
  { key: 'ev', sv: 'Elbil', en: 'Car' },
];
const UNIT: Record<string, string> = { kwh: 'kWh', celsius: '°C', km: 'km' };

interface Props { current: UsedCurve[] | null; test: UsedCurve[] | null }

const BenchCurvesPanel: React.FC<Props> = ({ current, test }) => {
  const { t } = useLanguage();
  if (!current && !test) return null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 text-sm">
        <span className="font-medium">{t('Värdekurvor som användes', 'Value curves used')}</span>
        <span className="text-xs text-muted-foreground">{t('kr per enhet vid varje nivå, som planeraren själv rapporterade', 'SEK per unit at each level, as the planner itself reported')}</span>
        <span className="ml-auto flex gap-3 text-xs text-muted-foreground">
          <span><span className="inline-block w-4 border-t-2 border-dashed border-muted-foreground align-middle" /> {t('Nuvarande', 'Current')}</span>
          <span><span className="inline-block w-4 border-t-2 border-sky-600 align-middle" /> Test</span>
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {STORES.map(store => {
          const a = current?.find(c => c.store === store.key) ?? null;
          const b = test?.find(c => c.store === store.key) ?? null;
          const all = [a, b].filter((c): c is UsedCurve => c !== null && c.points.length > 0);
          const unit = UNIT[all[0]?.unit ?? ''] ?? all[0]?.unit ?? '';
          const xs = all.flatMap(c => [...curvePlotPoints(c).map(p => p.at), ...(c.initial_state !== null ? [c.initial_state] : [])]);
          const ys = all.flatMap(c => c.points.map(p => p.sek_per_unit));
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y1 = Math.max(...ys, 1e-9);
          const sx = (x: number) => PAD.l + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
          const sy = (y: number) => H - PAD.b - (y / y1) * (H - PAD.t - PAD.b);
          const path = (c: UsedCurve) => curvePlotPoints(c).map((p, i) => `${i ? 'L' : 'M'}${sx(p.at).toFixed(1)},${sy(p.sek_per_unit).toFixed(1)}`).join(' ');
          const note = (c: UsedCurve | null) => c && [
            c.mode,
            c.initial_state !== null ? `${t('start', 'start')} ${c.initial_state.toFixed(1)} ${unit}` : null,
            c.reference_sek_per_kwh !== null ? `${t('referenspris', 'reference')} ${c.reference_sek_per_kwh.toFixed(2)} kr/kWh` : null,
          ].filter(Boolean).join(' · ');
          return (
            <div key={store.key} id={`bench-curve-${store.key}`} className="rounded-md border px-3 py-2">
              <div className="text-sm font-medium">{t(store.sv, store.en)} <span className="text-xs font-normal text-muted-foreground">kr/{unit || t('enhet', 'unit')}</span></div>
              {all.length === 0
                ? <p className="py-6 text-xs text-muted-foreground">{t('Planeraren rapporterade ingen kurva.', 'The planner reported no curve.')}</p>
                : (
                  <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
                    aria-label={t(`Värdekurva för ${store.sv.toLowerCase()}`, `Value curve for the ${store.en.toLowerCase()}`)}>
                    <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} className="stroke-border" />
                    <text x={PAD.l - 4} y={sy(y1) + 4} textAnchor="end" className="fill-muted-foreground text-[9px]">{y1.toFixed(y1 < 10 ? 2 : 0)}</text>
                    <text x={PAD.l - 4} y={H - PAD.b} textAnchor="end" className="fill-muted-foreground text-[9px]">0</text>
                    <text x={PAD.l} y={H - 4} className="fill-muted-foreground text-[9px]">{x0.toFixed(0)}</text>
                    <text x={W - PAD.r} y={H - 4} textAnchor="end" className="fill-muted-foreground text-[9px]">{x1.toFixed(0)} {unit}</text>
                    {a && <path d={path(a)} fill="none" className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="4 3" />}
                    {b && <path d={path(b)} fill="none" className="stroke-sky-600" strokeWidth={2} />}
                    {(b ?? a)?.initial_state != null && (
                      <line x1={sx((b ?? a)!.initial_state!)} x2={sx((b ?? a)!.initial_state!)} y1={PAD.t} y2={H - PAD.b} className="stroke-amber-500" strokeWidth={1} />
                    )}
                  </svg>
                )}
              <div className="space-y-0.5 text-[11px] leading-tight text-muted-foreground">
                {a && <div>{t('Nuvarande', 'Current')}: {note(a) || '—'}</div>}
                {b && <div>Test: {note(b) || '—'}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default BenchCurvesPanel;
