import { useLanguage } from '@/contexts/LanguageContext';
import type { equipmentBenefit } from '@/lib/home-baseline/equipment';
import { roundedSek } from '@/lib/home-baseline/roi-pricing';
import { formatHomeDateTime } from '@/lib/energy-shift/home-time';
import { sek } from './format';

export default function EquipmentComparison({ benefit, months, solarChanged }: { benefit: ReturnType<typeof equipmentBenefit>; months: readonly string[]; solarChanged: boolean }) {
  const { t } = useLanguage();
  const kwh = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`;
  const modes = [{ key: 'withoutShs', id: 'without-shs', label: t('Utan SHS', 'Without SHS') },
    { key: 'withShs', id: 'with-shs', label: t('Med SHS', 'With SHS') }] as const;
  const missing = months.filter(month => !benefit?.rows.some(row => row.month === month));
  const complete = benefit && months.length > 0 && !missing.length;
  const last = benefit?.rows.at(-1);
  return <section className="rounded-xl border bg-card p-5 sm:p-6 space-y-4" data-testid="roi-equipment-comparison" aria-label={t('Utrustningsjämförelse', 'Equipment comparison')}>
    <div><h3 className="text-lg font-semibold">{t('Vad ändringen av utrustning ger', 'What the equipment change saves')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('Nuvarande och vald utrustning under samma månader, både utan och med SHS.', 'Current and selected equipment over the same months, both without and with SHS.')}</p></div>
    {solarChanged && <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">{t('Soljämförelsen bygger på dagens produktionsmönster. En större växelriktare kan ge ytterligare produktion som inte går att beräkna från den här historiken; ett litet belopp här bevisar därför inte att uppgraderingen saknar nytta.', 'Solar sizing uses the current generation pattern. A larger inverter may recover production that this history cannot quantify; a small saving here does not establish that the upgrade has no benefit.')}</p>}
    {complete ? <>
      <p className="text-sm text-muted-foreground">{benefit.rows.length}/{months.length} {t('månader jämförda. Ett negativt belopp betyder högre kostnad.', 'months compared. A negative amount means a higher cost.')}
        {last && last.coverage < 1 && <> {t('Båda alternativen är beräknade till', 'Both options calculated through')} {formatHomeDateTime(last.end, last.timeZone)}.</>}</p>
      <div className="grid gap-4 xl:grid-cols-2">{modes.map(mode => {
        const totals = benefit[mode.key];
        return <section key={mode.key} className="min-w-0 rounded-lg border p-4 space-y-3" aria-label={mode.label}>
          <h4 className="font-medium">{mode.label}</h4>
          <p className="text-sm text-muted-foreground">{t('Lägre driftkostnad med den valda utrustningen', 'Lower running cost with the selected equipment')}</p>
          <p className="text-2xl font-semibold tabular-nums" data-testid={`roi-equipment-saving-${mode.id}`}>{sek(totals.savingSek)}</p>
          <div className="overflow-x-auto"><table className="w-full text-sm text-right tabular-nums">
            <caption className="sr-only">{mode.label} · {t('Utrustningens kostnad och köpt och såld el', 'Equipment operating cost, imports and exports')}</caption>
            <thead><tr className="border-b"><th scope="col" className="p-2 text-left">{t('Under vald period', 'Over the selected period')}</th><th scope="col" className="p-2">{t('Nuvarande', 'Current')}</th><th scope="col" className="p-2">{t('Vald', 'Selected')}</th></tr></thead>
            <tbody>{[{ key: 'costs', label: t('Beräknad driftkostnad', 'Estimated running cost'), current: sek(totals.currentSek), selected: sek(totals.selectedSek) },
              { key: 'imports', label: t('Köpt el', 'Grid imports'), current: kwh(totals.currentImportKwh), selected: kwh(totals.selectedImportKwh) },
              { key: 'exports', label: t('Såld el', 'Grid exports'), current: kwh(totals.currentExportKwh), selected: kwh(totals.selectedExportKwh) }].map(row =>
              <tr key={row.key} data-testid={`roi-equipment-${row.key}-${mode.id}`} className="border-b last:border-0"><th scope="row" className="p-2 text-left font-normal">{row.label}</th><td className="p-2">{row.current}</td><td className="p-2">{row.selected}</td></tr>)}</tbody>
          </table></div>
        </section>;
      })}</div>
      <p className="text-sm" data-testid="roi-equipment-shs-saving">{t(
        `Besparing från SHS under samma period: ${sek(roundedSek(benefit.withoutShs.currentSek - benefit.withShs.currentSek))} med nuvarande utrustning och ${sek(roundedSek(benefit.withoutShs.selectedSek - benefit.withShs.selectedSek))} med vald utrustning.`,
        `Saving from SHS over the same period: ${sek(roundedSek(benefit.withoutShs.currentSek - benefit.withShs.currentSek))} with current equipment and ${sek(roundedSek(benefit.withoutShs.selectedSek - benefit.withShs.selectedSek))} with selected equipment.`)}</p>
    </> : <p role="status" className="text-sm text-muted-foreground">{t(
      `Jämförelsen väntar på samma period för alla ${months.length} månader. ${benefit?.rows.length ?? 0}/${months.length} klara. Återstår: ${missing.join(', ')}.`,
      `The comparison needs matching periods for all ${months.length} months. ${benefit?.rows.length ?? 0}/${months.length} ready. Remaining: ${missing.join(', ')}.`)}</p>}
    <p className="text-xs text-muted-foreground">{t('Varje kostnad är summan av motsvarande ”Utan SHS”- eller ”Med SHS”-belopp i månadstabellen. Utrustningens besparing är skillnaden mellan nuvarande och vald utrustning. Effektavgift och inköpskostnad för utrustning ingår inte.', 'Each cost is the sum of the corresponding “Without SHS” or “With SHS” amounts in the monthly table. Equipment savings are the difference between current and selected equipment. Demand charges and equipment purchase costs are excluded.')}</p>
  </section>;
}
