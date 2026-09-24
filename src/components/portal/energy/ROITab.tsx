import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { fetchEnergySupplierDailyCosts } from '@/lib/energy-tariff-storage';
import { fetchRoiInvoices } from '@/lib/contract-roi-storage';
import { compareContract, invoiceRoiHistory, numericInput, supplierRoiHistory } from '@/lib/contract-roi';
import { useHomeTimeZone } from './HomeTimeZoneContext';
import ContractFields, { type ContractDraft } from './roi/ContractFields';
import { RoiNumberField, RoiSelect } from './roi/RoiFields';

const settingsSchema = z.object({
  source: z.enum(['ha', 'invoices']),
  from: z.string(), to: z.string(),
  equipment: z.string(), installation: z.string(), subscription: z.string(), currentFee: z.string(),
  contract: z.object({
    kind: z.enum(['fixed', 'monthly', 'quarterly', 'mixed']),
    method: z.enum(['quote', 'components', 'profile']),
    example: z.string(), rate: z.string(), fee: z.string(), variableRate: z.string(), fixedShare: z.string(), markup: z.string(),
    monthlyRates: z.record(z.string()),
  }),
});
type Settings = Required<Omit<z.infer<typeof settingsSchema>, 'contract'>> & { contract: ContractDraft };
const initialSettings: Settings = {
  source: 'ha', from: '', to: '', equipment: '50000', installation: '15000', subscription: '299', currentFee: '0',
  contract: { kind: 'fixed', method: 'quote', example: 'svealand-5', rate: '113.28', fee: '0', variableRate: '80.75', fixedShare: '50', markup: '0', monthlyRates: {} },
};

interface ROITabProps { customerId: string; homeId: string | null; homeCount?: number }

