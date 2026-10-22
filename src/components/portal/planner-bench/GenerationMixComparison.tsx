import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RefreshCw, Loader2 } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { formatHomeStamp } from '@/lib/energy-shift/home-time';
import { pricePairChartRows, pricePairDays, type PricePairComparison, type PricePairScore } from '@/lib/planner-bench/price-pair-comparison';

const db = supabase as unknown as SupabaseClient;
const TZ = 'Europe/Stockholm';
const price = (value: number | null) => value === null ? '—' : value.toFixed(3);
const SERIES = [
  { key: 'actual', sv: 'Publicerat pris', en: 'Published price', colour: 'hsl(var(--foreground))', dash: undefined },
  { key: 'reduced', sv: 'Utan produktionsmix', en: 'Without generation mix', colour: 'var(--plan-solar)', dash: '8 5' },
  { key: 'full', sv: 'Med full produktionsmix', en: 'With full generation mix', colour: 'var(--plan-grid)', dash: '2 3' },
] as const;

const HorizonScore: React.FC<{ lead: number; score?: PricePairScore }> = ({ lead, score }) => {
  const { t } = useLanguage();
  const change = score ? score.reduced_mae - score.full_mae : null;
  const percent = score && score.reduced_mae > 0 ? Math.abs((change ?? 0) / score.reduced_mae) * 100 : null;
  return <Card data-testid={`mix-score-${lead}`}>
    <CardHeader className="pb-3"><CardTitle className="text-base">{t(`${lead} dagar framåt`, `${lead} days ahead`)} · D+{lead}</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      {!score ? <p role="status" className="text-sm text-muted-foreground">{t('Väntar på publicerade priser.', 'Waiting for published prices.')}</p> : <>
        <p className="text-sm font-medium" data-testid="mix-verdict">
          {change === 0 ? t('Samma genomsnittliga fel hittills', 'Same average error so far')
            : change! > 0 ? t('Full mix har lägre fel hittills', 'Full mix has lower error so far')
              : t('Full mix har högre fel hittills', 'Full mix has higher error so far')}
        </p>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-muted-foreground">{t('Utan mix', 'Without mix')}</dt><dd className="mt-1 text-xl font-semibold tabular-nums" data-testid="mix-reduced-mae">{price(score.reduced_mae)}</dd></div>
          <div><dt className="text-muted-foreground">{t('Med full mix', 'With full mix')}</dt><dd className="mt-1 text-xl font-semibold tabular-nums" data-testid="mix-full-mae">{price(score.full_mae)}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">{t('Genomsnittligt absolut fel (MAE), kr/kWh. Lägre är bättre.', 'Mean absolute error (MAE), SEK/kWh. Lower is better.')}</p>
        {change !== 0 && <p className="text-sm tabular-nums">{t('Skillnad', 'Difference')}: {price(Math.abs(change!))} kr/kWh{percent === null ? '' : ` · ${percent.toFixed(1)}% ${change! > 0 ? t('lägre fel', 'lower error') : t('högre fel', 'higher error')}`}</p>}
        <p className="text-sm text-muted-foreground">{t(`${score.scored_quarters} bedömda kvartar · ${score.target_day_count} unika måldagar · ${score.origin_count} prognospar`,
          `${score.scored_quarters} scored quarters · ${score.target_day_count} distinct target days · ${score.origin_count} forecast pairs`)}</p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1 text-sm">{t('Nivå och riktning på felet', 'Price level and direction of error')}</summary>
          <p className="mt-2">{t('Dagens medelpris, absolut fel: utan / med mix', 'Daily mean price, absolute error: without / with mix')}: {price(score.reduced_daily_mean_mae)} / {price(score.full_daily_mean_mae)} kr/kWh.</p>
          <p className="mt-1">{t('Medelfel: utan / med mix (plus = för högt)', 'Bias: without / with mix (positive = too high)')}: {price(score.reduced_bias)} / {price(score.full_bias)} kr/kWh.</p>
          <p className="mt-1">{t(`${score.complete_day_origins} av ${score.scored_day_origins} bedömda dag/prognospar täcker ett helt dygn.`, `${score.complete_day_origins} of ${score.scored_day_origins} scored day/forecast pairs cover a full day.`)}</p>
        </details>
      </>}
    </CardContent>
  </Card>;
};

