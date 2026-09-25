import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ArrowDownRight, ArrowUpRight, Loader2 } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { fetchEnergySupplierDailyCosts } from '@/lib/energy-tariff-storage';
import { fetchRoiInvoices, fetchRoiMonthlyPrices } from '@/lib/contract-roi-storage';
import { compareContract, invoiceRoiHistory, numericInput, supplierRoiHistory } from '@/lib/contract-roi';
import { useHomeTimeZone } from './HomeTimeZoneContext';
import ContractFields, { type ContractDraft } from './roi/ContractFields';
import { RoiNumberField, RoiSelect } from './roi/RoiFields';

const settingsSchema = z.object({
  source: z.enum(['ha', 'invoices']),
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
  source: 'ha', from: '', to: '', area: '', equipment: '50000', installation: '15000', subscription: '299', currentFee: '0',
  contract: { kind: 'fixed', method: 'quote', example: 'svealand-5', rate: '113.28', fee: '0', variableRate: '80.75', fixedShare: '50', markup: '0', monthlyMarkup: '0', markupUnit: 'percent' },
};

interface ROITabProps { customerId: string; homeId: string | null; homeCount?: number }

function RoiCalculator({ customerId, homeCount = 1 }: ROITabProps) {
  const { t } = useLanguage();
  const timeZone = useHomeTimeZone();
  const storageKey = `shs-contract-roi-v2:${customerId}`;
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = settingsSchema.safeParse(JSON.parse(saved));
        if (parsed.success) return parsed.data as Settings;
      }
    } catch { /* Browser storage can be unavailable; calculations remain usable. */ }
    return initialSettings;
  });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); setSaved(true); }
    catch { setSaved(false); }
  }, [settings, storageKey]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(s => ({ ...s, [key]: value }));
  const history = useQuery({
    queryKey: ['contract-roi-history', customerId, settings.source, timeZone],
    queryFn: async () => settings.source === 'ha'
      ? supplierRoiHistory(await fetchEnergySupplierDailyCosts(customerId), timeZone)
      : invoiceRoiHistory(await fetchRoiInvoices(customerId)),
    enabled: Boolean(customerId), staleTime: 60_000,
  });
  const allMonths = useMemo(() => history.data?.months ?? [], [history.data]);
  const latest = allMonths.at(-1)?.month ?? '';
  const defaultFrom = latest ? `${Number(latest.slice(0, 4)) - 1}-${latest.slice(5)}` : '';
  const from = settings.from || allMonths.find(m => m.month > defaultFrom)?.month || '';
  const to = settings.to || latest;
  const months = useMemo(() => allMonths.filter(m => m.month >= from && m.month <= to), [allMonths, from, to]);
  const draft = settings.contract;
  const market = useQuery({
    queryKey: ['roi-monthly-market', settings.area, months.map(m => m.month)],
    queryFn: () => fetchRoiMonthlyPrices(settings.area, months.map(m => m.month)),
    enabled: draft.kind === 'monthly' && Boolean(settings.area) && months.length > 0,
    staleTime: 60 * 60 * 1000, retry: false,
  });
  const number = (value: string) => numericInput(value) ?? NaN;
  const contract = {
    kind: draft.kind, method: draft.method,
    rateOre: draft.kind === 'monthly' || draft.method === 'profile' ? 0 : number(draft.rate),
    monthlyFeeSek: draft.kind === 'monthly' ? (draft.markupUnit === 'monthly' ? number(draft.monthlyMarkup) : 0) : draft.method === 'quote' ? 0 : number(draft.fee),
    monthlyMarkupPercent: draft.kind === 'monthly' && draft.markupUnit === 'percent' ? number(draft.monthlyMarkup) : 0,
    variableRateOre: draft.kind === 'mixed' && draft.method === 'components' ? number(draft.variableRate) : 0,
    fixedSharePercent: draft.kind === 'mixed' && draft.method === 'components' ? number(draft.fixedShare) : 0,
    markupDifferenceOre: draft.method === 'profile' ? number(draft.markup) : 0,
    monthlyRates: market.data ?? {},
  };
  const investment = {
    equipmentSek: number(settings.equipment), installationSek: number(settings.installation), subscriptionSek: number(settings.subscription),
    currentMonthlyFeeSek: settings.source === 'ha' ? number(settings.currentFee) : 0,
  };
  let invalid = false;
  let result: ReturnType<typeof compareContract> = null;
  const needsMarket = draft.kind === 'monthly';
  const marketReady = !needsMarket || (Boolean(settings.area) && market.isSuccess);
  try { if (marketReady) result = compareContract(months, contract, investment); }
  catch { invalid = true; }
  const sek = (value: number | null | undefined, digits = 0) => value == null ? '—' : `${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })} SEK`;
  const ready = history.isSuccess && !invalid && result !== null;
  const loss = ready && result.net < 0;
  const outcome = (value: number) => value < 0 ? t('Extra kostnad', 'Extra cost') : t('Sparat', 'Saved');
  const tone = !ready ? 'bg-muted border-border' : loss ? 'bg-warning/20 border-warning/50' : 'bg-energy/30 border-energy-dark/40';
  const changeSource = (value: string) => setSettings(s => ({ ...s, source: value as Settings['source'], from: '', to: '', contract: { ...s.contract, method: s.contract.method === 'profile' ? 'quote' : s.contract.method } }));

  return <div className="space-y-5" data-testid="contract-roi">
    <section className={`rounded-2xl border p-6 sm:p-8 ${tone}`} aria-label={t('Ditt resultat', 'Your result')} data-testid="roi-hero">
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-center">
        <div>
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            {loss ? <ArrowUpRight aria-hidden="true" className="h-5 w-5" /> : <ArrowDownRight aria-hidden="true" className="h-5 w-5" />}
            <span data-testid="roi-outcome">{ready ? loss ? t('Extra kostnad per månad', 'Extra cost per month') : t('Sparat per månad', 'Saved per month') : t('Din besparing', 'Your savings')}</span>
          </div>
          <p className="text-4xl font-semibold tracking-tight tabular-nums sm:text-6xl" data-testid="roi-monthly-net">{ready ? sek(result.annualNet / 12) : '—'}</p>
          <p className="mt-3 text-sm text-muted-foreground">{t('Efter abonnemang', 'After subscription')}{from && ` · ${from} – ${to}`}</p>
        </div>
        <div className="grid grid-cols-2 gap-5 border-t border-foreground/10 pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <div><p className="text-sm text-muted-foreground">{ready && loss ? t('Total extra kostnad', 'Total extra cost') : t('Totalt sparat', 'Total saved')}</p><p className="mt-2 text-2xl font-semibold tabular-nums" data-testid="roi-period-saving">{ready ? sek(result.net) : '—'}</p></div>
          <div><p className="text-sm text-muted-foreground">{t('Återbetalning', 'Payback')}</p><p className="mt-2 text-2xl font-semibold" data-testid="roi-payback">{!ready ? '—' : result.paybackYears === null ? t('Ingen', 'None') : `${result.paybackYears.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${t('år', 'yr')}`}</p></div>
        </div>
      </div>
    </section>

    <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-4">
      <RoiSelect id="roi-source" label={t('Förbrukning', 'Consumption')} value={settings.source} onChange={changeSource}>
        <option value="ha">Home Assistant</option><option value="invoices">{t('Elfakturor', 'Electricity bills')}</option>
      </RoiSelect>
      {[{ key: 'from' as const, label: t('Från', 'From'), value: from }, { key: 'to' as const, label: t('Till', 'To'), value: to }].map(field => <div className="space-y-2" key={field.key}>
        <Label htmlFor={`roi-${field.key}`}>{field.label}</Label><Input id={`roi-${field.key}`} className="h-11" type="month" value={field.value} onChange={e => set(field.key, e.target.value)} aria-invalid={from > to} />
      </div>)}
      {settings.source === 'ha' && <RoiNumberField id="roi-current-fee" label={t('Min elavgift (kr/månad)', 'My supplier fee (SEK/month)')} min={0} value={settings.currentFee} onChange={v => set('currentFee', v)} />}
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <span>{months.reduce((sum, m) => sum + m.days, 0)} {t('dygn', 'days')}</span>
      <span>{months.reduce((sum, m) => sum + m.importKwh, 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh</span>
      <span>{t('Inkl. moms', 'Incl. VAT')}</span>
      {homeCount > 1 && <span>{t('Hela kontot', 'Account-wide')}</span>}
      {!saved && <span>{t('Kan inte spara lokalt', 'Local saving unavailable')}</span>}
    </div>
    {history.isPending && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t('Laddar…', 'Loading…')}</p>}
    {history.isError && <Alert variant="destructive"><AlertTitle>{t('Kunde inte läsa elhistoriken', 'Could not load energy history')}</AlertTitle><Button variant="outline" className="mt-2" onClick={() => void history.refetch()}>{t('Försök igen', 'Retry')}</Button></Alert>}
    {from > to && <p role="alert" className="text-sm text-destructive">{t('Välj ett giltigt datumintervall.', 'Choose a valid date range.')}</p>}
    {invalid && <p role="alert" className="text-sm text-destructive">{t('Kontrollera markerade belopp.', 'Check highlighted amounts.')}</p>}
    {history.isSuccess && months.length === 0 && <p className="text-sm">{t('Välj en annan period eller lägg till elfakturor i Energihistorik.', 'Choose another period or add bills in Energy history.')}</p>}

    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Card><CardHeader className="pb-4"><CardTitle className="text-base">{t('Jämför avtal', 'Compare contract')}</CardTitle></CardHeader><CardContent>
        <ContractFields draft={settings.contract} onChange={v => set('contract', v)} source={settings.source} />
        {needsMarket && <div className="mt-4 space-y-3">
          <RoiSelect id="roi-area" label={t('Elområde', 'Price area')} value={settings.area} onChange={v => set('area', v)}><option value="">{t('Välj elområde', 'Choose area')}</option>{['SE1', 'SE2', 'SE3', 'SE4'].map(a => <option key={a}>{a}</option>)}</RoiSelect>
          <p className="text-xs text-muted-foreground">{market.isFetching ? t('Hämtar månadspriser…', 'Loading monthly prices…') : t('Månadsmedel + påslag', 'Monthly average + markup')}</p>
          {market.isError && <p role="alert" className="text-sm text-destructive">{t('Månadspriser saknas.', 'Monthly prices unavailable.')} <Button variant="link" onClick={() => void market.refetch()}>{t('Försök igen', 'Retry')}</Button></p>}
        </div>}
      </CardContent></Card>
      <div className="space-y-5">
        <Card><CardHeader className="pb-4"><CardTitle className="text-base">{t('Investering', 'Investment')}</CardTitle></CardHeader><CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2"><RoiNumberField id="roi-equipment" label={t('Utrustning (kr)', 'Equipment (SEK)')} min={0} value={settings.equipment} onChange={v => set('equipment', v)} /><RoiNumberField id="roi-installation" label={t('Installation (kr)', 'Installation (SEK)')} min={0} value={settings.installation} onChange={v => set('installation', v)} /></div>
          <RoiNumberField id="roi-subscription" label={t('Abonnemang (kr/månad)', 'Subscription (SEK/month)')} min={0} value={settings.subscription} onChange={v => set('subscription', v)} />
        </CardContent></Card>
        {ready && <Card><CardHeader className="pb-4"><CardTitle className="text-base">{t('Periodens kostnader', 'Period costs')}</CardTitle></CardHeader><CardContent>
          <dl className="space-y-3 text-sm">
            {[[t('Mitt elavtal', 'My electricity'), result.actual], [t('Abonnemang', 'Subscription'), result.subscription], [t('Jämförelseavtal', 'Comparison contract'), result.alternative]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt>{label}{Number(value) < 0 ? ` · ${t('tillgodo', 'credit')}` : ''}</dt><dd className="font-medium tabular-nums">{sek(Number(value), 2)}</dd></div>)}
            <div className="flex justify-between gap-4 border-t pt-3 font-semibold"><dt>{outcome(result.net)}</dt><dd>{sek(result.net, 2)}</dd></div>
          </dl>
        </CardContent></Card>}
      </div>
    </div>
    {ready && <details className="rounded-xl border bg-card px-5">
      <summary className="cursor-pointer py-4 text-sm font-medium">{t('Månadsöversikt & årsprognos', 'Monthly breakdown & annual estimate')}</summary>
      <div className="space-y-4 pb-5">
        <p className="text-sm">{result.annualNet < 0 ? t('Extra kostnad/år (prognos)', 'Extra cost/year (estimate)') : t('Sparat/år (prognos)', 'Saved/year (estimate)')}: <strong data-testid="roi-annual-net">{sek(result.annualNet)}</strong></p>
        <div className="overflow-x-auto"><table className="w-full text-right text-sm tabular-nums"><caption className="sr-only">{t('Månadskostnader', 'Monthly costs')}</caption><thead><tr className="border-b">{[t('Månad', 'Month'), 'kWh', t('Mitt avtal', 'My contract'), t('Jämförelse', 'Comparison'), t('Resultat', 'Result')].map(label => <th scope="col" className="p-2 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{result.months.map(m => <tr key={m.month} className="border-b"><th scope="row" className="whitespace-nowrap p-2 font-normal">{m.month}</th><td className="p-2">{m.importKwh.toFixed(1)}</td><td className="p-2">{sek(m.actual)}{m.actual < 0 ? ` (${t('tillgodo', 'credit')})` : ''}</td><td className="p-2">{sek(m.alternative)}{m.alternative < 0 ? ` (${t('tillgodo', 'credit')})` : ''}</td><td className="p-2">{outcome(m.net)} {sek(m.net)}</td></tr>)}</tbody></table></div>
        <p className="text-xs text-muted-foreground">{t('Samma kWh · Exkl. elnät · Årsprognos från vald period', 'Same kWh · Excl. grid fees · Annual estimate from selected period')}</p>
        {needsMarket && <a className="text-xs underline" href="https://www.elprisetjustnu.se/elpris-api" target="_blank" rel="noreferrer">{t('Priskälla · månadsmedel, pågående månad t.o.m. igår', 'Price source · monthly average, current month through yesterday')}</a>}
      </div>
    </details>}
  </div>;
}

export default function ROITab(props: ROITabProps) {
  return <RoiCalculator key={props.customerId} {...props} />;
}
