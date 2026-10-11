import { useLanguage } from '@/contexts/LanguageContext';
import type { BaselineCapture } from '@/lib/home-baseline/browser';
import { periodComparison } from '@/lib/home-baseline/comparison';
import { monthLedger, schedulerSavings } from '@/lib/home-baseline/savings';

export default function PeriodComparison({ capture, subscriptionSek, currentFeeSek }: { capture: BaselineCapture; subscriptionSek: number | null; currentFeeSek: number }) {
  const { t } = useLanguage();
  const comparison = periodComparison(capture);
  const fee = subscriptionSek === null ? 0 : monthLedger(capture).coverage * currentFeeSek;
  const subscription = subscriptionSek !== null && Number.isFinite(subscriptionSek) && subscriptionSek >= 0
    ? schedulerSavings([monthLedger(capture)], subscriptionSek).subscriptionSek : null;
  const amount = (value: number, unit: string) => `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`;
  const measures = [
    { key: 'gridKwh' as const, label: t('El från nätet', 'Grid energy consumption'), unit: 'kWh' },
    { key: 'solarKwh' as const, label: t('Använd solel', 'Solar energy consumption'), unit: 'kWh' },
    { key: 'exportKwh' as const, label: t('Exporterad solel', 'Solar energy exported'), unit: 'kWh' },
    { key: 'costSek' as const, label: t('Elkostnad', 'Grid energy cost'), unit: 'SEK' },
  ];
  return <div className="rounded-lg border p-3 sm:p-4" data-testid="baseline-costs">
    <table className="w-full text-right text-sm tabular-nums" data-testid="period-comparison">
      <caption className="sr-only">{t('Samma period och elavtal', 'Same period and electricity contract')}</caption>
      <thead><tr className="border-b"><th scope="col" className="pb-2 text-left font-medium">{t('Jämförelse', 'Comparison')}</th><th scope="col" className="pb-2 pl-2 font-medium">{t('Standard', 'Default')}</th><th scope="col" className="pb-2 pl-2 font-medium">{t('Uppmätt', 'Actual')}</th></tr></thead>
      <tbody>{measures.map(({ key, label, unit }) => <tr key={key} data-testid={`comparison-${key}`}><th scope="row" className="py-2 text-left font-normal">{label}</th>
        <td className="py-2 pl-2" data-testid={key === 'costSek' ? 'baseline-net-cost' : undefined}>{amount(comparison.baseline[key] + (key === 'costSek' ? fee : 0), unit)}</td><td className="py-2 pl-2">{amount(comparison.actual[key] + (key === 'costSek' ? fee : 0), unit)}</td></tr>)}</tbody>
    </table>
    <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 border-t pt-3 text-sm">
      <p>{t('Besparing', 'Saving')}: <strong data-testid="period-saving">{amount(comparison.savingSek, 'SEK')}</strong></p>
      {subscription !== null && <><p>{t('Abonnemang', 'Subscription')}: {amount(subscription, 'SEK')}</p><p>{t('Netto', 'Net')}: <strong>{amount(comparison.savingSek - subscription, 'SEK')}</strong></p></>}
    </div>
  </div>;
}
