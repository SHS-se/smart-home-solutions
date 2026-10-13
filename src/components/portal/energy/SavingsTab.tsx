import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { fetchEnergyBillingDocuments, toEnergyBillingSeriesDocuments } from '@/lib/energy-billing-storage';
import { billedMonths } from '@/lib/home-baseline/billed-months';
import { numericInput } from '@/lib/contract-roi';
import { billedRecord, savingsForecast } from '@/lib/home-baseline/savings-report';
import { localDay } from '../../../../supabase/functions/_shared/planner-wasm/calendar';
import HomeBaselineViewer from './roi/HomeBaselineViewer';
import ForecastTable from './roi/ForecastTable';
import BilledMonthsTable from './roi/BilledMonthsTable';
import { createCaptureSource } from '@/lib/home-baseline/source';
import { createBaselineSession } from '@/lib/home-baseline/session';
import { createSavingsRun } from '@/lib/home-baseline/savings-run';
import { generateHomeBaseline } from '@/lib/home-baseline/browser';
import { resolveBaselineAnchor } from '@/lib/home-baseline/history';
import { monthStore } from '@/lib/home-baseline/month-store';
import { RoiNumberField } from './roi/RoiFields';
import { sek } from './roi/format';
import { fetchRoiInstallations } from '@/lib/home-baseline/installations';
import { DEFAULT_SETTINGS } from '@/lib/home-baseline/controller';
import { ROI_SUPPLIER_TERMS } from '../../../../supabase/functions/_shared/roi-supplier-terms';

const settingsSchema = z.object({ from: z.string(), to: z.string(), subscription: z.string() });
type Settings = z.infer<typeof settingsSchema>;
const initialSettings: Settings = { from: '', to: '', subscription: '299' };

const shiftMonth = (key: string, offset: number) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)) - 1 + offset, 1)).toISOString().slice(0, 7);

interface SavingsTabProps { customerId: string; homeId: string | null; homeCount?: number }

