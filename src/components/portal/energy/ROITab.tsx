import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { fetchRoiMonthlyPrices } from '@/lib/contract-roi-storage';
import { numericInput, type ComparisonContract } from '@/lib/contract-roi';
import { roiReport } from '@/lib/home-baseline/roi-report';
import { localDay } from '../../../../supabase/functions/_shared/planner-wasm/calendar';
import HomeBaselineViewer from './roi/HomeBaselineViewer';
import SchedulerMonthlySavings from './roi/SchedulerMonthlySavings';
import { createCaptureSource } from '@/lib/home-baseline/source';
import { createBaselineSession } from '@/lib/home-baseline/session';
import { createSavingsRun } from '@/lib/home-baseline/savings-run';
import { generateHomeBaseline } from '@/lib/home-baseline/browser';
import { resolveBaselineAnchor } from '@/lib/home-baseline/history';
import { monthStore } from '@/lib/home-baseline/month-store';
import { hasAssumptions } from '@/lib/home-baseline/evidence';
import { ReportSensitivity } from './roi/ComparisonEvidence';
import { formatHomeDateTime } from '@/lib/energy-shift/home-time';
import ContractFields, { type ContractDraft } from './roi/ContractFields';
import { RoiNumberField, RoiSelect } from './roi/RoiFields';
import { ROI_SUPPLIER_TERMS } from '../../../../supabase/functions/_shared/roi-supplier-terms';

const settingsSchema = z.object({
  from: z.string(), to: z.string(), area: z.string(),
  equipment: z.string(), installation: z.string(), subscription: z.string(), currentFee: z.string(),
  contract: z.object({
    kind: z.enum(['fixed', 'monthly', 'quarterly', 'mixed']),
    method: z.enum(['quote', 'components', 'profile']),
    example: z.string(), rate: z.string(), fee: z.string(), variableRate: z.string(), fixedShare: z.string(), markup: z.string(),
    monthlyMarkup: z.string(), markupUnit: z.enum(['percent', 'monthly']),
  }),
});
type Settings = Required<Omit<z.infer<typeof settingsSchema>, 'contract'>> & { contract: ContractDraft };
const initialSettings: Settings = {
  from: '', to: '', area: '', equipment: '50000', installation: '15000', subscription: '299', currentFee: '0',
  contract: { kind: 'fixed', method: 'quote', example: 'svealand-5', rate: '113.28', fee: '0', variableRate: '80.75', fixedShare: '50', markup: '0', monthlyMarkup: '0', markupUnit: 'percent' },
};

const shiftMonth = (key: string, offset: number) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)) - 1 + offset, 1)).toISOString().slice(0, 7);

interface ROITabProps { customerId: string; homeId: string | null; homeCount?: number }

