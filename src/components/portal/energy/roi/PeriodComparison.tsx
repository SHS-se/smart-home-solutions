import { useLanguage } from '@/contexts/LanguageContext';
import type { ComparisonCapture } from '@/lib/home-baseline/browser';

export default function PeriodComparison({ capture }: { capture: ComparisonCapture }) {
  const { t } = useLanguage();
  const actors = [
    { label: t('Basmodell', 'Baseline model'), series: capture.result.series, ledger: capture.result.ledger, bill: capture.modeled.baselineBill },
    { label: 'SHS Energy Scheduler', series: capture.scheduler.series, ledger: capture.scheduler.ledger, bill: capture.modeled.schedulerBill },
  ];
  const values = actors.map(a => [a.ledger.importKwh, Math.max(0, a.series.solarW.reduce((n, w) => n + w / 4000, 0) - a.ledger.exportKwh), a.ledger.exportKwh, a.bill.totalSek]);
  const labels = [t('El från nätet', 'Grid energy consumption'), t('Använd solel', 'Solar energy consumption'), t('Exporterad energi', 'Exported energy'), t('El + nätkostnad', 'Electricity + grid cost')];
  const amount = (v: number, unit: string) => `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`;
  return <div className="rounded-lg border p-4 overflow-x-auto" data-testid="baseline-costs"><table className="w-full text-right text-sm tabular-nums" data-testid="period-comparison">
    <thead><tr className="border-b"><th scope="col" className="text-left py-2">{t('Jämförelse', 'Comparison')}</th>{actors.map(a => <th scope="col" className="pl-3" key={a.label}>{a.label}</th>)}</tr></thead>
    <tbody>{labels.map((label, i) => <tr key={label}><th scope="row" className="text-left py-2 font-normal">{label}</th>{values.map((v, n) => <td className="pl-3 whitespace-nowrap" key={n} data-testid={i === 3 && n === 0 ? 'baseline-net-cost' : undefined}>{amount(v[i], i === 3 ? 'SEK' : 'kWh')}</td>)}</tr>)}</tbody>
  </table><p className="mt-3 border-t pt-3 text-sm">{t('Besparing mot basmodell', 'Savings vs Baseline')}: <strong data-testid="period-saving">{amount(capture.modeled.baselineBill.totalSek - capture.modeled.schedulerBill.totalSek, 'SEK')}</strong></p></div>;
}
