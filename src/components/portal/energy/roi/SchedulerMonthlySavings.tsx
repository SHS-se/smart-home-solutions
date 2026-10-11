import { useLanguage } from '@/contexts/LanguageContext';
import type { SavingsState } from '@/lib/home-baseline/savings-run';
import type { RoiReport } from '@/lib/home-baseline/roi-report';
import { formatHomeDateTime } from '@/lib/energy-shift/home-time';
import { Button } from '@/components/ui/button';
import { hasAssumptions } from '@/lib/home-baseline/evidence';
import { ComparisonEvidence } from './ComparisonEvidence';

export default function SchedulerMonthlySavings({ state, report, onOpenMonth }: {
  state: SavingsState; report: RoiReport | null; onOpenMonth: (month: string) => void;
}) {
  const { t } = useLanguage();
  const sek = (amount: number | null | undefined) => amount == null ? '—' : `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
  const numbers = (value: NonNullable<typeof report>['rows'][number] | NonNullable<typeof report>) =>
    [value.baselineSek, value.recordedSek, value.grossSek, value.contractSavingSek, value.subscriptionSek, value.netSek];
  return <div className="overflow-x-auto" data-testid="scheduler-monthly"><table className="w-full text-right text-sm tabular-nums" data-testid="scheduler-months">
    <caption className="sr-only">{t('Månatlig jämförelse och besparing', 'Monthly comparison and savings')}</caption>
    <thead><tr className="border-b">{[t('Månad', 'Month'), t('Standard', 'Default'), t('Uppmätt', 'Actual'), t('Schemaläggare', 'Scheduler'), t('Avtal', 'Contract'), t('Abonnemang', 'Subscription'), t('SHS netto', 'SHS net'), ''].map((label, i) => <th scope="col" className="whitespace-nowrap p-2 font-medium" key={i}>{label}</th>)}</tr></thead>
    <tbody>{state.rows.map(row => {
      const value = report?.rows.find(value => value.ledger.month === row.month);
      return <tr key={row.month} data-testid={`scheduler-month-${row.month}`} className="border-b align-top">
        <th scope="row" className="p-2 font-normal text-left whitespace-nowrap">{row.month}
          {row.status === 'done' && <>
            {row.ledger.coverage < 1 && <p className="text-xs text-muted-foreground">{t('till', 'through')} {formatHomeDateTime(row.ledger.end, row.ledger.timeZone)}</p>}
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{hasAssumptions(row.ledger) ? t('Antaganden', 'Assumptions') : t('Indata', 'Data basis')}</summary>
              <div className="mt-2 min-w-56 max-w-80"><ComparisonEvidence evidence={row.ledger} /></div>
            </details>
          </>}
        </th>
        {row.status === 'done' && value ? <>{numbers(value).map((amount, i) => <td className="whitespace-nowrap p-2" key={i}>{sek(amount)}</td>)}
          <td className="p-1"><Button variant="ghost" className="min-h-11" onClick={() => onOpenMonth(row.month)} aria-label={`${t('Visa graf', 'View graph')} ${row.month}`}>{t('Graf', 'Graph')}</Button></td></>
          : <td colSpan={7} className={`p-2 text-left ${row.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{row.status === 'failed' ? row.error
            : row.status === 'running' ? t('Beräknar…', 'Calculating…') : row.status === 'queued' ? t('Väntar…', 'Waiting…')
              : row.status === 'unavailable' ? t('Ingen historik', 'No history') : '—'}</td>}
      </tr>;
    })}</tbody>
    {report && report.rows.length > 0 && <tfoot><tr className="font-semibold" data-testid="scheduler-totals"><th scope="row" className="p-2 text-left whitespace-nowrap">{t('Totalt', 'Total')} ({report.rows.length}/{state.rows.length})</th>{numbers(report).map((value, i) => <td className="whitespace-nowrap p-2" data-testid={i === 3 ? 'roi-period-saving' : undefined} key={i}>{sek(value)}</td>)}<td /></tr></tfoot>}
  </table></div>;
}
