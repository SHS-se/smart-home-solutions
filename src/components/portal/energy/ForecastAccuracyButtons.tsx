import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLanguage } from '@/contexts/LanguageContext';
import type { AccuracyReport } from '../../../../supabase/functions/_shared/forecast-accuracy';

const colours = {green: 'text-emerald-700 dark:text-emerald-400', lime: 'text-lime-700 dark:text-lime-400',
  yellow: 'text-yellow-700 dark:text-yellow-400', orange: 'text-orange-700 dark:text-orange-400', red: 'text-red-700 dark:text-red-400'};
export default function ForecastAccuracyButtons({report, error}: {report: AccuracyReport | null; error?: string | null}) {
  const {t} = useLanguage();
  const [open, setOpen] = useState<'forecast' | 'historical' | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const labels = {forecast: t('Prognosnoggrannhet %', 'Forecast accuracy %'), historical: t('Historisk noggrannhet %', 'Historical accuracy %')};
  const value = (percentage: number | null | undefined) => percentage == null ? '—' : String(percentage);
  const stamp = report ? new Date(report.calculated_at).toLocaleString(undefined, {timeZone: report.timezone}) : '';
  return <><div className="flex flex-wrap gap-2" data-testid="forecast-accuracy">
    {(['forecast', 'historical'] as const).map(kind => {
      const score = report?.[kind];
      return <Button key={kind} variant="ghost" size="sm" className="gap-2 text-xs text-muted-foreground"
        title={error || (report ? `${stamp} · ${report.forecast_plan_id ?? ''}` : '')} onClick={event => {trigger.current = event.currentTarget; setOpen(kind);}}>
        {labels[kind]} <span className={`font-semibold tabular-nums ${score?.grade ? colours[score.grade] : ''}`}>{value(score?.percentage)}</span>
      </Button>;
    })}</div>
    <Dialog open={open !== null} onOpenChange={visible => {if (!visible) setOpen(null);}}>
      <DialogContent className="max-w-sm" aria-describedby={undefined} onCloseAutoFocus={event => {event.preventDefault(); trigger.current?.focus();}}>
        <DialogHeader><DialogTitle>{open ? labels[open] : ''}</DialogTitle></DialogHeader>
        {error ? <p role="status" className="text-sm text-muted-foreground">{error}</p> :
          !(open && report?.[open].devices.length) ? <p className="text-sm text-muted-foreground">{t('Lär sig', 'Learning')}</p> :
          <ul className="divide-y">{(open ? report?.[open].devices : [])?.map(row => <li key={row.key} className="flex justify-between gap-4 py-2 text-sm">
            <span>{row.name}</span><span className={`font-medium tabular-nums ${row.grade ? colours[row.grade] : 'text-muted-foreground'}`}>
              {value(row.percentage)}{row.percentage !== null ? '%' : ''}</span>
          </li>)}</ul>}
        {report && <time className="text-xs text-muted-foreground" dateTime={report.calculated_at}>{stamp}</time>}
      </DialogContent>
    </Dialog></>;
}
