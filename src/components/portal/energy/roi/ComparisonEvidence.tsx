import { useLanguage } from '@/contexts/LanguageContext';
import type { captureEvidence, MonthLedger } from '@/lib/home-baseline/savings';
import { hasAssumptions } from '@/lib/home-baseline/evidence';

type Evidence = ReturnType<typeof captureEvidence>;

/** One evidence view for the durable monthly totals and the optional chart. */
export function ComparisonEvidence({ evidence, testIdPrefix }: { evidence: Evidence; testIdPrefix?: string }) {
  const { t } = useLanguage();
  const hours = (quarters: number) => `${(quarters / 4).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
  const sek = (amount: number) => `${amount.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} SEK`;
  const labels: Record<string, string> = { grid_import_kwh: t('Nätimport', 'Grid import'), grid_export_kwh: t('Export', 'Exports'),
    solar_production_kwh: t('Solproduktion', 'Solar generation'), total_load_kwh: t('Husförbrukning', 'Household demand'),
    battery_soc: t('Batteri-SOC', 'Battery SOC'), ev_soc: t('Bil-SOC', 'Car SOC'), pool_c: t('Pooltemperatur', 'Pool temperature'),
    outdoor_c: t('Utetemperatur', 'Outdoor temperature'), battery_charge_kwh: t('Batteriladdning', 'Battery charging'), battery_discharge_kwh: t('Batteriurladdning', 'Battery discharge') };
  const names = { battery: t('Batteri', 'Battery'), ev: t('Bil', 'Car'), pool: 'Pool' };
  const { gaps, assumptions, quality, recovery } = evidence, effect = quality.sensitivity;
  const missing = [
    [t('Nätimport', 'Grid import'), gaps.gridImportQuarters], [t('Export', 'Exports'), gaps.gridExportQuarters],
    [t('Solproduktion', 'Solar generation'), gaps.solarQuarters], ...quality.missingDevices.map(d => [d.name, d.quarters]),
    [t('Övriga enhetsmätare', 'Other device meters'), Math.max(0, gaps.deviceReadings - quality.missingDevices.reduce((sum, d) => sum + d.quarters, 0))],
  ] as [string, number][];
  return <div className="space-y-3 text-xs text-muted-foreground whitespace-normal" data-testid="comparison-evidence">
    {hasAssumptions(evidence) && <div className="space-y-1">
      {missing.some(([, count]) => count > 0) && <p>{t('Saknad energi räknas som 0', 'Missing energy counts as 0')}: {missing.filter(([, n]) => n).map(([name, count]) => `${name} ${hours(count)}`).join(' · ')}.</p>}
      {gaps.householdQuarters > 0 && <p>{t('Förbrukning från övriga enhetsmätare', 'Demand from other device meters')}: {hours(gaps.householdQuarters)}.</p>}
      {Object.entries(assumptions).filter(([, value]) => value).map(([key]) => <p key={key} data-testid={testIdPrefix && `${testIdPrefix}-${key}-start`}>{t('Antaget startvärde', 'Assumed starting value')}: {names[key]} {key === 'battery' ? '0%' : key === 'ev' ? '80%' : '30°C'}.</p>)}
      {quality.evSocQuarters > 0 && <p>{t('Bil-SOC saknas', 'Missing car SOC')}: {hours(quality.evSocQuarters)}. {t('Minskningar räknas vid nästa avläsning; dolda resor och laddningar kan inte återskapas.', 'Declines count at the next reading; hidden trips and charging cannot be recovered.')}</p>}
      {evidence.assumedPriceQuarters > 0 && <p>{t('Antaget leverantörspåslag', 'Assumed supplier markup')}: {hours(evidence.assumedPriceQuarters)}.</p>}
    </div>}
    <div className="space-y-1">
      {effect.initial.map((s, i) => <p key={i}>{names[s.assumption]} {s.value}{s.assumption === 'pool' ? '°C' : '%'} {t('vid start', 'at start')}: {s.savingDeltaSek === null ? t('scenariot kunde inte beräknas', 'scenario could not be calculated') : `${sek(s.savingDeltaSek)} ${t('ändring i besparing', 'change in saving')}`}.</p>)}
      {evidence.assumedPriceQuarters > 0 && <p>{t('Påslag +10 öre/kWh', 'Markup +10 öre/kWh')}: {sek(effect.markup10OreDeltaSek)} {t('ändring i besparing', 'change in saving')}.</p>}
      {recovery.hours > 0 && <p>{t('Timdata, möjlig faktureringsskillnad inom timmen', 'Hourly data, possible billing timing difference')}: {sek(effect.timingSavingMinSek)} – {sek(effect.timingSavingMaxSek)}. {t('Standardmodellen hålls oförändrad.', 'Default model held unchanged.')}</p>}
      {missing.some(([, count]) => count > 0) && <p>{t('Saknade energimängder är okända; deras påverkan kan inte beräknas.', 'Missing energy amounts are unknown; their effect cannot be calculated.')}</p>}
    </div>
    {recovery.hours > 0 && <details><summary className="cursor-pointer">{t('Timdata', 'Hourly inputs')} · {recovery.hours} h</summary><div className="mt-1 space-y-1">
      <p>{t('Energi fördelas jämnt, SOC använder timmedelvärden.', 'Energy is spread evenly; SOC uses hourly means.')}</p>
      {quality.hourlyFields.map(field => <p key={field.field}>{labels[field.field] ?? field.field.replace('device:', '')}: {hours(field.quarters)}</p>)}
      {recovery.balanceHours > 0 && <p>{t('Husförbrukning från elflöden', 'Household demand from electricity balance')}: {recovery.balanceHours} h.</p>}
      {recovery.deviceSumHours > 0 && <p>{t('Baslast från övriga enheter', 'Base load from other devices')}: {recovery.deviceSumHours} h.</p>}
      {recovery.invalidReadings > 0 && <p>{t('Ogiltiga energivärden utelämnade', 'Invalid energy readings omitted')}: {recovery.invalidReadings}.</p>}
    </div></details>}
    {evidence.reconstructedPriceQuarters > 0 && <p>{t('Återskapade verkliga marknadspriser', 'Reconstructed actual market prices')}: {hours(evidence.reconstructedPriceQuarters)}.</p>}
  </div>;
}

export function ReportSensitivity({ months, investmentSek }: { months: MonthLedger[]; investmentSek: number }) {
  const { t } = useLanguage();
  if (!months.length) return null;
  const total = (get: (m: MonthLedger) => number) => months.reduce((sum, m) => sum + get(m), 0);
  const format = (value: number) => `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK${investmentSek > 0 ? ` (${(100 * value / investmentSek).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${t('procentenheter ROI', 'ROI percentage points')})` : ''}`;
  const batteryMonths = months.filter(m => m.assumptions.battery);
  const battery = total(m => m.quality.sensitivity.initial.filter(s => s.assumption === 'battery').reduce((sum, s) => sum + (s.savingDeltaSek ?? 0), 0));
  const incompleteBattery = batteryMonths.some(m => m.quality.sensitivity.initial.some(s => s.assumption === 'battery' && s.savingDeltaSek === null));
  return <details className="text-sm" data-testid="roi-assumption-impact"><summary className="cursor-pointer py-2">{t('Indata och påverkan på ROI', 'Inputs and impact on ROI')}</summary><div className="space-y-2 pb-2 text-xs text-muted-foreground">
    {batteryMonths.length > 0 && <p>{t('Fullt batteri i stället för 0% vid start', 'Full battery instead of 0% at start')} ({batteryMonths.length} {t('månader', 'months')}): {incompleteBattery ? t('inte alla scenarier kunde beräknas', 'not all scenarios could be calculated') : format(battery)}.</p>}
    {months.some(m => m.assumedPriceQuarters > 0) && <p>{t('Antaget leverantörspåslag +10 öre/kWh', 'Assumed supplier markup +10 öre/kWh')}: {format(total(m => m.quality.sensitivity.markup10OreDeltaSek))}.</p>}
    {months.some(m => m.recovery.hours > 0) && <p>{t('Möjlig faktureringsskillnad inom timmarna, standardmodellen oförändrad', 'Possible billing timing difference within hours, default model unchanged')}: {format(total(m => m.quality.sensitivity.timingSavingMinSek))} – {format(total(m => m.quality.sensitivity.timingSavingMaxSek))}.</p>}
    <p>{t('Separata känslighetsmått, inte ett gemensamt felintervall. Saknad energi och dolda resor har okänd påverkan.', 'Separate sensitivity measures, not a combined error range. Missing energy and hidden trips have unknown effects.')}</p>
    <p>{t('Samma sparade utrustningsmodell används för alla månader och grafer. Beräkna om för att använda uppdaterade modeller och indata.', 'The same saved equipment model is used for all months and graphs. Recalculate to use updated models and inputs.')}</p>
  </div></details>;
}
