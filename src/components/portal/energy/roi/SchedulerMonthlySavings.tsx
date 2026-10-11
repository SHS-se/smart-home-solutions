import { useEffect, useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { schedulerSavings } from '@/lib/home-baseline/savings';
import type { SavingsRun } from '@/lib/home-baseline/savings-run';
import { formatHomeDateTime } from '@/lib/energy-shift/home-time';

export default function SchedulerMonthlySavings({ run, from, to, homeId, subscriptionSek, onOpenMonth }: {
  run: SavingsRun; from: string; to: string; homeId: string | null; subscriptionSek: number | null; onOpenMonth: (month: string) => void;
}) {
  const { t } = useLanguage();
  const state = useSyncExternalStore(run.subscribe, run.snapshot);
  useEffect(() => { run.setRange(from, to); }, [run, from, to]);
  const matching = state.rangeKey === `${from}|${to}`;
  const rows = matching ? state.rows : [];
  const ready = rows.flatMap(row => row.status === 'done' ? [row.ledger] : []);
  const subscription = subscriptionSek !== null && subscriptionSek >= 0 && Number.isFinite(subscriptionSek) ? subscriptionSek : null;
  const totals = schedulerSavings(ready, subscription);
  const sek = (amount: number | null) => amount === null ? '—' : `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
  const numbers = (value: typeof totals) => [value.baselineSek, value.recordedSek, value.grossSek, value.subscriptionSek, value.netSek];
  return <div className="space-y-3" data-testid="scheduler-monthly">
    <Button className="min-h-11" disabled={!homeId || !rows.length} onClick={() => state.running ? run.cancel() : void run.calculate()} data-testid="scheduler-calculate">
      {state.running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{state.running ? t('Avbryt', 'Cancel') : t('Beräkna månader', 'Calculate months')}
    </Button>
    {!homeId && <p className="text-sm text-muted-foreground">{t('Välj ett hem.', 'Select a home.')}</p>}
    {matching && state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {ready.length === 0 && !state.running && <p className="text-sm text-muted-foreground">{t('Schemaläggarbesparing för ditt hem är ännu inte beräknad.', 'Scheduler savings for your home have not yet been calculated.')}</p>}
    {rows.length > 0 && <div className="overflow-x-auto" data-testid="scheduler-months"><table className="w-full text-right text-sm tabular-nums">
      <caption className="sr-only">{t('Månatlig besparing med schemaläggaren', 'Monthly scheduler savings')}</caption>
      <thead><tr className="border-b">{[t('Månad', 'Month'), t('Standardmodell', 'Default model'), t('Uppmätt', 'Recorded'), t('Elbesparing', 'Electricity saving'), t('Abonnemang', 'Subscription'), t('Netto', 'Net')].map(label => <th scope="col" className="whitespace-nowrap p-2 font-medium" key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.month} data-testid={`scheduler-month-${row.month}`} className="border-b align-top">
        <th scope="row" className="p-2 font-normal text-left">{row.status === 'done'
          ? <><button className="underline underline-offset-4 whitespace-nowrap" onClick={() => onOpenMonth(row.month)} aria-label={`${t('Visa modell', 'View model')} ${row.month}`}>{row.month}</button>
            {row.ledger.coverage < 1 && <p className="whitespace-nowrap text-xs text-muted-foreground">{t('till', 'through')} {formatHomeDateTime(row.ledger.end, row.ledger.timeZone)}</p>}
            {Object.values(row.ledger.gaps).some(count => count > 0) && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer whitespace-nowrap">{t('Dataluckor', 'Data gaps')}</summary>
              <p>{t('Saknad energi = 0', 'Missing energy = 0')}. {t('Nätimport / export', 'Grid import / export')}: {row.ledger.gaps.gridImportQuarters} / {row.ledger.gaps.gridExportQuarters}.
                {' '}{t('Förbrukning / sol / enheter', 'Consumption / solar / devices')}: {row.ledger.gaps.householdQuarters} / {row.ledger.gaps.solarQuarters} / {row.ledger.gaps.deviceReadings}.</p></details>}
          </> : row.month}</th>
        {row.status === 'done' ? numbers(schedulerSavings([row.ledger], subscription)).map((value, i) => <td className="whitespace-nowrap p-2" key={i}>{sek(value)}</td>)
          : <td colSpan={5} className={`p-2 text-left ${row.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{row.status === 'failed' ? row.error
            : row.status === 'running' ? t('Beräknar…', 'Calculating…') : row.status === 'queued' ? t('Väntar…', 'Waiting…')
              : row.status === 'unavailable' ? t('Ingen historik', 'No history') : '—'}</td>}
      </tr>)}</tbody>
      {ready.length > 0 && <tfoot><tr className="font-semibold" data-testid="scheduler-totals"><th scope="row" className="p-2 text-left">{t('Beräknade månader', 'Calculated months')} ({ready.length}/{rows.length})</th>{numbers(totals).map((value, i) => <td className="whitespace-nowrap p-2" key={i}>{sek(value)}</td>)}</tr></tfoot>}
    </table></div>}
  </div>;
}
