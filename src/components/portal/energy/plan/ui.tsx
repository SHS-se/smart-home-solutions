// Presentational primitives shared by every plan section.
//
// Moved verbatim out of the former LoadShiftTab on 2026-08-13.

import React, { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';

export const useSeriesVisibility = <T extends string>() => {
  const [hidden, setHidden] = useState<Set<T>>(() => new Set());
  const toggle = useCallback((key: T) => {
    setHidden(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return { hidden, toggle, visible: (key: T) => !hidden.has(key) };
};

export const Kpi: React.FC<{ label: string; value: string; detail: string; tone?: 'good' | 'bad' }> = ({ label, value, detail, tone }) => (
  <div className="rounded-lg border p-3">
    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className={`mt-1 text-xl font-medium tabular-nums ${tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : ''}`}>{value}</div>
    <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>
  </div>
);

export const DeltaKpi: React.FC<{
  label: string;
  value: string;
  detail: string;
  tone?: 'good' | 'bad';
  emphasized?: boolean;
}> = ({ label, value, detail, tone, emphasized = false }) => (
  <div className={`rounded-lg border p-3 ${
    tone === 'good'
      ? 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/25'
      : tone === 'bad'
        ? 'border-rose-300 bg-rose-50/70 dark:border-rose-800 dark:bg-rose-950/25'
        : 'bg-muted/20'
  } ${emphasized ? 'md:ring-1 md:ring-current/10' : ''}`}>
    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className={`mt-1 font-semibold tabular-nums ${emphasized ? 'text-2xl' : 'text-xl'} ${
      tone === 'good'
        ? 'text-emerald-700 dark:text-emerald-400'
        : tone === 'bad'
          ? 'text-rose-700 dark:text-rose-400'
          : ''
    }`}>{value}</div>
    <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>
  </div>
);

export const SeriesToggleLegend = <Key extends string,>({ series, hidden, onToggle, ariaLabel }: {
  series: Array<{ key: Key; label: string; color: string }>;
  hidden: Set<Key>;
  onToggle: (key: Key) => void;
  ariaLabel: string;
}) => (
  <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-2" role="group" aria-label={ariaLabel}>
    {series.map(item => {
      const visible = !hidden.has(item.key);
      return (
        <button
          key={item.key}
          type="button"
          aria-pressed={visible}
          onClick={() => onToggle(item.key)}
          className={`inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${visible ? '' : 'opacity-40'}`}
        >
          <span
            className="h-0.5 w-4 rounded-full"
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          <span className={visible ? '' : 'line-through'}>{item.label}</span>
        </button>
      );
    })}
  </div>
);

export const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <Card><CardContent className="py-10 text-sm text-muted-foreground">{text}</CardContent></Card>
);