function SavingsEstimate({ customerId, homeId, homeCount = 1 }: SavingsTabProps) {
  const { t, language } = useLanguage();
  const baseline = useMemo(() => {
    const source = createCaptureSource(homeId ? { customerId, homeId } : null, { resolveAnchor: resolveBaselineAnchor, generate: generateHomeBaseline, store: monthStore });
    return { source, viewer: createBaselineSession(source), savings: createSavingsRun(source) };
  }, [customerId, homeId]);
  useEffect(() => () => { baseline.viewer.dispose(); baseline.savings.dispose(); baseline.source.dispose(); }, [baseline]);
  const storageKey = `shs-contract-roi-v2:${customerId}`;
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) { const parsed = settingsSchema.safeParse(JSON.parse(saved)); if (parsed.success) return parsed.data as Settings; }
    } catch { /* Browser storage can be unavailable; calculations remain usable. */ }
    return initialSettings;
  });
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Calculation works without storage. */ } }, [settings, storageKey]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(s => ({ ...s, [key]: value }));
  const anchor = useQuery({ queryKey: ['roi-home-anchor', customerId, homeId], queryFn: () => baseline.source.anchor(), enabled: !!homeId, retry: false });
  const latest = anchor.data ? localDay(new Date(Date.parse(anchor.data.latestEnd) - 900_000).toISOString(), anchor.data.snapshot.timezone).slice(0, 7) : '';
  const earliest = anchor.data ? localDay(anchor.data.earliestStart, anchor.data.snapshot.timezone).slice(0, 7) : '';
  const twelveBack = latest ? shiftMonth(latest, -11) : '';
  const from = settings.from || (earliest > twelveBack ? earliest : twelveBack), to = settings.to || latest;
  const state = useSyncExternalStore(baseline.savings.subscribe, baseline.savings.snapshot);
  useEffect(() => {
    if (!from || !to || !homeId) return;
    baseline.savings.setRange(from, to); void baseline.savings.calculate();
    return () => baseline.savings.cancel();
  }, [baseline, from, to, homeId]);
  const oreIncVat = (sekPerKwhExVat: number) => `${(sekPerKwhExVat * (1 + ROI_SUPPLIER_TERMS.definition.vat_rate) * 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${t('öre/kWh', 'öre/kWh')}`;
  const displayState = state.rangeKey === `${from}|${to}` ? state : { ...state, rows: [], error: null };
  const months = state.rangeKey === `${from}|${to}` ? state.rows.flatMap(row => row.status === 'done' ? [row.ledger] : []) : [];
  // Deployment retries can add bills while this tab is open. Refresh only invoice
  // evidence: saved baseline/scheduler ledgers and their generation stay untouched.
  const invoices = useQuery({ queryKey: ['energy-billing-documents', customerId], queryFn: () => fetchEnergyBillingDocuments(customerId), retry: false, refetchInterval: 30_000 });
  const bills = useMemo(() => billedMonths(toEnergyBillingSeriesDocuments(invoices.data ?? []), homeCount), [invoices.data, homeCount]);
  let forecast: ReturnType<typeof savingsForecast> | null = null;
  let invalid = false;
  try { forecast = savingsForecast(months, numericInput(settings.subscription) ?? NaN); }
  catch { invalid = true; }
  const ready = forecast && forecast.rows.length > 0;
  const record = useMemo(() => billedRecord(displayState.rows.map(row => row.month), bills), [displayState.rows, bills]);
  const monthName = (key: string) => new Intl.DateTimeFormat(language === 'sv' ? 'sv-SE' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`));
  // Without SHS the pool runs on a plain thermostat; with SHS it follows the comfort target. Both are stated.
  const pool = anchor.data?.snapshot.capabilities.pool ? anchor.data.snapshot.comfort?.pool ?? null : null;
  const celsius = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const poolAssumption = !pool ? null : pool.target_c >= DEFAULT_SETTINGS.poolStartC && pool.target_c <= DEFAULT_SETTINGS.poolStopC
    ? t(`Poolen hålls vid ${celsius(pool.target_c)} °C alla månader`, `Pool kept at ${celsius(pool.target_c)} °C every month`)
    : t(`Pool alla månader: ${celsius(DEFAULT_SETTINGS.poolStartC)}–${celsius(DEFAULT_SETTINGS.poolStopC)} °C utan SHS, ${celsius(pool.target_c)} °C med SHS`,
      `Pool every month: ${celsius(DEFAULT_SETTINGS.poolStartC)}–${celsius(DEFAULT_SETTINGS.poolStopC)} °C without SHS, ${celsius(pool.target_c)} °C with SHS`);
  const assumptions = [t('Din nuvarande utrustning', 'Your current equipment'),
    ...(from && to ? [t(`Väder, förbrukning och priser från ${monthName(from)} – ${monthName(to)}`, `Weather, consumption and prices from ${monthName(from)} – ${monthName(to)}`)] : []),
    ...(poolAssumption ? [poolAssumption] : [])];
  const [graphOpen, setGraphOpen] = useState(false);
  useEffect(() => { setGraphOpen(false); }, [homeId]);
  const installations = useQuery({ queryKey: ['roi-installations', customerId, homeId],
    queryFn: () => fetchRoiInstallations({ customerId, homeId: homeId! }), enabled: !!homeId, retry: false });

  return <div className="space-y-5" data-testid="contract-roi">
    <div className="flex flex-wrap items-end gap-4">
      {[{ key: 'from' as const, label: t('Från', 'From'), value: from }, { key: 'to' as const, label: t('Till', 'To'), value: to }].map(field => <div className="space-y-2" key={field.key}>
        <Label htmlFor={`roi-${field.key}`}>{field.label}</Label><Input id={`roi-${field.key}`} className="h-11" type="month" value={field.value} min={field.key === 'to' ? from : to ? shiftMonth(to, -11) : undefined} max={field.key === 'from' ? to : latest && from ? [latest, shiftMonth(from, 11)].sort()[0] : latest} onChange={e => set(field.key, e.target.value)} />
      </div>)}
      <span className="pb-3 text-sm text-muted-foreground">{t('Högst 12 månader', 'Up to 12 months')} · {t('inkl. moms', 'incl. VAT')}</span>
    </div>
    {!homeId && <p>{t('Välj ett hem.', 'Select a home.')}</p>}
    {anchor.isError && <p role="alert" className="text-sm text-destructive">{anchor.error.message}</p>}
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {invalid && <p role="alert" className="text-sm text-destructive">{t('Kontrollera beloppen i inställningarna.', 'Check the amounts in settings.')}</p>}
    <section className={`rounded-xl border p-5 sm:p-6 ${ready && forecast.netSek < 0 ? 'border-amber-200 bg-amber-50' : 'bg-energy/20'}`} data-testid="roi-hero" aria-label={t('Uppskattad besparing', 'Estimated saving')}>
      <p className="text-sm font-medium">{t('Uppskattad besparing efter SHS-abonnemang', 'Estimated saving after the SHS subscription')}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums" data-testid="roi-period-net">{ready ? sek(forecast.netSek) : '—'}</p>
      <dl className="mt-5 grid gap-4 sm:grid-cols-3 text-sm">
        <div><dt className="text-muted-foreground">{t('Per månad', 'Per month')}</dt><dd className="mt-1 font-medium" data-testid="roi-monthly-net">{ready ? sek(forecast.monthlyNetSek) : '—'}</dd></div>
        <div><dt className="text-muted-foreground">{t('Före abonnemang', 'Before subscription')}</dt><dd className="mt-1 font-medium" data-testid="roi-gross">{ready ? sek(forecast.savingSek) : '—'}</dd></div>
        <div><dt className="text-muted-foreground">{t('Abonnemang', 'Subscription')}</dt><dd className="mt-1 font-medium" data-testid="roi-subscription-cost">{ready ? sek(forecast.subscriptionSek) : '—'}</dd></div>
      </dl>
      <ul className="mt-5 flex flex-wrap gap-2 text-xs" data-testid="savings-assumptions" aria-label={t('Antaganden', 'Assumptions')}>
        {assumptions.map(text => <li key={text} className="rounded-md border bg-background/70 px-2.5 py-1 text-muted-foreground">{text}</li>)}
      </ul>
      {ready && <p className="mt-4 text-xs text-muted-foreground">{forecast.rows.length}/{state.rows.length} {t('månader beräknade', 'months calculated')}</p>}
    </section>
    <Card data-testid="comparison-monthly"><CardHeader className="flex-row flex-wrap items-center justify-between gap-3"><CardTitle className="text-lg">{t('Månad för månad', 'Month by month')}</CardTitle>
      {state.running ? <Button variant="outline" onClick={baseline.savings.cancel} data-testid="scheduler-calculate"><Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />{t('Avbryt', 'Cancel')}</Button>
        : <Button variant="outline" className="min-h-11" disabled={!homeId || !state.rows.length} onClick={() => { setGraphOpen(false); void baseline.savings.calculate(true); }} data-testid="scheduler-calculate">{t('Beräkna om', 'Recalculate')}</Button>}
    </CardHeader><CardContent className="space-y-3">
      <ForecastTable state={displayState} forecast={forecast} onOpenMonth={month => { setGraphOpen(true); void baseline.viewer.showMonth(month); }} />
      <p className="text-xs text-muted-foreground">{t('Ingen av kolumnerna innehåller effektavgiften.', 'Neither column includes the demand charge.')}</p>
    </CardContent></Card>
    {installations.isError && <p role="alert" className="text-sm text-destructive">{installations.error.message}</p>}
    {invoices.isError && <p role="alert" className="text-sm text-destructive">{invoices.error.message}</p>}
    <details className="rounded-xl border bg-card px-5" data-testid="what-happened"><summary className="cursor-pointer py-4 text-sm font-medium">{t('Vad som hände: dina fakturor', 'What happened: your bills')}</summary>
      <div className="space-y-3 pb-5">
        <BilledMonthsTable record={record} installations={installations.data ?? []} />
        <p className="text-xs text-muted-foreground">{t('Fakturorna innehåller alla avgifter på el- och nätfakturorna, även effektavgiften, och speglar den utrustning du hade då. Saknade fakturor visas som —.', 'Bills include every charge on the electricity and grid invoices, including the demand charge, and reflect the equipment you had at the time. Missing bills show —.')}</p>
      </div>
    </details>
    <details className="rounded-xl border bg-card px-5" data-testid="comparison-settings"><summary className="cursor-pointer py-4 text-sm font-medium">{t('Priser i beräkningen', 'Prices used')}</summary>
      <div className="space-y-1 pb-4 text-xs text-muted-foreground" data-testid="roi-supplier-terms">
        <p>Tibber · {t('Fast påslag', 'Fixed markup')}: {oreIncVat(ROI_SUPPLIER_TERMS.definition.import.fixed_markup_sek_per_kwh_ex_vat)} · {t('Rörlig inköpskostnad', 'Variable purchasing cost')}: {oreIncVat(ROI_SUPPLIER_TERMS.definition.import.variable_cost_sek_per_kwh_ex_vat)} · {t('inkl. moms', 'incl. VAT')}.</p>
        <p>{t('Senast publicerade inköpskostnad', 'Latest published purchasing cost')}: {ROI_SUPPLIER_TERMS.variableCostMonth} · <a className="underline" href={ROI_SUPPLIER_TERMS.sourceUrl} target="_blank" rel="noreferrer">{t('Tibbers villkor', 'Tibber terms')}</a> · {t('kontrollerade', 'checked')} {ROI_SUPPLIER_TERMS.verifiedOn}.</p>
      </div>
      <div className="max-w-xs pb-5">
        <RoiNumberField id="roi-subscription" label={t('SHS-abonnemang (kr/månad)', 'SHS subscription (SEK/month)')} min={0} value={settings.subscription} onChange={v => set('subscription', v)} />
      </div>
    </details>
    {!graphOpen && <Button variant="outline" className="min-h-11" disabled={!homeId} onClick={() => { setGraphOpen(true); void baseline.viewer.generate(); }} data-testid="roi-view-graphs">{t('Visa grafer', 'View graphs')}</Button>}
    {graphOpen && <HomeBaselineViewer session={baseline.viewer} homeId={homeId} bills={bills} onClose={() => setGraphOpen(false)} />}
  </div>;
}
export default function SavingsTab(props: SavingsTabProps) { return <SavingsEstimate key={props.customerId} {...props} />; }
