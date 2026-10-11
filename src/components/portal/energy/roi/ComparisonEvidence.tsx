import { useLanguage } from '@/contexts/LanguageContext';
import type { captureEvidence, MonthLedger } from '@/lib/home-baseline/savings';
import type { ModelComparison } from '@/lib/home-baseline/model-comparison';
import type { RoiBasis } from '@/lib/home-baseline/roi-report';
import { hasAssumptions } from '@/lib/home-baseline/evidence';

type Evidence = ReturnType<typeof captureEvidence>;

/** One evidence view for the durable monthly totals and the optional chart. */
export function ComparisonEvidence({ evidence, modeled, testIdPrefix }: { evidence: Evidence; modeled: ModelComparison; testIdPrefix?: string }) {
  const { t } = useLanguage();
  const hours = (quarters: number) => `${(quarters / 4).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
  const sek = (amount: number) => `${amount.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} SEK`;
  const labels: Record<string, string> = { grid_import_kwh: t('Nätimport', 'Grid import'), grid_export_kwh: t('Export', 'Exports'),
    solar_production_kwh: t('Solproduktion', 'Solar generation'), total_load_kwh: t('Husförbrukning', 'Household demand'),
    battery_soc: t('Batteri-SOC', 'Battery SOC'), ev_soc: t('Bil-SOC', 'Car SOC'), pool_c: t('Pooltemperatur', 'Pool temperature'),
    outdoor_c: t('Utetemperatur', 'Outdoor temperature'), battery_charge_kwh: t('Batteriladdning', 'Battery charging'), battery_discharge_kwh: t('Batteriurladdning', 'Battery discharge') };
  const names = { battery: t('Batteri', 'Battery'), ev: t('Bil', 'Car'), pool: 'Pool' };
  const { gaps, assumptions, quality, recovery } = evidence;
  const missing = [
    [t('Solproduktion', 'Solar generation'), gaps.solarQuarters], ...quality.missingDevices.map(d => [d.name, d.quarters]),
    [t('Övriga enhetsmätare', 'Other device meters'), Math.max(0, gaps.deviceReadings - quality.missingDevices.reduce((sum, d) => sum + d.quarters, 0))],
  ] as [string, number][];
  return <div className="space-y-3 text-xs text-muted-foreground whitespace-normal" data-testid="comparison-evidence">
    {hasAssumptions(evidence) && <div className="space-y-1">
      {missing.some(([, count]) => count > 0) && <p>{t('Saknad energi räknas som 0', 'Missing energy counts as 0')}: {missing.filter(([, n]) => n).map(([name, count]) => `${name} ${hours(count)}`).join(' · ')}.</p>}
      {(gaps.gridImportQuarters > 0 || gaps.gridExportQuarters > 0) && <p>{t('Luckor i uppmätt graf', 'Recorded graph gaps')}: {t('import', 'import')} {hours(gaps.gridImportQuarters)} · {t('export', 'exports')} {hours(gaps.gridExportQuarters)}. {t('Dessa mätvärden påverkar inte fakturabelopp eller modellkostnader direkt.', 'These meter readings do not directly affect invoice totals or modeled costs.')}</p>}
      {gaps.householdQuarters > 0 && <p>{t('Förbrukning från övriga enhetsmätare', 'Demand from other device meters')}: {hours(gaps.householdQuarters)}.</p>}
      {Object.entries(assumptions).filter(([, value]) => value).map(([key]) => <p key={key} data-testid={testIdPrefix && `${testIdPrefix}-${key}-start`}>{t('Antaget startvärde', 'Assumed starting value')}: {names[key]} {key === 'battery' ? '0%' : key === 'ev' ? '80%' : '30°C'}.</p>)}
      {quality.evSocQuarters > 0 && <p>{t('Bil-SOC saknas', 'Missing car SOC')}: {hours(quality.evSocQuarters)}. {t('Minskningar räknas vid nästa avläsning; dolda resor och laddningar kan inte återskapas.', 'Declines count at the next reading; hidden trips and charging cannot be recovered.')}</p>}
      {evidence.assumedPriceQuarters > 0 && <p>{t('Antaget leverantörspåslag', 'Assumed supplier markup')}: {hours(evidence.assumedPriceQuarters)}.</p>}
    </div>}
    <div className="space-y-1">
      <p>{t('Schemaläggaren ser högst 72 h framåt. Bilens tillgänglighet slutar vid nästa registrerade SOC-minskning; efteråt planeras den om. Parkerad bil antas inkopplad. Framtida laddning efter hemkomst saknas i föregående prognos.', 'Scheduler forecasts extend up to 72 h. Car availability ends at the next recorded SOC decline and is replanned afterward. Parked time is assumed connected; later home charging is absent from the preceding forecast.')}</p>
      {modeled.effects.map((s, i) => <p key={i}>{names[s.key]} {s.value}{s.key === 'pool' ? '°C' : '%'} {t('vid start', 'at start')}: {s.error ? `${t('scenariot kunde inte beräknas', 'scenario could not be calculated')}: ${s.error}` : `${t('Besparing mot basmodell', 'Savings vs Baseline')} ${sek(s.vsBaselineDeltaSek!)} · ${t('mot faktiskt', 'vs Actual')} ${sek(s.vsActualDeltaSek!)}`}.</p>)}
      {recovery.hours > 0 && <p>{t('Timprisplacering, oförändrade modellerade flöden', 'Hourly price timing, fixed modeled flows')}: {t('mot basmodell', 'vs Baseline')} {sek(modeled.timing.vsBaselineMinSek)} – {sek(modeled.timing.vsBaselineMaxSek)}; {t('mot faktiskt', 'vs Actual')} {sek(modeled.timing.vsActualMinSek)} – {sek(modeled.timing.vsActualMaxSek)}.</p>}
      {missing.some(([, count]) => count > 0) && <p>{t('Saknade energimängder är okända; deras påverkan kan inte beräknas.', 'Missing energy amounts are unknown; their effect cannot be calculated.')}</p>}
      {quality.missingDevices.some(d => d.quarters > 0) && <p>{t('Enhetsmätare används för att skilja baslast från modellerade laster. Saknade värden kan därför påverka baslasten även när enheten simuleras.', 'Device meters separate base load from modeled loads. Missing readings can affect base load even though the device is simulated.')}</p>}
    </div>
    <details><summary className="cursor-pointer">{t('Service och kvarvarande energi', 'Service and ending energy')}</summary><div className="mt-1 space-y-1">
      <p>{t('Basmodell / schemaläggare', 'Baseline / scheduler')}</p>
      <p>{t('Pool under 30°C', 'Pool below 30°C')}: {modeled.baselineService.belowPoolStartHours.toFixed(2)} / {modeled.schedulerService.belowPoolStartHours.toFixed(2)} h.</p>
      <p>{t('Pool vid slut', 'Ending pool temperature')}: {modeled.baselineService.endPoolC?.toFixed(2) ?? '—'} / {modeled.schedulerService.endPoolC?.toFixed(2) ?? '—'}°C.</p>
      <p>{t('Bilenergi vid slut', 'Ending car energy')}: {modeled.baselineService.endEvKwh?.toFixed(2) ?? '—'} / {modeled.schedulerService.endEvKwh?.toFixed(2) ?? '—'} kWh.</p>
      <p>{t('Batterienergi vid slut', 'Ending home battery energy')}: {modeled.baselineService.endBatteryKwh?.toFixed(2) ?? '—'} / {modeled.schedulerService.endBatteryKwh?.toFixed(2) ?? '—'} kWh.</p>
      <p>{t('Skillnad i kvarvarande energivärde', 'Difference in ending energy value')}: {sek(modeled.schedulerService.endCreditSek - modeled.baselineService.endCreditSek)}. {t('Ingår inte i besparing eller ROI.', 'Excluded from savings and ROI.')}</p>
    </div></details>
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

export function ReportSensitivity({ months, investmentSek, basis, billedMonths }: { months: MonthLedger[]; investmentSek: number; basis: RoiBasis; billedMonths: Set<string> }) {
  const { t } = useLanguage();
  if (!months.length) return null;
  const eligible = months.filter(m => basis === 'baseline' || billedMonths.has(m.month));
  const format = (value: number) => `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK${investmentSek > 0 ? ` (${(100 * value / investmentSek).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${t('procentenheter ROI', 'ROI percentage points')})` : ''}`;
  const variants = [{key: 'battery', value: 100, label: t('Fullt batteri vid start', 'Full battery at start')}, {key: 'ev', value: 20, label: t('Bil 20% vid start', 'Car 20% at start')}, {key: 'pool', value: 28, label: 'Pool 28°C'}, {key: 'pool', value: 30.5, label: 'Pool 30.5°C'}];
  return <details className="text-sm" data-testid="roi-assumption-impact"><summary className="cursor-pointer py-2">{t('Indata och påverkan på ROI', 'Inputs and impact on ROI')}</summary><div className="space-y-2 pb-2 text-xs text-muted-foreground">
    {variants.map(v => {
      const effects = eligible.flatMap(m => m.modeled.effects.filter(e => e.key === v.key && (v.key === 'battery' || e.value === v.value)));
      if (!effects.length) return null;
      const invalid = effects.some(e => e.error !== null);
      const delta = effects.reduce((n, e) => n + (basis === 'baseline' ? e.vsBaselineDeltaSek ?? 0 : e.vsActualDeltaSek ?? 0), 0);
      return <p key={`${v.key}:${v.value}`}>{v.label} ({effects.length} {t('månader', 'months')}): {invalid ? t('inte alla scenarier kunde beräknas', 'not all scenarios could be calculated') : format(delta)}.</p>;
    })}
    {eligible.some(m => m.recovery.hours > 0) && <p>{t('Timprisplacering med oförändrade flöden', 'Hourly price timing with fixed flows')}: {format(eligible.reduce((n, m) => n + (basis === 'baseline' ? m.modeled.timing.vsBaselineMinSek : m.modeled.timing.vsActualMinSek), 0))} – {format(eligible.reduce((n, m) => n + (basis === 'baseline' ? m.modeled.timing.vsBaselineMaxSek : m.modeled.timing.vsActualMaxSek), 0))}.</p>}
    <p>{t('Känslighetsmått, inte ett säkerhetsintervall. Saknad energi, dolda resor och fördelning inom timmarna har okänd påverkan. Fakturabeloppen påverkas inte av sensorgap.', 'Sensitivity measures, not a confidence interval. Missing energy, hidden trips and within-hour physical timing have unknown effects. Invoice totals are unaffected by sensor gaps.')}</p>
    <p>{t('Efterhandsanalysen använder perfekta prognoser. Kontrollera även temperaturer och kvarvarande energi i modelldetaljerna.', 'The hindsight replay uses perfect forecasts. Check temperatures and ending energy in model details too.')}</p>
  </div></details>;
}
