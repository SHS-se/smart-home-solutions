import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { numericInput } from '@/lib/contract-roi';
import type { BatteryModel } from '../../../../../supabase/functions/_shared/planner/device-models';
import type { EquipmentTrial, SolarSizing } from '@/lib/home-baseline/equipment';
import { RoiNumberField } from './RoiFields';

type Draft = Record<'currentArray' | 'currentInverter' | 'array' | 'inverter' | 'battery', string>;
export default function EquipmentAssumptions({ solar, battery, selected, busy, onApply, onReset }: {
  solar: SolarSizing | null; battery: BatteryModel | null; selected: EquipmentTrial | null; busy: boolean;
  onApply: (trial: EquipmentTrial) => void; onReset: () => void;
}) {
  const { t } = useLanguage();
  const initial = (): Draft => ({ currentArray: solar ? String(solar.arrayKwp) : '', currentInverter: solar ? String(solar.inverterKw) : '',
    array: selected?.solar ? String(selected.solar.proposed.arrayKwp) : solar ? String(solar.arrayKwp) : '',
    inverter: selected?.solar ? String(selected.solar.proposed.inverterKw) : solar ? String(solar.inverterKw) : '',
    battery: String(selected?.batteryKwh ?? battery?.capacity_kwh ?? 0) });
  const [draft, setDraft] = useState<Draft>(initial);
  useEffect(() => {
    setDraft({ currentArray: String(solar?.arrayKwp ?? selected?.solar?.current.arrayKwp ?? ''),
      currentInverter: String(solar?.inverterKw ?? selected?.solar?.current.inverterKw ?? ''),
      array: String(selected?.solar?.proposed.arrayKwp ?? solar?.arrayKwp ?? ''),
      inverter: String(selected?.solar?.proposed.inverterKw ?? solar?.inverterKw ?? ''),
      battery: String(selected?.batteryKwh ?? battery?.capacity_kwh ?? 0) });
  }, [solar?.arrayKwp, solar?.inverterKw, battery?.capacity_kwh, selected]);
  const values = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, numericInput(value)])) as Record<keyof Draft, number | null>;
  const current = solar ?? (values.currentArray !== null && values.currentArray > 0 && values.currentInverter !== null && values.currentInverter > 0
    ? { arrayKwp: values.currentArray, inverterKw: values.currentInverter } : null);
  const solarEntered = draft.array !== '' || draft.inverter !== '';
  const solarValid = !solarEntered || current && values.array !== null && values.array >= 0 && values.inverter !== null && values.inverter >= 0;
  const batteryValid = values.battery !== null && values.battery >= 0 && (values.battery === 0 || !!battery);
  const solarChanged = !!current && solarEntered && (current.arrayKwp !== values.array || current.inverterKw !== values.inverter);
  const changed = solarChanged || values.battery !== (battery?.capacity_kwh ?? 0);
  const fields: { key: keyof Draft; label: string; hint?: string; optional?: boolean; disabled?: boolean }[] = [
    { key: 'array', label: t('Solpaneler (kWp)', 'Solar array (kWp)'), optional: !solar, hint: current ? t(`Nuvarande: ${current.arrayKwp} kWp`, `Current: ${current.arrayKwp} kWp`) : undefined },
    { key: 'inverter', label: t('Solväxelriktare, AC (kW)', 'Solar inverter AC output (kW)'), optional: !solar, hint: current ? t(`Nuvarande: ${current.inverterKw} kW`, `Current: ${current.inverterKw} kW`) : undefined },
    { key: 'battery', label: t('Batterikapacitet (kWh)', 'Battery capacity (kWh)'), disabled: !battery,
      hint: battery ? t(`Nuvarande: ${battery.capacity_kwh} kWh. Laddning och urladdning behåller nuvarande effektgränser.`, `Current: ${battery.capacity_kwh} kWh. Charging and discharging keep their current power limits.`)
        : t('Batteriets effektgränser, verkningsgrader och laddgränser behövs innan ett batteri kan simuleras.', 'Battery power limits, efficiencies and SOC bounds are needed before adding a battery to the simulation.') },
  ];
  const apply = () => {
    if (!solarValid || !batteryValid || !changed) return;
    onApply({ solar: solarChanged ? { current: current!, proposed: { arrayKwp: values.array!, inverterKw: values.inverter! } } : null,
      batteryKwh: values.battery === (battery?.capacity_kwh ?? 0) ? null : values.battery });
  };
  return <section className="space-y-4 border-b pb-5 mb-5" data-testid="roi-equipment" aria-label={t('Prova annan utrustning', 'Try different equipment')}>
    <div><h3 className="font-medium">{t('Prova annan utrustning', 'Try different equipment')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('Jämför fler solpaneler eller ett annat batteri med din nuvarande utrustning, under samma månader. Försöket sparas inte och ändrar inte inställningarna i huset.', 'Compare more panels or a different battery with your current equipment over the same months. Trials last for this session and leave your home settings unchanged.')}</p></div>
    {!solar && <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <p className="text-sm text-muted-foreground">{t('Solanläggningens storlek saknas. Ange storlekarna som gäller för produktionshistoriken för att prova ändringar av solanläggningen. Du kan prova batteriet separat.', 'Solar nameplate sizes are missing. Enter the sizes behind the production history to try solar changes. You can try battery changes separately.')}</p>
      <div className="grid gap-4 sm:grid-cols-2">{([{ key: 'currentArray', label: t('Nuvarande solpaneler (kWp)', 'Current solar array (kWp)') },
        { key: 'currentInverter', label: t('Nuvarande solväxelriktare (kW)', 'Current solar inverter (kW)') }] as const).map(field =>
        <RoiNumberField key={field.key} id={`roi-${field.key}`} label={field.label} value={draft[field.key]} min={0} optional onChange={value => setDraft(d => ({ ...d, [field.key]: value }))} />)}</div>
    </div>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.map(field => <RoiNumberField key={field.key} id={`roi-${field.key}`} label={field.label}
      value={draft[field.key]} min={0} hint={field.hint} optional={field.optional} disabled={field.disabled} onChange={value => setDraft(d => ({ ...d, [field.key]: value }))} />)}</div>
    <p className="text-sm text-muted-foreground">{t('Solmodellen använder samma tak, riktning och produktionsmönster. Produktion som den nuvarande växelriktaren klippte bort går inte att återskapa, så nyttan av en större växelriktare kan underskattas. Ange 0 för att prova utan sol eller batteri.', 'Solar estimates keep the same roof, orientation and generation pattern. Production clipped by the current inverter cannot be recovered, so a larger inverter’s benefit may be understated. Enter 0 to try no solar or no battery.')}</p>
    <div className="flex flex-wrap gap-3"><Button variant="outline" className="min-h-11" data-testid="roi-equipment-apply" disabled={busy || !solarValid || !batteryValid || !changed} onClick={apply}>{t('Använd och beräkna om', 'Apply and recalculate')}</Button>
      {selected && <Button variant="ghost" className="min-h-11" data-testid="roi-equipment-reset" onClick={onReset}>{t('Använd nuvarande utrustning', 'Use current equipment')}</Button>}</div>
  </section>;
}