const GenerationMixComparison: React.FC = () => {
  const { t, language } = useLanguage();
  const [params, setParams] = useSearchParams();
  const pairId = params.get('pair');
  const query = useQuery({
    queryKey: ['test-price-pair-comparison', pairId],
    queryFn: async () => {
      const { data, error } = await db.rpc('get_test_price_pair_comparison', { p_pair_id: pairId });
      if (error) throw new Error(error.message);
      return data as PricePairComparison;
    },
    retry: false, staleTime: 30_000, refetchInterval: 60_000,
  });
  const data = query.data;
  const targets = data?.targets;
  const days = useMemo(() => pricePairDays(targets ?? []), [targets]);
  const chart = useMemo(() => pricePairChartRows(targets ?? []), [targets]);
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const stamp = (at: string) => formatHomeStamp(at, TZ);
  const detailTime = (at: number) => new Intl.DateTimeFormat(locale, { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' }).format(at);
  const dayLabel = (day: string) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${day}T12:00Z`));
  const scored = targets?.filter(row => row.actual !== null).length ?? 0;
  const selected = data?.selected;
  const pairOptions = data ? [...data.report.pairs,
    ...(selected && !data.report.pairs.some(pair => pair.id === selected.id) ? [{ ...selected, scored_count: scored }] : [])] : [];
  const selectPair = (id: string) => {
    const next = new URLSearchParams(params); next.set('pair', id); setParams(next, { replace: true });
  };
  return <section data-testid="generation-mix-comparison" className="space-y-5" aria-labelledby="mix-comparison-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl space-y-2">
        <h2 id="mix-comparison-title" className="text-xl font-semibold">{t('Blir prisprognosen bättre med produktionsmixen?', 'Does the generation mix improve price forecasts?')}</h2>
        <p className="text-sm text-muted-foreground">{t('Samma modell och historik, med eller utan prognoser för vind, sol, vattenkraft, kärnkraft, gas och övrig produktion. Båda bedöms på exakt samma kvartar när priserna publiceras.',
          'The same model and history, with or without forecasts for wind, solar, hydro, nuclear, gas and other generation. Both are scored on exactly the same quarters as prices are published.')}</p>
      </div>
      <Button variant="outline" className="min-h-11" disabled={query.isFetching} onClick={() => void query.refetch()}>
        <RefreshCw aria-hidden="true" className={`mr-2 h-4 w-4 ${query.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} />{t('Uppdatera', 'Refresh')}
      </Button>
    </div>
    {query.isLoading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t('Laddar jämförelser…', 'Loading comparisons…')}</p>}
    {query.isError && <Alert variant="destructive"><AlertDescription>{t('Kunde inte hämta jämförelsen. Försök uppdatera igen.', 'Could not load the comparison. Try refreshing again.')}</AlertDescription></Alert>}
    {data && <>
      {!data.enabled ? <Alert><AlertDescription>{t('Studien är inte aktiverad i TEST.', 'The study is not enabled in TEST.')}</AlertDescription></Alert> : <>
        <p className="text-xs text-muted-foreground">TEST · SE3 · {data.home_name} · {t('Senast hämtad', 'Last checked')} {stamp(data.updated_at)} · {t('Uppdateras varje minut', 'Refreshes every minute')}</p>
        <div className="grid gap-4 md:grid-cols-2">{[2, 3].map(lead => <HorizonScore key={lead} lead={lead} score={data.report.scores.find(row => row.lead_day === lead)} />)}</div>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('Resultaten ovan gäller alla sparade prognospar. Tidiga resultat visar bara felet hittills. Kvartar från samma dag och överlappande prognoser är beroende av varandra; många unika dagar behövs för en säker slutsats. D+3 kan täcka en del av dagen.',
          'The results above cover all saved forecast pairs. Early results show only the error so far. Quarters from the same day and overlapping forecasts are related; many distinct days are needed for a reliable conclusion. D+3 can cover part of a day.')}</p>
        {!selected ? <p role="status" className="rounded-md border p-4 text-sm">{t('Inga prognospar har sparats ännu. Nya par sparas efter varje ny produktionsprognos.', 'No forecast pairs saved yet. A new pair is saved after each new generation forecast.')}</p> : <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <CardTitle className="text-lg">{t('Ett sparat prognospar', 'One saved forecast pair')}</CardTitle>
              <div className="w-full sm:w-80">
                <label htmlFor="mix-pair-select" className="mb-1 block text-sm">{t('Prognos gjord', 'Forecast made')}</label>
                <Select value={selected.id} onValueChange={selectPair}>
                  <SelectTrigger id="mix-pair-select" className="min-h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>{pairOptions.map(pair => <SelectItem key={pair.id} value={pair.id}>{stamp(pair.saved_at ?? pair.reserved_at)} · {pair.status === 'pending' ? t('beräknas', 'calculating') : pair.status === 'unavailable' ? t('saknar underlag', 'unavailable') : t(`${pair.scored_count}/${pair.eligible_count} bedömda`, `${pair.scored_count}/${pair.eligible_count} scored`)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-sm text-muted-foreground" role="status" data-testid="mix-coverage">{t(`${scored} av ${selected.eligible_count} kvartar bedömda · ${selected.eligible_count - scored} väntar på publicerade priser`, `${scored} of ${selected.eligible_count} quarters scored · ${selected.eligible_count - scored} awaiting published prices`)}</p>
            {data.report.pair_count > data.report.pairs.length && <p className="text-xs text-muted-foreground">{t('Välj bland de senaste 100 paren. Sammanfattningen omfattar hela studien.', 'Choose from the latest 100 pairs. The summary includes the whole study.')}</p>}
          </CardHeader>
          <CardContent className="space-y-4">
            {selected.status !== 'paired' && <Alert><AlertDescription>{selected.status === 'pending' ? t('Prognosparet beräknas. Vyn uppdateras automatiskt.', 'This forecast pair is being calculated. The view refreshes automatically.') : t('Underlag saknas för ett komplett prognospar.', 'Inputs are missing for a complete forecast pair.')}{selected.reason && <p className="mt-1">{selected.reason}</p>}</AlertDescription></Alert>}
            {targets && targets.length > 0 && <>
              <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label={t('Teckenförklaring', 'Legend')}>
                {SERIES.map(series => <li key={series.key} className="flex items-center gap-2"><svg width="30" height="12" aria-hidden="true"><line x1="0" x2="30" y1="6" y2="6" stroke={series.colour} strokeWidth="2" strokeDasharray={series.dash} /></svg>{t(series.sv, series.en)}</li>)}
              </ul>
              <div className="h-[300px] min-w-0" data-testid="mix-price-chart" aria-label={t('Prisprognoser och publicerade priser, kr/kWh', 'Price forecasts and published prices, SEK/kWh')}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} accessibilityLayer margin={{ top: 15, right: 12, bottom: 5, left: 5 }}>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} scale="time" tickCount={5} minTickGap={30} stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={at => new Intl.DateTimeFormat(locale, { timeZone: TZ, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at)} />
                    <YAxis width={45} stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} domain={['auto', 'auto']} tickFormatter={value => value.toFixed(1)} />
                    <Tooltip labelFormatter={label => detailTime(Number(label))} formatter={(value: number, name: string) => [`${price(value)} kr/kWh`, name]} contentStyle={{ backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))', borderColor: 'hsl(var(--border))', borderRadius: 6, fontSize: 12 }} />
                    {SERIES.map(series => <Line key={series.key} dataKey={series.key} name={t(series.sv, series.en)} type="stepAfter" stroke={series.colour} strokeDasharray={series.dash} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground">{t('Importpris inklusive avgifter, kr/kWh. Stockholmstid. Luckor är saknade värden; inga priser har fyllts i.', 'All-in import price, SEK/kWh. Stockholm time. Gaps are missing values; no prices have been filled in.')}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums" data-testid="mix-days">
                  <caption className="sr-only">{t('Fel per måldag för valt prognospar', 'Error per target day for the selected pair')}</caption>
                  <thead className="text-muted-foreground"><tr>{[t('Måldag', 'Target day'), t('Bedömt', 'Scored'), t('Utan mix, MAE', 'Without mix, MAE'), t('Med mix, MAE', 'With mix, MAE')].map(title => <th scope="col" key={title} className="whitespace-nowrap px-2 py-2 text-left font-medium first:pl-0">{title}</th>)}</tr></thead>
                  <tbody>{days.map(day => <tr key={day.day} className="border-t"><th scope="row" className="py-3 pr-2 text-left font-normal">{dayLabel(day.day)} · D+{day.leadDay}{day.eligible < day.expected && <span className="block text-xs text-muted-foreground">{t(`${day.eligible}/${day.expected} kvartar i dygnet`, `${day.eligible}/${day.expected} quarters of the day`)}</span>}</th><td className="px-2 py-3">{day.scored}/{day.eligible}</td><td className="px-2 py-3">{price(day.reducedMae)}</td><td className="px-2 py-3">{price(day.fullMae)}</td></tr>)}</tbody>
                </table>
              </div>
              <details className="rounded-md border p-3 text-sm">
                <summary className="cursor-pointer">{t('Visa alla kvartsvärden', 'Show all quarter values')}</summary>
                <div className="mt-3 max-h-80 overflow-auto"><table className="w-full whitespace-nowrap text-sm tabular-nums"><caption className="sr-only">{t('Prognoser och publicerade priser per kvart', 'Forecasts and published prices per quarter')}</caption><thead><tr>{[t('Tid', 'Time'), t('Utan mix', 'Without mix'), t('Med mix', 'With mix'), t('Publicerat', 'Published')].map(title => <th scope="col" key={title} className="px-2 py-2 text-left font-medium">{title}</th>)}</tr></thead><tbody>{targets.map(row => <tr key={row.start} className="border-t"><th scope="row" className="px-2 py-2 text-left font-normal">{detailTime(Date.parse(row.start))}</th><td className="px-2 py-2">{price(row.reduced)}</td><td className="px-2 py-2">{price(row.full)}</td><td className="px-2 py-2">{row.actual === null ? t('väntar', 'waiting') : price(row.actual)}</td></tr>)}</tbody></table></div>
              </details>
            </>}
            <p className="max-w-3xl text-sm text-muted-foreground">{t('Endast framtida kvartar vars priser ännu var okända när prognosparet sparades visas och bedöms. Båda prognoserna är låsta; korrigerade publicerade priser uppdaterar bedömningen. Detta är en separat TEST-studie.', 'Only future quarters whose prices were still unknown when the pair was saved are shown and scored. Both forecasts are frozen; corrected published prices update the scores. This is a separate TEST study.')}</p>
          </CardContent>
        </Card>}
      </>}
    </>}
  </section>;
};
export default GenerationMixComparison;
