import { useLanguage } from '@/contexts/LanguageContext';
import type { SavingsState } from '@/lib/home-baseline/savings-run';
import type { SavingsForecast } from '@/lib/home-baseline/savings-report';
import { formatHomeDateTime } from '@/lib/energy-shift/home-time';
import { Button } from '@/components/ui/button';
import { sek } from './format';

export default function ForecastTable({ state, forecast, onOpenMonth }: {
  state: SavingsState; forecast: SavingsForecast | null; onOpenMonth: (month: string) => void;
}) {
  const { t } = useLanguage();
  const numbers = (value: SavingsForecast['rows'][number] | SavingsForecast) => [value.withoutSek, value.withSek, value.savingSek];
  return <div className="overflow-x-auto" data-testid="scheduler-monthly"><table className="w-full text-right text-sm tabular-nums" data-testid="scheduler-months">
    <caption className="sr-only">{t('Uppskattad kostnad per månad med och utan SHS', 'Estimated monthly cost with and without SHS')}</caption>
    <thead><tr className="border-b">{[t('Månad', 'Month'), t('Utan SHS', 'Without SHS'), t('Med SHS', 'With SHS'), t('Besparing', 'Saving'), ''].map((label, i) => <th scope="col" className={`whitespace-nowrap p-2 font-medium ${i === 0 ? 'text-left' : 'text-right'}`} key={i}>{label}</th>)}</tr></thead>
    <tbody>{state.rows.map(row => {
      const value = forecast?.rows.find(value => value.ledger.month === row.month);
      return <tr key={row.month} data-testid={`scheduler-month-${row.month}`} className="border-b align-top">
        <th scope="row" className="p-2 font-normal text-left whitespace-nowrap">{row.month}
          {row.status === 'done' && row.ledger.coverage < 1 && <p className="text-xs text-muted-foreground">{t('till', 'through')} {formatHomeDateTime(row.ledger.end, row.ledger.timeZone)}</p>}
        </th>
        {row.status === 'done' && value ? <>{numbers(value).map((amount, i) => <td className="whitespace-nowrap p-2" key={i}><span data-testid="roi-amount">{sek(amount)}</span></td>)}
          <td className="p-1"><Button variant="ghost" className="min-h-11" onClick={() => onOpenMonth(row.month)} aria-label={`${t('Visa graf', 'View graph')} ${row.month}`}>{t('Graf', 'Graph')}</Button></td></>
          : <td colSpan={4} className={`p-2 text-left ${row.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{row.status === 'failed' ? row.error
            : row.status === 'running' ? t('Beräknar…', 'Calculating…') : row.status === 'queued' ? t('Väntar…', 'Waiting…')
              : row.status === 'unavailable' ? t('Ingen historik', 'No history') : '—'}</td>}
      </tr>;
    })}</tbody>
    {forecast && forecast.rows.length > 0 && <tfoot><tr className="font-semibold" data-testid="scheduler-totals"><th scope="row" className="p-2 text-left whitespace-nowrap">{t('Totalt', 'Total')} ({forecast.rows.length}/{state.rows.length})</th>{numbers(forecast).map((value, i) => <td className="whitespace-nowrap p-2" data-testid={i === 2 ? 'roi-period-saving' : undefined} key={i}>{sek(value)}</td>)}<td /></tr></tfoot>}
  </table></div>;
}
