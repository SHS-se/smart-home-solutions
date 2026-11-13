import Se3MarketHistory from './Se3MarketHistory';
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
import { pricePairChartRows, pricePairDays, weatherPriceCriterion, type PricePairComparison, type PricePairScore } from '@/lib/planner-bench/price-pair-comparison';

const db = supabase as unknown as SupabaseClient;
const TZ = 'Europe/Stockholm';
const price = (value: number | null) => value === null ? '—' : value.toFixed(3);
const MIX_SERIES = [
  { key: 'actual', sv: 'Publicerat pris', en: 'Published price', colour: 'hsl(var(--foreground))', dash: undefined },
  { key: 'reduced', sv: 'Utan produktionsmix', en: 'Without generation mix', colour: 'var(--plan-solar)', dash: '8 5' },
  { key: 'full', sv: 'Med full produktionsmix', en: 'With full generation mix', colour: 'var(--plan-grid)', dash: '2 3' },
] as const;

interface ArmLabels { baseline: string; corrected: string; lowError: string; highError: string }
const HorizonScore: React.FC<{ lead: number; score?: PricePairScore; labels: ArmLabels; id?: string }> = ({ lead, score, labels, id = 'mix-score' }) => {
  const { t } = useLanguage();
  const change = score ? score.reduced_mae - score.full_mae : null;
  const percent = score && score.reduced_mae > 0 ? Math.abs((change ?? 0) / score.reduced_mae) * 100 : null;
  return <Card data-testid={`${id}-${lead}`}>
    <CardHeader className="pb-3"><CardTitle className="text-base">{t(`${lead} dagar framåt`, `${lead} days ahead`)} · D+{lead}</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      {!score ? <p role="status" className="text-sm text-muted-foreground">{t('Väntar på publicerade priser.', 'Waiting for published prices.')}</p> : <>
        <p className="text-sm font-medium" data-testid="mix-verdict">
          {change === 0 ? t('Samma genomsnittliga fel hittills', 'Same average error so far')
            : change! > 0 ? labels.lowError
              : labels.highError}
        </p>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-muted-foreground">{labels.baseline}</dt><dd className="mt-1 text-xl font-semibold tabular-nums" data-testid="mix-reduced-mae">{price(score.reduced_mae)}</dd></div>
          <div><dt className="text-muted-foreground">{labels.corrected}</dt><dd className="mt-1 text-xl font-semibold tabular-nums" data-testid="mix-full-mae">{price(score.full_mae)}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">{t('Genomsnittligt absolut fel (MAE), kr/kWh. Lägre är bättre.', 'Mean absolute error (MAE), SEK/kWh. Lower is better.')}</p>
        {change !== 0 && <p className="text-sm tabular-nums">{t('Skillnad', 'Difference')}: {price(Math.abs(change!))} kr/kWh{percent === null ? '' : ` · ${percent.toFixed(1)}% ${change! > 0 ? t('lägre fel', 'lower error') : t('högre fel', 'higher error')}`}</p>}
        <p className="text-sm text-muted-foreground">{t(`${score.scored_quarters} bedömda kvartar · ${score.target_day_count} unika måldagar · ${score.origin_count} prognospar`,
          `${score.scored_quarters} scored quarters · ${score.target_day_count} distinct target days · ${score.origin_count} forecast pairs`)}</p>
        {score.day_wins !== undefined && score.baseline_quarters !== undefined && <p className="text-sm tabular-nums" data-testid={`${id}-days-${lead}`}>{t(
          `Lägre fel ${score.day_wins} av ${score.target_day_count} leveransdagar · täcker ${score.scored_quarters} av ${score.baseline_quarters} kvartar (${(score.scored_quarters / score.baseline_quarters * 100).toFixed(0)}%)`,
          `Lower error on ${score.day_wins} of ${score.target_day_count} delivery days · covers ${score.scored_quarters} of ${score.baseline_quarters} quarters (${(score.scored_quarters / score.baseline_quarters * 100).toFixed(0)}%)`)}</p>}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1 text-sm">{t('Nivå och riktning på felet', 'Price level and direction of error')}</summary>
          <p className="mt-2">{t('Dagens medelpris, absolut fel', 'Daily mean price, absolute error')} ({labels.baseline} / {labels.corrected}): {price(score.reduced_daily_mean_mae)} / {price(score.full_daily_mean_mae)} kr/kWh.</p>
          <p className="mt-1">{t('Medelfel (plus = för högt)', 'Bias (positive = too high)')} ({labels.baseline} / {labels.corrected}): {price(score.reduced_bias)} / {price(score.full_bias)} kr/kWh.</p>
          <p className="mt-1">{t(`${score.complete_day_origins} av ${score.scored_day_origins} bedömda dag/prognospar täcker ett helt dygn.`, `${score.complete_day_origins} of ${score.scored_day_origins} scored day/forecast pairs cover a full day.`)}</p>
        </details>
      </>}
    </CardContent>
  </Card>;
};

