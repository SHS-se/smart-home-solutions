import { useLanguage } from '@/contexts/LanguageContext';
import type { equipmentBenefit } from '@/lib/home-baseline/equipment';
import { sek } from './format';

export default function EquipmentComparison({ benefit, totalMonths, solarChanged }: { benefit: ReturnType<typeof equipmentBenefit>; totalMonths: number; solarChanged: boolean }) {
  const { t } = useLanguage();
  const kwh = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`;
  return <section className="rounded-xl border bg-card p-5 sm:p-6 space-y-4" data-testid="roi-equipment-comparison" aria-label={t('Utrustningsjämförelse', 'Equipment comparison')}>
    <div><h3 className="text-lg font-semibold">{t('Vad ändringen av utrustning ger', 'What the equipment change saves')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('Nuvarande och vald utrustning med SHS, för samma månader.', 'Current and selected equipment with SHS, over the same months.')}</p></div>
    {solarChanged && <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">{t('Soljämförelsen bygger på dagens produktionsmönster. En större växelriktare kan ge ytterligare produktion som inte går att beräkna från den här historiken; ett litet belopp här bevisar därför inte att uppgraderingen saknar nytta.', 'Solar sizing uses the current generation pattern. A larger inverter may recover production that this history cannot quantify; a small saving here does not establish that the upgrade has no benefit.')}</p>}
    <p className="text-2xl font-semibold tabular-nums" data-testid="roi-equipment-saving">{benefit ? sek(benefit.savingSek) : '—'}</p>
    {benefit ? <>
      <p className="text-sm text-muted-foreground">{benefit.rows.length}/{totalMonths} {t('månader jämförda. Ett negativt belopp betyder högre kostnad.', 'months compared. A negative amount means a higher cost.')}</p>
      <div className="overflow-x-auto"><table className="w-full text-sm text-right tabular-nums">
        <caption className="sr-only">{t('Utrustningens kostnad och köpt och såld el', 'Equipment operating cost, imports and exports')}</caption>
        <thead><tr className="border-b"><th scope="col" className="p-2 text-left">{t('Under vald period', 'Over the selected period')}</th><th scope="col" className="p-2">{t('Nuvarande', 'Current')}</th><th scope="col" className="p-2">{t('Vald', 'Selected')}</th></tr></thead>
        <tbody>{[{ label: t('Beräknad driftkostnad', 'Estimated running cost'), current: sek(benefit.currentSek), selected: sek(benefit.selectedSek) },
          { label: t('Köpt el', 'Grid imports'), current: kwh(benefit.currentImportKwh), selected: kwh(benefit.selectedImportKwh) },
          { label: t('Såld el', 'Grid exports'), current: kwh(benefit.currentExportKwh), selected: kwh(benefit.selectedExportKwh) }].map(row => <tr key={row.label} className="border-b last:border-0"><th scope="row" className="p-2 text-left font-normal">{row.label}</th><td className="p-2 whitespace-nowrap">{row.current}</td><td className="p-2 whitespace-nowrap">{row.selected}</td></tr>)}</tbody>
      </table></div>
    </> : <p className="text-sm text-muted-foreground">{t('Jämförelsen visas när samma månader är färdigberäknade för båda alternativen.', 'The comparison appears as matching months finish calculating for both options.')}</p>}
    <p className="text-xs text-muted-foreground">{t('Driftkostnaden tar hänsyn till skillnaden i lagrad energi vid start och slut. Effektavgift och inköpskostnad för utrustning ingår inte. Besparingen från utrustningen visas separat från besparingen av SHS-styrningen ovan.', 'Running costs account for the change in stored energy between the start and end. Demand charges and equipment purchase costs are excluded. Equipment savings are separate from the SHS control savings shown above.')}</p>
  </section>;
}
