import { useLanguage } from '@/contexts/LanguageContext';
import { hotWaterStateLabel, type HotWaterQuarter } from '@/lib/energy-shift/hot-water-gate';

/** Permission belongs to selected-slot information; consumption stays in the chart. */
export default function BoilerSlotDetail({ quarter }: { quarter: HotWaterQuarter }) {
  const { t } = useLanguage();
  return <div data-boiler-control className="rounded-md border p-2 space-y-1">
    <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
      <span>{t('Varmvattenberedare', 'Water boiler')}</span>
      <span>{hotWaterStateLabel(quarter.state, t)}</span>
    </div>
    <p className="text-xs text-muted-foreground">{t('Termostaten styr. Pågående uppvärmning får avslutas.', 'Thermostat controlled. Active heating may finish.')}</p>
    <p className="text-xs text-muted-foreground">{quarter.expectedW === null
      ? t('Separat förbrukning för beredaren saknas i det här testfallet.', 'This case has no separate boiler consumption.')
      : t(`Modellerad förbrukning denna kvart: ${(quarter.expectedW / 4000).toFixed(2)} kWh.`, `Modeled consumption this quarter: ${(quarter.expectedW / 4000).toFixed(2)} kWh.`)}</p>
  </div>;
}