const GenerationMixComparison: React.FC = () => {
  const { t, language } = useLanguage();
  const [params, setParams] = useSearchParams();
  const requested = params.get('study');
  const study = requested === 'correction-v2' || requested === 'correction' || requested === 'mix' ? requested : 'weather';
  const weather = study === 'weather';
  // The saved-forecast card shows live forecasts unless the validation cohort is chosen.
  const cohort = weather && params.get('cohort') === 'validation' ? 'replay' : 'prospective';
  const correction = study === 'correction' || study === 'correction-v2';
  const v2 = study === 'correction-v2';
  const algorithm = v2 ? 'se3-price-residual-v2' : 'se3-price-residual-v1';
  const labels: ArmLabels = weather ? {
    baseline: t('SMHI-baserad prognos', 'SMHI-based forecast'), corrected: t('Vädermodell', 'Weather model'),
    lowError: t('Vädermodellen har lägre fel hittills', 'Weather model has lower error so far'),
    highError: t('Vädermodellen har högre fel hittills', 'Weather model has higher error so far'),
  } : correction ? {
    baseline: t('Nuvarande prognos', 'Current forecast'), corrected: v2 ? t('Med korrigering v2', 'With correction v2') : t('Med korrigering', 'With correction'),
    lowError: t('Korrigeringen har lägre fel hittills', 'Correction has lower error so far'),
    highError: t('Korrigeringen har högre fel hittills', 'Correction has higher error so far'),
  } : {
    baseline: t('Utan mix', 'Without mix'), corrected: t('Med full mix', 'With full mix'),
    lowError: t('Full mix har lägre fel hittills', 'Full mix has lower error so far'),
    highError: t('Full mix har högre fel hittills', 'Full mix has higher error so far'),
  };
  const series = MIX_SERIES.map(item => ({ ...item, label: item.key === 'reduced' ? labels.baseline : item.key === 'full' ? labels.corrected : t(item.sv, item.en) }));
  const pairId = params.get('pair');
  const query = useQuery({
    queryKey: ['test-price-pair-comparison', study, cohort, pairId],
    queryFn: async () => {
      const { data, error } = weather ? await db.rpc('get_test_weather_price_comparison', { p_run_id: pairId, p_kind: cohort })
        : await db.rpc(correction ? 'get_test_price_correction_comparison' : 'get_test_price_pair_comparison',
          correction ? { p_pair_id: pairId, p_algorithm: algorithm } : { p_pair_id: pairId });
      if (error) throw new Error(error.message);
      return data as PricePairComparison;
    },
    retry: false, staleTime: 30_000, refetchInterval: 60_000,
  });
  // The weather study always shows both cohorts' scores; this fetches the one the card is not showing.
  const otherQuery = useQuery({
    queryKey: ['test-price-pair-comparison', study, cohort === 'replay' ? 'prospective' : 'replay', null],
    queryFn: async () => {
      const { data, error } = await db.rpc('get_test_weather_price_comparison', { p_run_id: null, p_kind: cohort === 'replay' ? 'prospective' : 'replay' });
      if (error) throw new Error(error.message);
      return data as PricePairComparison;
    },
    enabled: weather, retry: false, staleTime: 30_000, refetchInterval: 60_000,
  });
  const data = query.data;
  const validation = weather ? (cohort === 'replay' ? data : otherQuery.data) : undefined;
  const live = weather ? (cohort === 'prospective' ? data : otherQuery.data) : undefined;
  const criterion = useMemo(() => validation ? weatherPriceCriterion(validation.report.scores, validation.report.days ?? []) : null, [validation]);
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
        <h2 id="mix-comparison-title" className="text-xl font-semibold">{weather ? t('Slår en vädermodell den SMHI-baserade prognosen två och tre dagar framåt?', 'Does a weather model beat the SMHI-based forecast two and three days ahead?') : correction ? t('Kan marknadsdata förbättra den nuvarande prognosen?', 'Can market data improve the current forecast?') : t('Blir prisprognosen bättre med produktionsmixen?', 'Does the generation mix improve price forecasts?')}</h2>
        <p className="text-sm text-muted-foreground">{weather ? t('Den sparade SMHI-baserade prognosen jämförs med en separat modell som lär sig priset från ECMWF-prognoser för vind, temperatur och solinstrålning på tio platser i SE3. Båda bedöms på exakt samma kvartar, vars priser var okända när prognosen gjordes. Experimentet ändrar inte priserna som planeraren använder.',
          'The saved SMHI-based forecast is compared with a separate model that learns the price from ECMWF wind, temperature and solar radiation forecasts at ten SE3 sites. Both are scored on exactly the same quarters, whose prices were unknown when the forecast was made. The experiment does not change the prices used by the planner.') : correction ? t('Den sparade hushållsprognosen jämförs med samma prognos plus en inlärd korrigering från produktionsmix och veckans efterfrågeintervall. Experimentet ändrar inte priserna som planeraren använder.', 'The saved household forecast is compared with that same forecast plus a learned correction from generation mix and week-ahead demand ranges. The experiment does not change the prices used by the planner.') : t('Samma modell och historik, med eller utan prognoser för vind, sol, vattenkraft, kärnkraft, gas och övrig produktion. Båda bedöms på exakt samma kvartar när priserna publiceras.',
          'The same model and history, with or without forecasts for wind, solar, hydro, nuclear, gas and other generation. Both are scored on exactly the same quarters as prices are published.')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="price-study-select" className="mb-1 block text-sm">{t('Experiment', 'Experiment')}</label>
          <Select value={study} onValueChange={value => {
            const next = new URLSearchParams(params); next.set('study', value); next.delete('pair'); next.delete('cohort'); setParams(next, { replace: true });
          }}>
            <SelectTrigger id="price-study-select" className="min-h-11 w-64"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="weather">{t('Vädermodell · avslutad', 'Weather model · retired')}</SelectItem><SelectItem value="correction-v2">{t('Korrigering v2 · avslutad', 'Correction v2 · retired')}</SelectItem><SelectItem value="correction">{t('Korrigering v1 · avslutad', 'Correction v1 · retired')}</SelectItem><SelectItem value="mix">{t('Produktionsmixmodell · avslutad', 'Generation mix model · retired')}</SelectItem></SelectContent>
          </Select>
        </div>
      <Button variant="outline" className="min-h-11" disabled={query.isFetching} onClick={() => void query.refetch()}>
        <RefreshCw aria-hidden="true" className={`mr-2 h-4 w-4 ${query.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} />{t('Uppdatera', 'Refresh')}
      </Button>
      </div>
    </div>
    {!weather && <p className="max-w-3xl text-sm text-muted-foreground">{t('Studierna är avslutade. Inga nya experimentprognoser beräknas; sparade resultat finns kvar för granskning.',
      'These studies are retired. No new experimental forecasts are calculated; saved results remain available for review.')}</p>}
    {query.isLoading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t('Laddar jämförelser…', 'Loading comparisons…')}</p>}
    {query.isError && <Alert variant="destructive"><AlertDescription>{t('Kunde inte hämta jämförelsen. Försök uppdatera igen.', 'Could not load the comparison. Try refreshing again.')}</AlertDescription></Alert>}
    {data && <>
      {!data.enabled ? <Alert><AlertDescription>{t('Studien är inte aktiverad i TEST.', 'The study is not enabled in TEST.')}</AlertDescription></Alert> : <>
        <p className="text-xs text-muted-foreground">TEST · SE3 · {data.home_name} · {t('Senast hämtad', 'Last checked')} {stamp(data.updated_at)} · {t('Uppdateras varje minut', 'Refreshes every minute')}</p>
        {weather && <>
          <section className="space-y-3" aria-labelledby="weather-validation-title" data-testid="weather-validation">
            <h3 id="weather-validation-title" className="text-lg font-semibold">{t('Validering: prognoser omräknade i efterhand', 'Validation: forecasts recomputed after the fact')}</h3>
            <p className="max-w-3xl text-sm text-muted-foreground">{t(`Var sjätte timme från 31 oktober till 8 november räknades modellen om med enbart de versioner av väder och priser som TEST hade sparat vid den tidpunkten. Leveransdagarna ${validation?.holdout ? `${dayLabel(validation.holdout.from)}–${dayLabel(validation.holdout.to)}` : ''} valdes som test innan någon av dem bedömdes; tidigare dagar användes för att välja modellen och ingår inte.`,
              `Every six hours from 31 October to 8 November the model was recomputed using only the versions of weather and prices TEST had saved by that time. Delivery days ${validation?.holdout ? `${dayLabel(validation.holdout.from)}–${dayLabel(validation.holdout.to)}` : ''} were set aside as the test before any of them was scored; earlier days were used to choose the model and are not included.`)}</p>
            <div className="grid gap-4 md:grid-cols-2">{[2, 3].map(lead => <HorizonScore key={lead} id="weather-validation-score" lead={lead} labels={labels} score={validation?.report.scores.find(row => row.lead_day === lead)} />)}</div>
            {criterion && <div className="rounded-md border p-4 text-sm" data-testid="weather-criterion">
              <p className="font-medium">{criterion.every(rule => rule.met) ? t('Det förutbestämda kriteriet är uppfyllt', 'The criterion set in advance is met') : t('Det förutbestämda kriteriet är inte uppfyllt', 'The criterion set in advance is not met')}</p>
              <ul className="mt-2 space-y-1 tabular-nums">{criterion.map(rule => <li key={rule.key} className="flex gap-2"><span aria-hidden="true">{rule.met ? '✓' : '✗'}</span><span><span className="sr-only">{rule.met ? t('Uppfyllt: ', 'Met: ') : t('Inte uppfyllt: ', 'Not met: ')}</span>{
                rule.key === 'mae' ? t(`Minst 5 % lägre fel vid varje framförhållning: ${(rule.values[0] * 100).toFixed(1)} % (D+2), ${(rule.values[1] * 100).toFixed(1)} % (D+3)`, `At least 5% lower error at each lead: ${(rule.values[0] * 100).toFixed(1)}% (D+2), ${(rule.values[1] * 100).toFixed(1)}% (D+3)`)
                  : rule.key === 'days' ? t(`Lägre fel minst tre av fyra leveransdagar: ${rule.values[0]} av ${rule.values[1]} (D+2), ${rule.values[2]} av ${rule.values[3]} (D+3)`, `Lower error on at least three in four delivery days: ${rule.values[0]} of ${rule.values[1]} (D+2), ${rule.values[2]} of ${rule.values[3]} (D+3)`)
                    : rule.key === 'interval' ? t(`Skillnaden i fel ligger under noll när hela dagar dras om (90 %-intervall): ${rule.values[0].toFixed(3)} till ${rule.values[1].toFixed(3)} kr/kWh`, `The error difference stays below zero when whole days are resampled (90% interval): ${rule.values[0].toFixed(3)} to ${rule.values[1].toFixed(3)} SEK/kWh`)
                      : t(`Täcker minst 98 % av kvartarna: ${(rule.values[0] * 100).toFixed(0)} % (D+2), ${(rule.values[1] * 100).toFixed(0)} % (D+3)`, `Covers at least 98% of the quarters: ${(rule.values[0] * 100).toFixed(0)}% (D+2), ${(rule.values[1] * 100).toFixed(0)}% (D+3)`)}</span></li>)}</ul>
              <p className="mt-2 text-muted-foreground">{t('Åtta leveransdagar är få, och priserna steg under perioden. Resultatet visar att modellen var bättre under dessa dagar, inte att den alltid är det.', 'Eight delivery days are few, and prices rose over the period. The result shows the model was better on these days, not that it always is.')}</p>
            </div>}
            {validation && (validation.report.days?.length ?? 0) > 0 && <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums" data-testid="weather-validation-days">
                <caption className="sr-only">{t('Fel per leveransdag i valideringen', 'Error per delivery day in the validation')}</caption>
                <thead className="text-muted-foreground"><tr>{[t('Leveransdag', 'Delivery day'), t('Prognoser', 'Forecasts'), `${labels.baseline}, MAE`, `${labels.corrected}, MAE`].map(title => <th scope="col" key={title} className="whitespace-nowrap px-2 py-2 text-left font-medium first:pl-0">{title}</th>)}</tr></thead>
                <tbody>{validation.report.days!.map(day => <tr key={`${day.target_day}-${day.lead_day}`} className="border-t"><th scope="row" className="py-2 pr-2 text-left font-normal">{dayLabel(day.target_day)} · D+{day.lead_day}</th><td className="px-2 py-2">{day.origin_count}</td><td className="px-2 py-2">{price(day.reduced_mae)}</td><td className="px-2 py-2">{price(day.full_mae)}</td></tr>)}</tbody>
              </table>
            </div>}
          </section>
          <h3 className="text-lg font-semibold">{t('Prognoser sparade innan priserna var kända', 'Forecasts saved before prices were known')}</h3>
          <div className="grid gap-4 md:grid-cols-2">{[2, 3].map(lead => <HorizonScore key={lead} lead={lead} labels={labels} score={live?.report.scores.find(row => row.lead_day === lead)} />)}</div>
          <p className="max-w-3xl text-sm text-muted-foreground">{t('Studien är avslutad. Här visas de prognoser som sparades medan den pågick.', 'The study has ended. These forecasts were saved while it was running.')}</p>
        </>}
        {!weather && <div className="grid gap-4 md:grid-cols-2">{[2, 3].map(lead => <HorizonScore key={lead} lead={lead} labels={labels} score={data.report.scores.find(row => row.lead_day === lead)} />)}</div>}
        {!weather && <p className="max-w-3xl text-sm text-muted-foreground">{t('Resultaten ovan gäller alla sparade prognospar. Tidiga resultat visar bara felet hittills. Kvartar från samma dag och överlappande prognoser är beroende av varandra; många unika dagar behövs för en säker slutsats. D+3 kan täcka en del av dagen.',
          'The results above cover all saved forecast pairs. Early results show only the error so far. Quarters from the same day and overlapping forecasts are related; many distinct days are needed for a reliable conclusion. D+3 can cover part of a day.')}</p>}
        {weather && <div className="w-full sm:w-56">
          <label htmlFor="weather-cohort-select" className="mb-1 block text-sm">{t('Visa prognoser från', 'Show forecasts from')}</label>
          <Select value={cohort} onValueChange={value => {
            const next = new URLSearchParams(params); next.delete('pair');
            if (value === 'replay') next.set('cohort', 'validation'); else next.delete('cohort');
            setParams(next, { replace: true });
          }}>
            <SelectTrigger id="weather-cohort-select" className="min-h-11"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="prospective">{t('Sparade', 'Saved forecasts')}</SelectItem><SelectItem value="replay">{t('Valideringen', 'The validation')}</SelectItem></SelectContent>
          </Select>
        </div>}
        {!selected ? <p role="status" className="rounded-md border p-4 text-sm">{weather ? t('Inga prognoser har sparats här ännu.', 'No forecasts have been saved here yet.') : t('Inga prognospar sparades i denna studie.', 'No forecast pairs were saved in this study.')}</p> : <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <CardTitle className="text-lg">{t('Ett sparat prognospar', 'One saved forecast pair')}</CardTitle>
              <div className="w-full sm:w-80">
                <label htmlFor="mix-pair-select" className="mb-1 block text-sm">{t('Prognos gjord', 'Forecast made')}</label>
                <Select value={selected.id} onValueChange={selectPair}>
                  <SelectTrigger id="mix-pair-select" className="min-h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>{pairOptions.map(pair => <SelectItem key={pair.id} value={pair.id}>{stamp(pair.saved_at ?? pair.reserved_at)} · {pair.status === 'pending' ? t('slutfördes inte', 'never completed') : pair.status === 'unavailable' ? t('saknar underlag', 'unavailable') : t(`${pair.scored_count}/${pair.eligible_count} bedömda`, `${pair.scored_count}/${pair.eligible_count} scored`)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-sm text-muted-foreground" role="status" data-testid="mix-coverage">{t(`${scored} av ${selected.eligible_count} kvartar bedömda · ${selected.eligible_count - scored} väntar på publicerade priser`, `${scored} of ${selected.eligible_count} quarters scored · ${selected.eligible_count - scored} awaiting published prices`)}</p>
            {data.report.pair_count > data.report.pairs.length && <p className="text-xs text-muted-foreground">{t('Välj bland de senaste 100 paren. Sammanfattningen omfattar hela studien.', 'Choose from the latest 100 pairs. The summary includes the whole study.')}</p>}
          </CardHeader>
          <CardContent className="space-y-4">
            {correction && selected.baseline_generated_at && <p className="text-sm text-muted-foreground">{t('Ursprunglig hushållsprognos', 'Original household forecast')}: {stamp(selected.baseline_generated_at)}.</p>}
            {selected.status !== 'paired' && <Alert><AlertDescription>{selected.status === 'pending' ? t('Detta prognospar slutfördes inte innan studien avslutades.', 'This forecast pair was never completed before the study retired.') : t('Underlag saknas för ett komplett prognospar.', 'Inputs are missing for a complete forecast pair.')}{selected.reason && <p className="mt-1">{selected.reason}</p>}</AlertDescription></Alert>}
            {targets && targets.length > 0 && <>
              <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label={t('Teckenförklaring', 'Legend')}>
                {series.map(series => <li key={series.key} className="flex items-center gap-2"><svg width="30" height="12" aria-hidden="true"><line x1="0" x2="30" y1="6" y2="6" stroke={series.colour} strokeWidth="2" strokeDasharray={series.dash} /></svg>{series.label}</li>)}
              </ul>
              <div className="h-[300px] min-w-0" data-testid="mix-price-chart" aria-label={t('Prisprognoser och publicerade priser, kr/kWh', 'Price forecasts and published prices, SEK/kWh')}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} accessibilityLayer margin={{ top: 15, right: 12, bottom: 5, left: 5 }}>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} scale="time" tickCount={5} minTickGap={30} stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={at => new Intl.DateTimeFormat(locale, { timeZone: TZ, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at)} />
                    <YAxis width={45} stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} domain={['auto', 'auto']} tickFormatter={value => value.toFixed(1)} />
                    <Tooltip labelFormatter={label => detailTime(Number(label))} formatter={(value: number, name: string) => [`${price(value)} kr/kWh`, name]} contentStyle={{ backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))', borderColor: 'hsl(var(--border))', borderRadius: 6, fontSize: 12 }} />
                    {series.map(series => <Line key={series.key} dataKey={series.key} name={series.label} type="stepAfter" stroke={series.colour} strokeDasharray={series.dash} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground">{t('Importpris inklusive avgifter, kr/kWh. Stockholmstid. Luckor är saknade värden; inga priser har fyllts i.', 'All-in import price, SEK/kWh. Stockholm time. Gaps are missing values; no prices have been filled in.')}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums" data-testid="mix-days">
                  <caption className="sr-only">{t('Fel per måldag för valt prognospar', 'Error per target day for the selected pair')}</caption>
                  <thead className="text-muted-foreground"><tr>{[t('Måldag', 'Target day'), t('Bedömt', 'Scored'), `${labels.baseline}, MAE`, `${labels.corrected}, MAE`].map(title => <th scope="col" key={title} className="whitespace-nowrap px-2 py-2 text-left font-medium first:pl-0">{title}</th>)}</tr></thead>
                  <tbody>{days.map(day => <tr key={day.day} className="border-t"><th scope="row" className="py-3 pr-2 text-left font-normal">{dayLabel(day.day)} · D+{day.leadDay}{day.eligible < day.expected && <span className="block text-xs text-muted-foreground">{t(`${day.eligible}/${day.expected} kvartar i dygnet`, `${day.eligible}/${day.expected} quarters of the day`)}</span>}</th><td className="px-2 py-3">{day.scored}/{day.eligible}</td><td className="px-2 py-3">{price(day.reducedMae)}</td><td className="px-2 py-3">{price(day.fullMae)}</td></tr>)}</tbody>
                </table>
              </div>
              <details className="rounded-md border p-3 text-sm">
                <summary className="cursor-pointer">{t('Visa alla kvartsvärden', 'Show all quarter values')}</summary>
                <div className="mt-3 max-h-80 overflow-auto"><table className="w-full whitespace-nowrap text-sm tabular-nums"><caption className="sr-only">{t('Prognoser och publicerade priser per kvart', 'Forecasts and published prices per quarter')}</caption><thead><tr>{[t('Tid', 'Time'), labels.baseline, labels.corrected, t('Publicerat', 'Published')].map(title => <th scope="col" key={title} className="px-2 py-2 text-left font-medium">{title}</th>)}</tr></thead><tbody>{targets.map(row => <tr key={row.start} className="border-t"><th scope="row" className="px-2 py-2 text-left font-normal">{detailTime(Date.parse(row.start))}</th><td className="px-2 py-2">{price(row.reduced)}</td><td className="px-2 py-2">{price(row.full)}</td><td className="px-2 py-2">{row.actual === null ? t('väntar', 'waiting') : price(row.actual)}</td></tr>)}</tbody></table></div>
              </details>
            </>}
            <p className="max-w-3xl text-sm text-muted-foreground">{t('Endast framtida kvartar vars priser ännu var okända när prognosparet sparades visas och bedöms. Båda prognoserna är låsta; korrigerade publicerade priser uppdaterar bedömningen. Detta är en separat TEST-studie.', 'Only future quarters whose prices were still unknown when the pair was saved are shown and scored. Both forecasts are frozen; corrected published prices update the scores. This is a separate TEST study.')}</p>
          </CardContent>
        </Card>}
      </>}
    </>}
    <Se3MarketHistory forecastDay={days[0]?.day} />
  </section>;
};
export default GenerationMixComparison;
