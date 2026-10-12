import { useLanguage } from '@/contexts/LanguageContext';
import type { SavingsState } from '@/lib/home-baseline/savings-run';
import type { RoiReport } from '@/lib/home-baseline/roi-report';
import { formatHomeDateTime } from '@/lib/energy-shift/home-time';
import { Button } from '@/components/ui/button';
import type { RoiInstallation } from '@/lib/home-baseline/installations';
import ActualInstallations from './ActualInstallations';

export default function SchedulerMonthlySavings({ state, report, installations, onOpenMonth }: {
  state: SavingsState; report: RoiReport | null; installations: RoiInstallation[]; onOpenMonth: (month: string) => void;
}) {
  const { t } = useLanguage();
  const sek = (amount: number | null | undefined) => amount == null ? '—' : `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
  const numbers = (value: NonNullable<typeof report>['rows'][number] | NonNullable<typeof report>) =>
    [value.baselineSek, value.actualSek, value.schedulerSek, value.vsBaselineSek, value.vsActualSek];
  return <div className="overflow-x-auto" data-testid="scheduler-monthly"><table className="w-full text-right text-sm tabular-nums" data-testid="scheduler-months">
    <caption className="sr-only">{t('Månatlig jämförelse och besparing', 'Monthly comparison and savings')}</caption>
    <thead><tr className="border-b">{[t('Månad', 'Month'), t('Basmodell', 'Baseline model'), t('Faktiskt fakturerat', 'Actual'), 'SHS Energy Scheduler', t('Besparing mot basmodell', 'Savings vs Baseline'), t('Besparing mot faktiskt', 'Savings vs Actual'), ''].map((label, i) => <th scope="col" className={`whitespace-nowrap p-2 font-medium ${i === 0 ? 'text-left' : 'text-right'}`} key={i}>{label}</th>)}</tr></thead>
    <tbody>{state.rows.map(row => {
      const value = report?.rows.find(value => value.ledger.month === row.month);
      return <tr key={row.month} data-testid={`scheduler-month-${row.month}`} className="border-b align-top">
        <th scope="row" className="p-2 font-normal text-left whitespace-nowrap">{row.month}
          {row.status === 'done' && row.ledger.coverage < 1 && <p className="text-xs text-muted-foreground">{t('till', 'through')} {formatHomeDateTime(row.ledger.end, row.ledger.timeZone)}</p>}
          <ActualInstallations events={installations.filter(event => event.installed_month === row.month)} />
        </th>
        {row.status === 'done' && value ? <>{numbers(value).map((amount, i) => <td className="whitespace-nowrap p-2" key={i}><span data-testid="roi-amount">{sek(amount)}</span></td>)}
          <td className="p-1"><Button variant="ghost" className="min-h-11" onClick={() => onOpenMonth(row.month)} aria-label={`${t('Visa graf', 'View graph')} ${row.month}`}>{t('Graf', 'Graph')}</Button></td></>
          : <td colSpan={6} className={`p-2 text-left ${row.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{row.status === 'failed' ? row.error
            : row.status === 'running' ? t('Beräknar…', 'Calculating…') : row.status === 'queued' ? t('Väntar…', 'Waiting…')
              : row.status === 'unavailable' ? t('Ingen historik', 'No history') : '—'}</td>}
      </tr>;
    })}</tbody>
    {report && report.rows.length > 0 && <tfoot><tr className="font-semibold" data-testid="scheduler-totals"><th scope="row" className="p-2 text-left whitespace-nowrap">{t('Totalt', 'Total')} ({report.rows.length}/{state.rows.length})</th>{numbers(report).map((value, i) => <td className="whitespace-nowrap p-2" data-testid={i === 3 ? 'roi-period-saving' : undefined} key={i}>{sek(value)}{(i === 1 || i === 4) && <p className="text-xs font-normal text-muted-foreground">{report.actualMonths} {t('fakturerade månader', 'billed months')}</p>}</td>)}<td /></tr></tfoot>}
  </table></div>;
}