function RoiCalculator({ customerId, homeCount = 1 }: ROITabProps) {
  const { t } = useLanguage();
  const timeZone = useHomeTimeZone();
  const storageKey = `shs-contract-roi-v1:${customerId}`;
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
  const number = (value: string) => numericInput(value) ?? NaN;
  const contract = {
    kind: draft.kind, method: draft.method,
    rateOre: draft.method === 'profile' ? 0 : number(draft.rate),
    monthlyFeeSek: draft.method === 'quote' ? 0 : number(draft.fee),
    variableRateOre: draft.kind === 'mixed' && draft.method === 'components' ? number(draft.variableRate) : 0,
    fixedSharePercent: draft.kind === 'mixed' && draft.method === 'components' ? number(draft.fixedShare) : 0,
    markupDifferenceOre: draft.method === 'profile' ? number(draft.markup) : 0,
    monthlyRates: draft.kind === 'monthly' ? Object.fromEntries(months.filter(m => draft.monthlyRates[m.month] !== undefined).map(m => [m.month, number(draft.monthlyRates[m.month])])) : {},
  };
  const investment = {
    equipmentSek: number(settings.equipment), installationSek: number(settings.installation), subscriptionSek: number(settings.subscription),
    currentMonthlyFeeSek: settings.source === 'ha' ? number(settings.currentFee) : 0,
  };
  let invalid = false;
  let result: ReturnType<typeof compareContract> = null;
  try { result = compareContract(months, contract, investment); }
  catch { invalid = true; }
  const sek = (value: number | null | undefined, digits = 0) => value == null ? '—' : `${value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })} SEK`;
  const actualLabel = settings.source === 'ha' ? t('Min beräknade elkostnad', 'My calculated electricity cost') : t('Min fakturerade elkostnad', 'My billed electricity cost');

  return <div className="space-y-6" data-testid="contract-roi">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">{t('Vad tjänar du på ditt elavtal?', 'How much does your electricity contract save?')}</h2>
        <p className="text-muted-foreground">{t('Jämför din verkliga förbrukning med ett annat avtal och se när utrustningen har betalat sig.', 'Compare your real consumption with another contract and see when your equipment pays for itself.')}</p>
      </div>
      <Badge variant="outline" className="py-2">{t('Uppmätt förbrukning', 'Measured consumption')}</Badge>
    </div>
    {homeCount > 1 && <Alert><AlertTitle>{t('Kontogemensamt underlag', 'Account-wide history')}</AlertTitle><AlertDescription>{t('Elhistoriken är kopplad till kundkontot, inte till valt hem. Jämförelsen omfattar kontots lagrade underlag och ändras inte med hemväljaren.', 'Energy history belongs to the customer account, not the selected home. This comparison uses the account’s stored history and does not change with the home selector.')}</AlertDescription></Alert>}

    <Card>
      <CardHeader><CardTitle className="text-base">{t('1. Ditt underlag', '1. Your history')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <RoiSelect id="roi-source" label={t('Datakälla', 'Data source')} value={settings.source} onChange={value => setSettings(s => ({ ...s, source: value as Settings['source'], from: '', to: '', contract: { ...s.contract, method: s.contract.method === 'profile' ? 'quote' : s.contract.method } }))}>
            <option value="ha">{t('Home Assistant · beräknad kostnad', 'Home Assistant · calculated cost')}</option>
            <option value="invoices">{t('Importerade elfakturor', 'Imported electricity bills')}</option>
          </RoiSelect>
          {[{ key: 'from' as const, label: t('Från månad', 'From month'), value: from }, { key: 'to' as const, label: t('Till månad', 'To month'), value: to }].map(field => <div className="space-y-2" key={field.key}>
            <Label htmlFor={`roi-${field.key}`}>{field.label}</Label>
            <Input id={`roi-${field.key}`} className="h-11" type="month" value={field.value} onChange={e => set(field.key, e.target.value)} aria-invalid={from > to} />
          </div>)}
        </div>
        {from > to && <p role="alert" className="text-sm text-destructive">{t('Startmånaden måste vara före slutmånaden.', 'The start month must be before the end month.')}</p>}
        <p className="text-sm leading-relaxed text-muted-foreground">{settings.source === 'ha'
          ? t('HA-underlaget använder uppmätt import och timmedel av leverantörspriser inklusive moms och påslag. Endast helt prissatta dygn ingår. Månadsavgiften läggs till nedan.', 'HA history uses measured imports and hourly averages of supplier prices including VAT and markup. Only fully priced days are included. Add the supplier monthly fee below.')
          : t('Hela månader från dina importerade elfakturor, inklusive moms och leverantörsavgifter. Exportersättning räknas bort från jämförelsen. Delvis täckta eller överlappande fakturamånader utesluts.', 'Full months from your imported electricity bills, including VAT and supplier fees. Export credits are removed from the comparison. Partial or overlapping invoice months are excluded.')}</p>
        {history.isPending ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t('Laddar elhistorik…', 'Loading energy history…')}</p>
          : history.isError ? <Alert variant="destructive"><AlertTitle>{t('Kunde inte läsa elhistoriken', 'Could not load energy history')}</AlertTitle><AlertDescription>{t('Inga resultat visas förrän underlaget kan läsas.', 'Results are unavailable until history can be loaded.')} <Button variant="outline" className="ml-2 min-h-11" onClick={() => void history.refetch()}>{t('Försök igen', 'Retry')}</Button></AlertDescription></Alert>
          : <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span><strong className="tabular-nums">{months.reduce((sum, m) => sum + m.days, 0)}</strong> {t('täckta dygn', 'covered days')}</span>
            <span><strong className="tabular-nums">{months.reduce((sum, m) => sum + m.importKwh, 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh</strong> {t('importerat', 'imported')}</span>
            <span className="text-muted-foreground">{t(`${history.data?.excluded ?? 0} ofullständiga/överlappande ${settings.source === 'ha' ? 'dygn' : 'månader'} uteslutna i källan`, `${history.data?.excluded ?? 0} incomplete/overlapping ${settings.source === 'ha' ? 'days' : 'months'} excluded from the source`)}</span>
          </div>}
        {settings.source === 'ha' && <div className="max-w-sm"><RoiNumberField id="roi-current-fee" label={t('Min leverantörs månadsavgift (SEK inkl. moms)', 'My supplier monthly fee (SEK incl. VAT)')} min={0} value={settings.currentFee} onChange={v => set('currentFee', v)} hint={t('Ange avgiften från ditt avtal. 0 betyder ingen avgift. Samma avgift används för hela perioden.', 'Enter the fee from your contract. 0 means no fee. The same fee applies throughout the period.')} /></div>}
      </CardContent>
    </Card>

    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.55fr)]">
      <div className="min-w-0 space-y-6">
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ArrowRightLeft aria-hidden="true" className="h-4 w-4" />{t('2. Avtalet att jämföra med', '2. Compare another contract')}</CardTitle></CardHeader>
          <CardContent><ContractFields draft={settings.contract} onChange={v => set('contract', v)} months={months.map(m => m.month)} source={settings.source} /></CardContent>
        </Card>
        <Card><CardHeader><CardTitle className="text-base">{t('3. Din investering', '3. Your investment')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('Startvärdena är exempel. Ange dina kostnader inklusive moms. Abonnemanget avser planeringstjänsten, utöver elavtalets avgift.', 'Starting values are examples. Enter your costs including VAT. The subscription is for the planning service, in addition to your electricity supplier’s fee.')}</p>
            <RoiNumberField id="roi-equipment" label={t('Utrustning (SEK)', 'Equipment (SEK)')} min={0} value={settings.equipment} onChange={v => set('equipment', v)} />
            <RoiNumberField id="roi-installation" label={t('Installation (SEK)', 'Installation (SEK)')} min={0} value={settings.installation} onChange={v => set('installation', v)} />
            <RoiNumberField id="roi-subscription" label={t('Planeringsabonnemang (SEK/månad)', 'Planning subscription (SEK/month)')} min={0} value={settings.subscription} onChange={v => set('subscription', v)} />
            <p className="text-sm text-muted-foreground">{saved ? t('Dina val sparas i den här webbläsaren.', 'Your choices are saved in this browser.') : t('Dina val kan inte sparas i den här webbläsaren.', 'Your choices cannot be saved in this browser.')}</p>
          </CardContent>
        </Card>
      </div>

      <div className="min-w-0 space-y-6">
        {history.isSuccess && !invalid && result ? <>
          <Card className="border-primary/30 bg-primary/5"><CardContent className="space-y-5 pt-6">
            <p className="text-sm font-medium">{t('Skillnad under vald period', 'Difference over the selected period')} · {from} — {to}</p>
            <div><p className="text-4xl font-semibold tabular-nums tracking-tight" data-testid="roi-period-saving">{sek(result.saving)}</p>
              <p className="mt-2 text-sm">{result.saving >= 0 ? t('lägre elkostnad med mitt nuvarande avtal', 'lower electricity cost with my current contract') : t('högre elkostnad med mitt nuvarande avtal', 'higher electricity cost with my current contract')}</p></div>
            <dl className="space-y-3 text-sm">
              {[[actualLabel, result.actual], [t('Jämförelseavtal, samma kWh', 'Comparison contract, same kWh'), result.alternative], [t('Planeringsabonnemang för perioden', 'Planning subscription for the period'), result.subscription], [t('Min nettobesparing', 'My net saving'), result.net]].map(([label, value]) => <div key={label} className="flex items-start justify-between gap-4 border-t pt-3"><dt>{label}</dt><dd className="shrink-0 font-medium tabular-nums">{sek(value as number, 2)}</dd></div>)}
            </dl>
          </CardContent></Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card><CardContent className="space-y-2 pt-6"><p className="text-sm text-muted-foreground">{t('Netto per år om takten håller', 'Annual net if this rate holds')}</p><p className="text-2xl font-semibold tabular-nums" data-testid="roi-annual-net">{sek(result.annualNet)}</p><p className="text-sm text-muted-foreground">{t('Efter planeringsabonnemang', 'After the planning subscription')}</p></CardContent></Card>
            <Card><CardContent className="space-y-2 pt-6"><p className="text-sm text-muted-foreground">{t('Återbetalningstid', 'Equipment payback')}</p><p className="text-2xl font-semibold tabular-nums" data-testid="roi-payback">{result.paybackYears === null ? t('Ingen återbetalning', 'No payback') : `${result.paybackYears.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${t('år', 'years')}`}</p><p className="text-sm text-muted-foreground">{result.paybackYears === null ? t('Besparingen täcker inte löpande kostnader.', 'Savings do not cover running costs.') : `${sek(result.investmentSek)} ${t('i utrustning och installation', 'in equipment and installation')}`}</p></CardContent></Card>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('Årstakten är periodens netto dividerat med täckta månadsandelar × 12. Säsong, framtida priser och avtalets löptid kan ändra återbetalningen. Ingen ränta, värdeminskning eller underhåll ingår.', 'The annual rate is the period’s net saving divided by covered month fractions × 12. Seasons, future prices and contract expiry can change payback. Financing, depreciation and maintenance are not included.')}</p>
          <Card><CardHeader><CardTitle className="text-base">{t('Kostnad månad för månad', 'Cost by month')}</CardTitle></CardHeader><CardContent>
            <div className="h-64 overflow-hidden" aria-hidden="true"><ResponsiveContainer width="100%" height="100%"><BarChart data={result.months} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} /><YAxis width={55} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(value: number) => sek(value, 2)} /><Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar isAnimationActive={false} dataKey="actual" name={t('Mitt avtal', 'My contract')} fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              <Bar isAnimationActive={false} dataKey="alternative" name={t('Jämförelse', 'Comparison')} fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} />
            </BarChart></ResponsiveContainer></div>
            <details className="mt-4"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t('Visa värden och täckning', 'Show values and coverage')}</summary>
              <div className="overflow-x-auto"><table className="w-full text-right text-sm tabular-nums"><caption className="sr-only">{t('Månadskostnader i SEK', 'Monthly costs in SEK')}</caption><thead><tr className="border-b">
                {[t('Månad', 'Month'), t('Dygn', 'Days'), 'kWh', t('Mitt avtal', 'My contract'), t('Jämförelse', 'Comparison'), t('Netto', 'Net')].map(label => <th scope="col" className="p-2 font-medium" key={label}>{label}</th>)}
              </tr></thead><tbody>{result.months.map(m => <tr key={m.month} className="border-b"><th scope="row" className="whitespace-nowrap p-2 font-normal">{m.month}</th><td className="p-2">{m.days}</td><td className="p-2">{m.importKwh.toFixed(1)}</td><td className="p-2">{m.actual.toFixed(2)}</td><td className="p-2">{m.alternative.toFixed(2)}</td><td className="p-2">{m.net.toFixed(2)}</td></tr>)}</tbody></table></div>
            </details>
          </CardContent></Card>
          <Card><CardContent className="space-y-2 pt-6"><p className="font-medium">{t('Vilket jämförpris måste du slå?', 'What comparison price do you need to beat?')}</p><p className="text-2xl font-semibold tabular-nums">{result.breakEvenOre === null ? '—' : `${result.breakEvenOre.toFixed(2)} öre/kWh`}</p><p className="text-sm text-muted-foreground">{t('Vid detta effektiva pris inklusive avgifter täcker skillnaden precis ditt planeringsabonnemang. Utrustningen kräver ytterligare besparing.', 'At this effective rate including fees, the difference just covers your planning subscription. Equipment needs additional savings.')}</p></CardContent></Card>
        </> : <Card><CardContent className="py-12"><h3 className="font-semibold">{invalid ? t('Kontrollera dina belopp', 'Check your amounts') : t('Lägg till ett jämförbart underlag', 'Add comparable history')}</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{invalid ? t('Rätta de markerade fälten för att beräkna lönsamheten.', 'Correct the highlighted fields to calculate ROI.') : t('Välj en period med helt prissatta HA-dygn eller hela fakturamånader. Du kan importera elfakturor under Energihistorik → Data, eller låta HA synka förbrukning och leverantörspriser.', 'Choose a period with fully priced HA days or complete invoice months. Import electricity bills in Energy history → Data, or let HA sync consumption and supplier prices.')}</p></CardContent></Card>}
      </div>
    </div>
    <Alert><AlertTitle>{t('Vad jämförelsen visar', 'What this comparison measures')}</AlertTitle><AlertDescription className="max-w-5xl leading-relaxed">{t(
      'Båda avtalen använder samma uppmätta nätimport. Elnätsavgifter, energiskatt och exportintäkter hålls lika och ingår inte i skillnaden. Använd elhandelspriser inklusive moms. Detta visar avtalsskillnaden för din faktiska drift, inte hur huset hade förbrukat utan utrustning eller planering. Återbetalningen förutsätter att hela den beräknade nettoskillnaden används för investeringen.',
      'Both contracts use the same measured grid imports. Grid fees, energy tax and export revenue are held equal and do not enter the difference. Use electricity supply prices including VAT. This measures the contract difference for your actual operation, not how the home would have consumed without equipment or planning. Payback assumes the entire calculated net difference goes towards the investment.',
    )}</AlertDescription></Alert>
  </div>;
}

export default function ROITab(props: ROITabProps) {
  return <RoiCalculator key={props.customerId} {...props} />;
}
