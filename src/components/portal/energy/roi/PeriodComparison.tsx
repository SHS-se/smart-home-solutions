import { useLanguage } from '@/contexts/LanguageContext';
import type { ComparisonCapture } from '@/lib/home-baseline/browser';
import type { ModeledCosts } from '@/lib/home-baseline/roi-pricing';

export default function PeriodComparison({ capture, costs, actualSek }: { capture: ComparisonCapture; costs: ModeledCosts; actualSek: number | null }) {
  const { t } = useLanguage();
  const modeledValues = (ledger: ComparisonCapture['result']['ledger'], solarW: readonly number[], totalSek: number) =>
    [ledger.importKwh, Math.max(0, solarW.reduce((n, w) => n + w / 4000, 0) - ledger.exportKwh), ledger.exportKwh, totalSek];
  const recorded = capture.input.recorded;
  const actors = [
    { label: t('Basmodell', 'Baseline model'), values: modeledValues(capture.result.ledger, capture.result.series.solarW, costs.baseline.totalSek) },
    { label: t('Faktisk förbrukning', 'Actual consumption'), values: [
      recorded.ledger.importKwh,
      Math.max(0, recorded.rows.reduce((n, row) => n + (row.solarW ?? 0) / 4000, 0) - recorded.ledger.exportKwh),
      recorded.ledger.exportKwh, actualSek,
    ] },
    { label: 'SHS Energy Scheduler', values: modeledValues(capture.scheduler.ledger, capture.scheduler.series.solarW, costs.scheduler.totalSek) },
  ];
  const labels = [t('El från nätet', 'Grid energy consumption'), t('Använd solel', 'Solar energy consumption'), t('Exporterad energi', 'Exported energy'), t('El + nätkostnad', 'Electricity + grid cost')];
  const amount = (v: number | null, unit: string) => v === null ? '—' : `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`;
  return <div className="rounded-lg border p-4 overflow-x-auto" data-testid="baseline-costs"><table className="w-full text-right text-sm tabular-nums" data-testid="period-comparison">
    <thead><tr className="border-b"><th scope="col" className="text-left py-2">{t('Jämförelse', 'Comparison')}</th>{actors.map(a => <th scope="col" className="pl-3" key={a.label}>{a.label}</th>)}</tr></thead>
    <tbody>{labels.map((label, i) => <tr key={label}><th scope="row" className="text-left py-2 font-normal">{label}</th>{actors.map((actor, n) => <td className="pl-3 whitespace-nowrap" key={actor.label} data-testid={i === 3 && n === 0 ? 'baseline-net-cost' : undefined}>{amount(actor.values[i], i === 3 ? 'SEK' : 'kWh')}</td>)}</tr>)}</tbody>
  </table><p className="mt-3 border-t pt-3 text-sm">{t('Besparing mot basmodell', 'Savings vs Baseline')}: <strong data-testid="period-saving">{amount(costs.savingSek, 'SEK')}</strong></p></div>;
}
