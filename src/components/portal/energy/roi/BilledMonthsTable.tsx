import { useLanguage } from '@/contexts/LanguageContext';
import type { BilledRecord, ModelCheck } from '@/lib/home-baseline/savings-report';
import type { RoiInstallation } from '@/lib/home-baseline/installations';
import ActualInstallations from './ActualInstallations';
import { sek } from './format';

/** What was invoiced, beside the changes to the home that explain it. */
export default function BilledMonthsTable({ record, check, installations }: { record: BilledRecord; check: ModelCheck | null; installations: RoiInstallation[] }) {
  const { t } = useLanguage();
  const checked = new Map(check?.rows.map(row => [row.month, row]) ?? []);
  const head = 'whitespace-nowrap p-2 font-medium';
  return <div className="overflow-x-auto"><table className="w-full text-right text-sm tabular-nums" data-testid="billed-months">
    <caption className="sr-only">{t('Faktisk periodkostnad per månad', 'Actual period cost per month')}</caption>
    <thead><tr className="border-b"><th scope="col" className="whitespace-nowrap p-2 text-left font-medium">{t('Månad', 'Month')}</th><th scope="col" className={head}>{t('Periodkostnad', 'Period cost')}</th>
      {check && <><th scope="col" className={head}>{t('Utan effektavgift', 'Without demand charge')}</th><th scope="col" className={head}>{t('Modellens pris', 'Model’s price')}</th></>}</tr></thead>
    <tbody>{record.rows.map(row => <tr key={row.month} data-testid={`billed-month-${row.month}`} className="border-b align-top">
      <th scope="row" className="p-2 text-left font-normal whitespace-nowrap">{row.month}
        <ActualInstallations events={installations.filter(event => event.installed_month === row.month)} />
      </th>
      <td className="whitespace-nowrap p-2"><span data-testid="roi-amount">{sek(row.billedSek)}</span></td>
      {check && <><td className="whitespace-nowrap p-2">{sek(checked.get(row.month)?.billedSek)}</td><td className="whitespace-nowrap p-2" data-testid="model-price">{sek(checked.get(row.month)?.pricedSek)}</td></>}
    </tr>)}</tbody>
    {record.billedSek !== null && <tfoot><tr className="font-semibold" data-testid="billed-totals"><th scope="row" className="p-2 text-left whitespace-nowrap">{t('Totalt', 'Total')}</th>
      <td className="whitespace-nowrap p-2">{sek(record.billedSek)}<p className="text-xs font-normal text-muted-foreground">{record.billedMonths} {t('fakturerade månader', 'billed months')}</p></td>
      {check && <><td className="whitespace-nowrap p-2">{sek(check.billedSek)}</td><td className="whitespace-nowrap p-2">{sek(check.pricedSek)}<p className="text-xs font-normal text-muted-foreground">{check.rows.length} {t('jämförda månader', 'compared months')}</p></td></>}</tr></tfoot>}
  </table></div>;
}
