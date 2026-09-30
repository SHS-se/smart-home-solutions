import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { marginalValue, type UtilityCurve } from '../../../../supabase/functions/_shared/planner/store-value';
import { moveCurvePoint, resizeCurve } from '@/lib/energy-shift/point-curve';

interface Props {
  current: UtilityCurve;
  next: UtilityCurve;
  capacity: number;
  state: number;
  onChange: (curve: UtilityCurve) => void;
}

/** One coordinate transform for drawing, touch, mouse and keyboard edits. */
export default function PointCurveEditor({ current, next, capacity, state, onChange }: Props) {
  const { t } = useLanguage();
  const svg = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState(0);
  const [count, setCount] = useState(String(next.points.length));
  useEffect(() => setCount(String(next.points.length)), [next.points.length]);
  const [resizeError, setResizeError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ index: number; yMax: number; xMax: number } | null>(null);
  const maxX = drag?.xMax ?? Math.max(capacity, ...current.points.map(p => p.at), ...next.points.map(p => p.at), 1);
  const maxY = drag?.yMax ?? Math.max(0.1, ...current.points.map(p => p.sek_per_unit), ...next.points.map(p => p.sek_per_unit)) * 1.25;
  const X = (x: number) => 65 + x / maxX * 800;
  const Y = (y: number) => 245 - y / maxY * 220;
  const series = (curve: UtilityCurve) => {
    const points = [{ at: 0, sek_per_unit: marginalValue(curve, 0) }, ...curve.points];
    const last = points.at(-1)!;
    if (last.at < maxX) points.push({ at: last.at, sek_per_unit: 0 }, { at: maxX, sek_per_unit: 0 });
    return points.map(p => `${X(p.at)},${Y(p.sek_per_unit)}`).join(' ');
  };
  const index = Math.min(selected, next.points.length - 1);
  const point = next.points[index];
  const numericEdit = (field: 'at' | 'sek_per_unit', text: string) => {
    if (text === '') return;
    const value = Number(text);
    if (Number.isFinite(value)) onChange({ unit: next.unit, points: next.points.map((p, i) => i === index ? { ...p, [field]: value } : p) });
  };
  return <div className="space-y-3" data-testid="battery-point-editor">
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">{t('Antal punkter', 'Number of points')}
        <Input aria-label={t('Antal punkter', 'Number of points')} className="w-28" type="number" min={1} step={1} value={count} onChange={e => setCount(e.target.value)} />
      </label>
      <Button variant="outline" onClick={() => {
        try { onChange(resizeCurve(next, Number(count))); setSelected(0); setResizeError(null); }
        catch (error) { setResizeError(String(error instanceof Error ? error.message : error)); }
      }}>{t('Använd punktantal', 'Apply point count')}</Button>
      <span className="text-xs text-muted-foreground">{next.points.length} {t('punkter i nästa kurva', 'points in next curve')}</span>
    </div>
    {resizeError && <p role="alert" className="text-sm text-destructive">{resizeError}</p>}
    <div className="flex justify-end gap-4 text-xs"><span className="text-blue-600">━ {t('Nuvarande plan', 'Current plan')}</span><span className="text-orange-600">━ {t('Nästa plan', 'Next plan')}</span></div>
    <svg ref={svg} viewBox="0 0 900 300" className="w-full min-h-64" aria-label={t('Redigerbar batterivärdekurva', 'Editable battery value curve')}
      onPointerMove={event => {
        if (!drag || !svg.current) return;
        const rect = svg.current.getBoundingClientRect();
        // SVG's default meet transform may letterbox on narrow screens.
        const scale = Math.min(rect.width / 900, rect.height / 300);
        const left = rect.left + (rect.width - 900 * scale) / 2;
        const top = rect.top + (rect.height - 300 * scale) / 2;
        const at = Math.max(0, Math.min(maxX, ((event.clientX - left) / scale - 65) / 800 * maxX));
        const value = Math.max(0, (245 - (event.clientY - top) / scale) / 220 * maxY);
        onChange(moveCurvePoint(next, drag.index, at, value));
      }} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
      {[0, 1, 2, 3, 4].map(tick => <g key={tick}>
        <line x1={65} x2={865} y1={Y(maxY * tick / 4)} y2={Y(maxY * tick / 4)} stroke="currentColor" opacity={0.12} />
        <text x={57} y={Y(maxY * tick / 4) + 4} textAnchor="end" fontSize={12} fill="currentColor">{(maxY * tick / 4).toFixed(2)}</text>
        <text x={X(maxX * tick / 4)} y={267} textAnchor="middle" fontSize={12} fill="currentColor">{(maxX * tick / 4).toFixed(1)}</text>
      </g>)}
      <text x={465} y={294} textAnchor="middle" fontSize={12} fill="currentColor">{t('Lagrad energi över minsta SOC (kWh)', 'Stored energy above minimum SOC (kWh)')}</text>
      <text x={16} y={135} transform="rotate(-90 16 135)" textAnchor="middle" fontSize={12} fill="currentColor">SEK/kWh</text>
      <line x1={X(state)} x2={X(state)} y1={25} y2={245} stroke="#64748b" strokeDasharray="4 4" />
      <text x={X(state)} y={17} textAnchor="middle" fontSize={11} fill="currentColor">{t('Nu', 'Now')} {state.toFixed(2)} kWh</text>
      <polyline data-testid="battery-current-curve" data-values={JSON.stringify(current.points)} points={series(current)} fill="none" stroke="#2563eb" strokeWidth={2.5} />
      <polyline data-testid="battery-next-curve" points={series(next)} fill="none" stroke="#ea580c" strokeWidth={2.5} />
      {next.points.map((p, i) => <circle key={i} cx={X(p.at)} cy={Y(p.sek_per_unit)} r={i === index ? 8 : 6}
        fill="#ea580c" stroke="white" strokeWidth={2} tabIndex={0} role="button" className="cursor-grab touch-none focus:outline focus:outline-2 focus:outline-blue-600"
        aria-label={`${t('Punkt', 'Point')} ${i + 1}: ${p.at.toFixed(3)} kWh, ${p.sek_per_unit.toFixed(3)} SEK/kWh`}
        onFocus={() => setSelected(i)} onPointerDown={event => {
          event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          setSelected(i); setDrag({ index: i, yMax: maxY, xMax: maxX });
        }} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const step = event.shiftKey ? 0.1 : 0.01;
          onChange(moveCurvePoint(next, i, p.at + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
            p.sek_per_unit + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0)));
        }}><title>{p.at.toFixed(3)} kWh · {p.sek_per_unit.toFixed(3)} SEK/kWh</title></circle>)}
    </svg>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">{t('Vald punkt', 'Selected point')}<select aria-label={t('Vald punkt', 'Selected point')} className="flex h-10 w-full rounded-md border bg-background px-3" value={index} onChange={event => setSelected(Number(event.target.value))}>{next.points.map((_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></label>
      <label className="text-sm">kWh<Input aria-label={t('Punktens lagrade energi', 'Point stored energy')} type="number" step="any" value={point.at} onChange={event => numericEdit('at', event.target.value)} /></label>
      <label className="text-sm">SEK/kWh<Input aria-label={t('Punktens värde', 'Point value')} type="number" step="any" value={point.sek_per_unit} onChange={event => numericEdit('sek_per_unit', event.target.value)} /></label>
    </div>
    <p className="text-xs text-muted-foreground">{t('Dra punkterna eller ange exakta värden. Piltangenter flyttar vald punkt; Skift ger större steg. Energin ska öka åt höger och värdet ska vara oförändrat eller minska. Värdet blir noll efter sista punkten.', 'Drag points or enter exact values. Arrow keys move a selected point; Shift makes larger steps. Energy increases to the right and value stays level or decreases. Value becomes zero after the final point.')}</p>
  </div>;
}
