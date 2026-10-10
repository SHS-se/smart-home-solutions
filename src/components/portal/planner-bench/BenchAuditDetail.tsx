import React from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import { OPPORTUNITY_RULES } from '@/lib/planner-bench/opportunities';
import type { CaseScore, ResolvedRule } from '@/lib/planner-bench/score';
import type { BenchSeries } from '@/lib/planner-bench/types';

interface Props {
  selected: number | null;
  series: BenchSeries;
  score: CaseScore | null;
  rules: readonly ResolvedRule[];
  timeZone: string;
  onSelect: (quarter: number) => void;
  action: React.ReactNode;
}

/** One finding is one saving, even when its source and destination span many quarters. */
export default function BenchAuditDetail({ selected, series, score, rules, timeZone, onSelect, action }: Props) {
  const { t } = useLanguage();
  const audit = score?.audit && !score.auditPending ? score.audit : null;
  const findings = selected === null ? [] : audit?.findings.filter(f =>
    (selected >= f.from && selected <= f.fromEnd) || (selected >= f.to && selected <= f.toEnd)) ?? [];
  const stamp = (quarter: number) => formatHomeDayMonthTime(series.start[quarter], timeZone);
  const quarter = selected === null ? null : score?.quarters[selected];
  return <div id="bench-quarter-explanation" className="space-y-2" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-medium">{selected === null ? t('Välj en kvart för att granska fynd', 'Select a quarter to inspect findings') : stamp(selected)}</span>
      {action}
    </div>
    <p className="text-xs text-muted-foreground">{t('Övre rad = källa, nedre = destination. Fylld = känt pris, kontur = efterklokhet. Piltangenter väljer tid; Enter öppnar detaljer.', 'Upper row = source, lower = destination. Filled = known price, outline = hindsight. Arrow keys browse time; Enter opens details.')}</p>
    {!audit ? <p>{t('Granskning saknas · räkna om', 'Audit missing · recompute')}</p>
      : audit.status !== 'complete' ? <p>{audit.reason}</p>
        : selected !== null && !findings.length && <p>{t('Inga ekonomiska fynd berör den här kvarten.', 'No economic findings involve this quarter.')}</p>}
    {findings.map(f => <div key={f.id} data-finding-id={f.id} className="rounded-md border p-2 space-y-1">
      <div className="flex flex-wrap justify-between gap-2">
        <span className="font-medium">{f.device === 'pool' ? 'Pool' : f.device === 'ev' ? t('Bil', 'Car') : t('Batteri', 'Battery')} · {OPPORTUNITY_RULES.find(rule => rule.key === f.rule)!.label}</span>
        <span className="font-mono tabular-nums">{f.savingSek.toFixed(2)} SEK {t('för hela fyndet', 'for this finding')}</span>
      </div>
      <p className="text-xs text-muted-foreground">{f.basis === 'known' ? t('Känt i förväg', 'Known in advance') : t('Efterklokhet · opublicerade priser behövdes', 'Hindsight · unpublished prices needed')} · {f.kwh.toFixed(2)} kWh · {t('Beloppet gäller hela flytten, inte varje markerad kvart.', 'The amount covers the whole move, not each marked quarter.')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal text-left" onClick={() => onSelect(f.from)}>{t('Från', 'From')}: {stamp(f.from)}{f.fromEnd !== f.from ? ` – ${stamp(f.fromEnd)}` : ''}</Button>
        <span aria-hidden="true">→</span>
        <Button size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal text-left" onClick={() => onSelect(f.to)}>{t('Till', 'To')}: {stamp(f.to)}{f.toEnd !== f.to ? ` – ${stamp(f.toEnd)}` : ''}</Button>
      </div>
    </div>)}
    {quarter && <p className="text-xs">{t('Serviceavdrag', 'Service deductions')}: {quarter.score} {t('p', 'pts')}{quarter.fired.length > 0 && ` · ${quarter.fired.map(key => rules.find(rule => rule.key === key)!.label).join(' · ')}`}</p>}
  </div>;
}
