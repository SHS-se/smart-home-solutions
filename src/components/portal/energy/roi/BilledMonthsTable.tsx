import { useLanguage } from '@/contexts/LanguageContext';
import type { BilledRecord } from '@/lib/home-baseline/savings-report';
import type { RoiInstallation } from '@/lib/home-baseline/installations';
import ActualInstallations from './ActualInstallations';
import { sek } from './format';

/** What was invoiced, beside the changes to the home that explain it. */
export default function BilledMonthsTable({ record, installations }: { record: BilledRecord; installations: RoiInstallation[] }) {
  const { t } = useLanguage();
  return <div className="overflow-x-auto"><table className="w-full text-right text-sm tabular-nums" data-testid="billed-months">
    <caption className="sr-only">{t('Fakturerat per månad', 'Billed per month')}</caption>
    <thead><tr className="border-b"><th scope="col" className="whitespace-nowrap p-2 text-left font-medium">{t('Månad', 'Month')}</th><th scope="col" className="whitespace-nowrap p-2 font-medium">{t('Fakturerat', 'Billed')}</th></tr></thead>
    <tbody>{record.rows.map(row => <tr key={row.month} data-testid={`billed-month-${row.month}`} className="border-b align-top">
      <th scope="row" className="p-2 text-left font-normal whitespace-nowrap">{row.month}
        <ActualInstallations events={installations.filter(event => event.installed_month === row.month)} />
      </th>
      <td className="whitespace-nowrap p-2"><span data-testid="roi-amount">{sek(row.billedSek)}</span></td>
    </tr>)}</tbody>
    {record.billedSek !== null && <tfoot><tr className="font-semibold" data-testid="billed-totals"><th scope="row" className="p-2 text-left whitespace-nowrap">{t('Totalt', 'Total')}</th>
      <td className="whitespace-nowrap p-2">{sek(record.billedSek)}<p className="text-xs font-normal text-muted-foreground">{record.billedMonths} {t('fakturerade månader', 'billed months')}</p></td></tr></tfoot>}
  </table></div>;
}
