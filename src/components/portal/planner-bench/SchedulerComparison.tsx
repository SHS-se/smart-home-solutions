import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { DEFAULT_SETTINGS, subscriptionForCase, type DefaultSettings } from '@/lib/scheduler-comparison/comparison';
import { runComparison } from '@/lib/scheduler-comparison/browser';
import { fetchComparisonCases, fetchComparisonInput } from '@/lib/scheduler-comparison/storage';
import { benchDays, type BenchPeriod } from '@/lib/planner-bench/days';
import { downloadJson } from '@/lib/download-json';
import { HOUSEHOLD } from '@/lib/planner-bench/household';
import { formatHomeStamp } from '@/lib/energy-shift/home-time';
import BenchPlanChart from './BenchPlanChart';

/** The same case experiment in the bench and ROI; never combined with account-wide contract history. */
export default function SchedulerComparison({ monthlySubscriptionSek = 0 }: { monthlySubscriptionSek?: number }) {
  const { t } = useLanguage();
  const [caseId, setCaseId] = useState('');
  const [startC, setStartC] = useState(String(DEFAULT_SETTINGS.poolStartC));
  const [stopC, setStopC] = useState(String(DEFAULT_SETTINGS.poolStopC));
  const [batterySuppliesEv, setBatterySuppliesEv] = useState(DEFAULT_SETTINGS.batterySuppliesEv);
  const [submitted, setSubmitted] = useState<{ id: string; revision: string; settings: DefaultSettings; nonce: number } | null>(null);
  const [shown, setShown] = useState<'baseline' | 'shs'>('shs');
  const [period, setPeriod] = useState<BenchPeriod>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const cases = useQuery({ queryKey: ['scheduler-comparison', 'cases'], queryFn: fetchComparisonCases, staleTime: 30_000 });
  const available = cases.data?.filter(c => c.recorded_at) ?? [];
  const active = available.find(c => c.id === caseId) ?? available[0];
  const input = useQuery({
    queryKey: ['scheduler-comparison', 'input', active?.id, active?.revision],
    queryFn: () => fetchComparisonInput(active!.id, active!.revision), enabled: Boolean(active), staleTime: 0,
  });
  const output = useQuery({
    queryKey: ['scheduler-comparison', 'result', submitted, input.data],
    queryFn: ({ signal }) => runComparison({ ...input.data!, settings: submitted!.settings }, signal),
    enabled: Boolean(submitted && input.data && submitted.id === active?.id && submitted.revision === active?.revision),
    retry: false, staleTime: Infinity,
  });
  const reset = () => { setSubmitted(null); setSelected(null); setPeriod('all'); };
  const valid = startC.trim() !== '' && stopC.trim() !== '' && Number.isFinite(Number(startC)) && Number.isFinite(Number(stopC)) && Number(startC) < Number(stopC);
  const result = submitted ? output.data?.result : undefined;
  const scenario = input.data?.scenario;
  const sek = (v: number) => `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
  const fee = scenario && Number.isFinite(monthlySubscriptionSek) && monthlySubscriptionSek >= 0
    ? subscriptionForCase(scenario.start, scenario.timezone, 72, monthlySubscriptionSek) : null;
  const error = cases.error ?? input.error ?? (submitted ? output.error : null);
  const moneyRows = result ? [
    [t('Köpt el', 'Electricity imports'), result.baseline.ledger.importCostSek, result.shs.ledger.importCostSek],
    [t('Såld el (intäkt)', 'Electricity exports (revenue)'), result.baseline.ledger.exportRevenueSek, result.shs.ledger.exportRevenueSek],
    [t('Elkostnad efter export', 'Electricity cost after exports'), result.baseline.ledger.costSek, result.shs.ledger.costSek],
    [t('Slutenergi (värde, inte faktura)', 'End energy (value, not a bill)'), result.baseline.credit.credit_sek, result.shs.credit.credit_sek],
    [t('Slitage: batteri och värmepumpsstarter (estimat)', 'Wear: battery and heater starts (estimate)'), result.baseline.wearSek, result.shs.wearSek],
  ] as const : [];

  return <div className="space-y-5" data-testid="scheduler-comparison">
    <p className="text-sm text-muted-foreground">{t(
      '72-timmars testfall med bänkens referenshushåll. SHS planerar med sol-, förbruknings- och prisprognoser. Båda körs sedan mot samma uppmätta förbrukning, sol och priser. Ett planeringstillfälle, utan omplanering.',
      '72-hour test cases using the bench reference household. SHS plans with solar, load and price forecasts. Both then run against the same recorded load, solar and prices. One planning run, without replanning.')}</p>
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="space-y-2"><Label htmlFor="scheduler-case">{t('Testfall', 'Test case')}</Label>
        <select id="scheduler-case" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={active?.id ?? ''} disabled={!available.length} onChange={e => { reset(); setCaseId(e.target.value); }}>
          {!available.length && <option value="">{t('Inga uppmätta testfall', 'No recorded test cases')}</option>}
          {available.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="space-y-2"><Label htmlFor="scheduler-pool-start">{t('Pool start (°C)', 'Pool start (°C)')}</Label><Input id="scheduler-pool-start" type="number" step="0.1" value={startC} aria-invalid={!valid} onChange={e => { reset(); setStartC(e.target.value); }} /></div>
      <div className="space-y-2"><Label htmlFor="scheduler-pool-stop">{t('Pool stopp (°C)', 'Pool stop (°C)')}</Label><Input id="scheduler-pool-stop" type="number" step="0.1" value={stopC} aria-invalid={!valid} onChange={e => { reset(); setStopC(e.target.value); }} /></div>
    </div>
    <p className="text-sm">{t('Standard: maximal egenförbrukning · bil till 80 % från lokal midnatt · cirkulation 60 W, full pump vid uppvärmning.', 'Defaults: maximum self consumption · car to 80% from local midnight · circulation 60 W, full pump during heating.')}</p>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={batterySuppliesEv} onChange={e => { reset(); setBatterySuppliesEv(e.target.checked); }} />{t('Standardbatteriet får försörja bilen', 'Default battery may supply the car')}</label>
    <p className="text-xs text-muted-foreground">{t('Bilen är ansluten hela testfallet; inga resor antas. Första laddningen börjar vid nästa midnatt. SHS behåller testfallets komfortmål och regler.', 'The car stays connected throughout the case; no trips are assumed. First charging starts at the next midnight. SHS retains the case comfort targets and rules.')}</p>
    <div className="flex flex-wrap gap-2">
      <Button id="scheduler-run" disabled={!valid || !input.isSuccess || output.isFetching} onClick={() => {
        setSelected(null); setPeriod('all');
        setSubmitted({ id: active!.id, revision: active!.revision, settings: { poolStartC: Number(startC), poolStopC: Number(stopC), idlePumpW: 60, batterySuppliesEv }, nonce: Date.now() });
      }}>{output.isFetching ? t('Beräknar…', 'Calculating…') : t('Kör jämförelse', 'Run comparison')}</Button>
      {output.isFetching && <Button variant="outline" onClick={reset}>{t('Avbryt', 'Cancel')}</Button>}
    </div>
    {(cases.isFetching || input.isFetching) && <p role="status" className="text-sm">{t('Laddar testfall…', 'Loading test cases…')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t('Jämförelsen kunde inte beräknas', 'Could not calculate comparison')}: {error.message}</p>}
    {result && scenario && output.data && <>
      <Card><CardHeader><CardTitle className="text-base">{t('Besparing med schemaläggaren', 'Scheduler savings')} · {active!.name}</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{formatHomeStamp(scenario.start, scenario.timezone)} · 72 h · {scenario.timezone}</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><p className="text-sm text-muted-foreground">{t('Besparing på elräkningen', 'Electricity bill saving')}</p><p data-testid="scheduler-cash-saving" className="text-2xl font-semibold tabular-nums">{sek(result.cashSavingSek)}</p></div>
          <div><p className="text-sm text-muted-foreground">{t('SHS-abonnemang, endast testperioden', 'SHS subscription, case period only')}</p><p data-testid="scheduler-subscription" className="text-xl tabular-nums">{fee === null ? '—' : sek(fee)}</p></div>
          <div><p className="text-sm text-muted-foreground">{t('Efter abonnemang', 'After subscription')}</p><p data-testid="scheduler-net-saving" className="text-2xl font-semibold tabular-nums">{fee === null ? '—' : sek(result.cashSavingSek - fee)}</p></div>
        </div>
        <div className="overflow-x-auto"><table className="w-full text-right text-sm tabular-nums"><caption className="sr-only">{t('Jämförelsens kostnader', 'Comparison costs')}</caption>
          <thead><tr className="border-b"><th scope="col" className="py-2 text-left">{t('72 timmar', '72 hours')}</th><th scope="col" className="p-2">{t('Standard', 'Defaults')}</th><th scope="col" className="p-2">SHS</th></tr></thead>
          <tbody>{moneyRows.map(([label, b, s]) => <tr key={label} className="border-b"><th scope="row" className="py-2 text-left font-normal">{label}</th><td className="p-2 whitespace-nowrap">{sek(b)}</td><td className="p-2 whitespace-nowrap">{sek(s)}</td></tr>)}</tbody>
        </table></div>
        <p className="text-sm">{t('Besparing justerad för slutenergi', 'Saving adjusted for end energy')}: <strong>{sek(result.adjustedSavingSek)}</strong>. {t('Separat från fakturabesparingen och abonnemanget.', 'Separate from bill savings and subscription.')}</p>
        <p className="text-xs text-muted-foreground">{t('Positiv besparing betyder lägre kostnad med SHS. Slutenergi värderas med samma pris och tak för båda; slitage visas separat. Testfall överlappar och summeras inte eller räknas om till år.', 'Positive savings mean SHS costs less. End energy uses the same price and caps for both; wear is shown separately. Cases overlap and are neither summed nor annualised.')}</p>
        <div className="overflow-x-auto"><table className="w-full text-right text-sm tabular-nums"><caption className="py-2 text-left font-medium">{t('Komfort och slutläge', 'Service and ending state')}</caption>
          <thead><tr className="border-b"><th scope="col" className="text-left">{t('Mått', 'Measure')}</th><th scope="col">{t('Standard', 'Defaults')}</th><th scope="col">SHS</th></tr></thead>
          <tbody>{([
            [t('Lägsta pooltemperatur (°C)', 'Minimum pool temperature (°C)'), result.baseline.poolMinimumC, result.shs.poolMinimumC],
            [t('Kvartar under start, timmar', 'Quarters below start, hours'), result.baseline.poolBelowStartHours, result.shs.poolBelowStartHours],
            [t('Pool vid slutet (°C)', 'Ending pool temperature (°C)'), result.baseline.series.poolC.at(-1)!, result.shs.series.poolC.at(-1)!],
            [t('Bil vid slutet (%)', 'Ending car SOC (%)'), result.baseline.evEndSoc, result.shs.evEndSoc],
            [t('Batteri vid slutet (%)', 'Ending battery SOC (%)'), result.baseline.batteryEndSoc, result.shs.batteryEndSoc],
          ] as const).map(([label, b, s]) => <tr key={label} className="border-b"><th scope="row" className="py-2 text-left font-normal">{label}</th><td className="p-2">{b.toFixed(2)}</td><td className="p-2">{s.toFixed(2)}</td></tr>)}</tbody>
        </table></div>
        <p className="text-xs text-muted-foreground">{t('SHS-mål', 'SHS targets')}: {result.poolTargetC}°C · {result.evTargetKm} km · {t('bilens laddtak', 'car charge limit')} {result.evChargeLimitSoc * 100}%. {t('Standardmål: poolens termostatband och 80 % bil. Skillnader i komfort måste vägas in när besparingen bedöms.', 'Default targets: pool thermostat band and 80% car SOC. Consider differences in service when evaluating savings.')}</p>
      </CardContent></Card>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('Visa drift', 'Show operation')}>
        {(['baseline', 'shs'] as const).map(key => <Button key={key} variant={shown === key ? 'default' : 'outline'} aria-pressed={shown === key} onClick={() => setShown(key)}>{key === 'shs' ? 'SHS' : t('Standard', 'Defaults')}</Button>)}
        <Button variant="outline" onClick={() => downloadJson(`scheduler-comparison-${active!.id}.json`, {
          format: 'shs-scheduler-comparison', buildCommit: __GIT_COMMIT__, engineHash: output.data!.engineHash,
          case: { id: active!.id, revision: active!.revision, name: active!.name },
          input: input.data, household: HOUSEHOLD, result, monthlySubscriptionSek, subscriptionSek: fee,
        })}>{t('Exportera beräkning', 'Export calculation')}</Button>
      </div>
      <BenchPlanChart series={result[shown].series} compared={{ current: result.baseline.series, test: result.shs.series }} names={{ current: t('Standard', 'Defaults'), test: 'SHS' }}
        timeZone={scenario.timezone} audit={null} showAudit={false} idPrefix="scheduler" selected={selected} onSelect={setSelected}
        days={benchDays(result.shs.series.start, scenario.timezone)} period={period} onPeriod={setPeriod}
        scoreDetail={selected === null ? <p className="text-sm text-muted-foreground">{t('Välj en kvart för att granska indata och kostnad.', 'Select a quarter to inspect inputs and cost.')}</p> : <div data-testid="scheduler-quarter" className="space-y-2 text-sm">
          <p className="font-medium">{formatHomeStamp(result.shs.series.start[selected], scenario.timezone)}</p>
          <p>{t('Inköpspris: prognos / uppmätt', 'Import price: forecast / recorded')}: {result.forecastImportPrices[selected].toFixed(4)} / {result.shs.series.importPrice[selected].toFixed(4)} SEK/kWh</p>
          <p>{t('Sol: prognos / uppmätt', 'Solar: forecast / recorded')}: {result.forecastSolarW[selected].toFixed(0)} / {result.shs.series.solarW[selected].toFixed(0)} W</p>
          <p>{t('Elkostnad: standard / SHS', 'Electricity cost: defaults / SHS')}: {sek(result.baseline.series.costSek[selected])} / {sek(result.shs.series.costSek[selected])}</p>
        </div>} />
      <p className="break-all font-mono text-xs text-muted-foreground">v{result.version} · {t('Indata', 'Input')} {result.inputHash} · {t('Motor', 'Engine')} {output.data.engineHash}</p>
    </>}
  </div>;
}