function RoiCalculator({ customerId, homeId }: ROITabProps) {
  const { t } = useLanguage();
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
  const displayState = state.rangeKey === `${from}|${to}` ? state : { ...state, rows: [], error: null };
  const months = state.rangeKey === `${from}|${to}` ? state.rows.flatMap(row => row.status === 'done' ? [row.ledger] : []) : [];
  const draft = settings.contract, area = months[0]?.priceArea || settings.area;
  const market = useQuery({ queryKey: ['roi-monthly-market', area, months.map(m => m.month)], queryFn: () => fetchRoiMonthlyPrices(area, months.map(m => m.month)),
    enabled: draft.kind === 'monthly' && !!area && months.length > 0 && !state.running, staleTime: 3_600_000, retry: false });
  const n = (value: string) => numericInput(value) ?? NaN;
  const contract: ComparisonContract | null = draft.kind === 'monthly' && !market.isSuccess ? null : {
    kind: draft.kind, method: draft.method, rateOre: draft.kind === 'monthly' || draft.method === 'profile' ? 0 : n(draft.rate),
    monthlyFeeSek: draft.kind === 'monthly' ? draft.markupUnit === 'monthly' ? n(draft.monthlyMarkup) : 0 : draft.method === 'quote' ? 0 : n(draft.fee),
    monthlyMarkupPercent: draft.kind === 'monthly' && draft.markupUnit === 'percent' ? n(draft.monthlyMarkup) : 0,
    variableRateOre: draft.kind === 'mixed' && draft.method === 'components' ? n(draft.variableRate) : 0,
    fixedSharePercent: draft.kind === 'mixed' && draft.method === 'components' ? n(draft.fixedShare) : 0,
    markupDifferenceOre: draft.method === 'profile' ? n(draft.markup) : 0, monthlyRates: market.data ?? {},
  };
  let report: ReturnType<typeof roiReport> | null = null;
  let invalid = false;
  try { report = roiReport(months, contract, { equipmentSek: n(settings.equipment), installationSek: n(settings.installation), subscriptionSek: n(settings.subscription), currentMonthlyFeeSek: n(settings.currentFee) }); }
  catch { invalid = true; }
  const ready = report && report.rows.length > 0;
  const amount = (v: number | null | undefined, unit = 'SEK', digits = 2) => v == null ? '—' : `${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`;
  const [graphOpen, setGraphOpen] = useState(false);
  useEffect(() => { setGraphOpen(false); }, [homeId]);
  const estimates = months.filter(hasAssumptions).length;

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
    <section className={`rounded-xl border p-5 sm:p-6 ${ready && report.netSek < 0 ? 'border-amber-200 bg-amber-50' : 'bg-energy/20'}`} data-testid="roi-hero" aria-label={t('Lönsamhet', 'ROI')}>
      <p className="text-sm font-medium">{t('SHS-besparing efter abonnemang', 'SHS savings after subscription')}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums" data-testid="roi-period-net">{ready ? amount(report.netSek) : '—'}</p>
      <dl className="mt-5 grid gap-4 sm:grid-cols-3 text-sm">
        <div><dt className="text-muted-foreground">{t('Per månad', 'Per month')}</dt><dd className="mt-1 font-medium" data-testid="roi-monthly-net">{ready ? amount(report.monthlyNetSek) : '—'}</dd></div>
        <div><dt className="text-muted-foreground">{t('Avkastning under perioden', 'Return over period')}</dt><dd className="mt-1 font-medium" data-testid="roi-return">{ready ? amount(report.roiPercent, '%', 1) : '—'}</dd></div>
        <div><dt className="text-muted-foreground">{t('Återbetalning vid denna månadsbesparing', 'Payback at this monthly saving')}</dt><dd className="mt-1 font-medium" data-testid="roi-payback">{ready && report.paybackMonths !== null ? amount(report.paybackMonths, t('månader', 'months'), 1) : '—'}</dd></div>
      </dl>
      {ready && <p className="mt-4 text-xs text-muted-foreground">{report.rows.length}/{state.rows.length} {t('månader beräknade', 'months calculated')}{estimates > 0 && ` · ${estimates} ${t('med antaganden', 'with assumptions')}`}</p>}
    </section>
    <Card data-testid="comparison-monthly"><CardHeader className="flex-row flex-wrap items-center justify-between gap-3"><CardTitle className="text-lg">{t('Jämförelse och besparing', 'Comparison and savings')}</CardTitle>
      {state.running ? <Button variant="outline" onClick={baseline.savings.cancel} data-testid="scheduler-calculate"><Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />{t('Avbryt', 'Cancel')}</Button>
        : <Button variant="outline" className="min-h-11" disabled={!homeId || !state.rows.length} onClick={() => { setGraphOpen(false); void baseline.savings.calculate(true); }} data-testid="scheduler-calculate">{t('Beräkna om', 'Recalculate')}</Button>}
    </CardHeader><CardContent className="space-y-3">
      <SchedulerMonthlySavings state={displayState} report={report} onOpenMonth={month => { setGraphOpen(true); void baseline.viewer.showMonth(month); }} />
      <p className="text-xs text-muted-foreground" data-testid="roi-supplier-basis">{t('Båda alternativen prissätts med nuvarande Tibber-villkor för alla månader.', 'Both alternatives use current Tibber terms for every month.')}</p>
      <ReportSensitivity months={months} investmentSek={n(settings.equipment) + n(settings.installation)} />
      {baseline.source.modelCapturedAt() && months[0] && <p className="text-xs text-muted-foreground">{t('Sparad utrustningsmodell', 'Saved equipment model')}: {formatHomeDateTime(baseline.source.modelCapturedAt()!, months[0].timeZone)}.</p>}
      <p className="text-xs text-muted-foreground">{t('Samma hem och uppmätta period. Avtalsbesparing redovisas separat och ingår inte i SHS netto.', 'Same home and recorded period. Contract savings are separate and excluded from SHS net.')}</p>
    </CardContent></Card>
    <details className="rounded-xl border bg-card px-5" data-testid="comparison-settings"><summary className="cursor-pointer py-4 text-sm font-medium">{t('Kostnader och jämförelseavtal', 'Costs and comparison contract')}</summary>
      <div className="space-y-1 pb-4 text-xs text-muted-foreground" data-testid="roi-supplier-terms">
        <p>Tibber · {t('Fast påslag', 'Fixed markup')}: {amount(ROI_SUPPLIER_TERMS.definition.import.fixed_markup_sek_per_kwh_ex_vat * (1 + ROI_SUPPLIER_TERMS.definition.vat_rate) * 100, t('öre/kWh', 'öre/kWh'))} · {t('Rörlig inköpskostnad', 'Variable purchasing cost')}: {amount(ROI_SUPPLIER_TERMS.definition.import.variable_cost_sek_per_kwh_ex_vat * (1 + ROI_SUPPLIER_TERMS.definition.vat_rate) * 100, t('öre/kWh', 'öre/kWh'))} · {t('inkl. moms', 'incl. VAT')}.</p>
        <p>{t('Senast publicerade inköpskostnad', 'Latest published purchasing cost')}: {ROI_SUPPLIER_TERMS.variableCostMonth} · <a className="underline" href={ROI_SUPPLIER_TERMS.sourceUrl} target="_blank" rel="noreferrer">{t('Tibbers villkor', 'Tibber terms')}</a> · {t('kontrollerade', 'checked')} {ROI_SUPPLIER_TERMS.verifiedOn}.</p>
      </div>
      <div className="grid gap-6 pb-5 lg:grid-cols-2"><div className="grid content-start gap-4 sm:grid-cols-2">
        <RoiNumberField id="roi-equipment" label={t('Utrustning (kr)', 'Equipment (SEK)')} min={0} value={settings.equipment} onChange={v => set('equipment', v)} />
        <RoiNumberField id="roi-installation" label={t('Installation (kr)', 'Installation (SEK)')} min={0} value={settings.installation} onChange={v => set('installation', v)} />
        <RoiNumberField id="roi-subscription" label={t('SHS-abonnemang (kr/månad)', 'SHS subscription (SEK/month)')} min={0} value={settings.subscription} onChange={v => set('subscription', v)} />
        <RoiNumberField id="roi-current-fee" label={t('Leverantörsavgift (kr/månad)', 'Supplier fee (SEK/month)')} min={0} value={settings.currentFee} onChange={v => set('currentFee', v)} />
      </div><div><ContractFields draft={settings.contract} onChange={v => set('contract', v)} />
        {draft.kind === 'monthly' && !months[0]?.priceArea && <RoiSelect id="roi-area" label={t('Elområde', 'Price area')} value={settings.area} onChange={v => set('area', v)}><option value="">{t('Välj område', 'Choose area')}</option>{['SE1', 'SE2', 'SE3', 'SE4'].map(a => <option key={a}>{a}</option>)}</RoiSelect>}
        {market.isError && draft.kind === 'monthly' && <p role="alert" className="text-sm text-destructive">{t('Månadspriser saknas.', 'Monthly prices unavailable.')} <Button variant="link" onClick={() => void market.refetch()}>{t('Försök igen', 'Retry')}</Button></p>}
      </div></div>
    </details>
    {!graphOpen && <Button variant="outline" className="min-h-11" disabled={!homeId} onClick={() => { setGraphOpen(true); void baseline.viewer.generate(); }} data-testid="roi-view-graphs">{t('Visa grafer', 'View graphs')}</Button>}
    {graphOpen && <HomeBaselineViewer session={baseline.viewer} homeId={homeId} subscriptionSek={numericInput(settings.subscription)} currentFeeSek={numericInput(settings.currentFee) ?? 0} onClose={() => setGraphOpen(false)} />}
  </div>;
}
export default function ROITab(props: ROITabProps) { return <RoiCalculator key={props.customerId} {...props} />; }
