// How close the planner's price estimate for unpublished days came to what the
// market then published. Each plan's estimate is kept per home and per day
// (energy_price_estimate_days); this reads it beside the real prices. Staff
// only.
//
// The view explains one estimate at a time: a chart of the estimate against the
// real prices, a table of the same days under it, and how that estimate was
// produced. Previous/next step through the days estimates were made on. The
// summary at the end is every estimate together, by how far ahead it looked.
// Every figure comes from the quarters the chart draws (price-estimates.ts).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { formatHomeTime } from '@/lib/energy-shift/home-time';
import {
  actualsByDay, chartDays, DAY_QUARTERS, MIN_SUMMARY_QUARTERS, priceEstimates, summariseEstimates,
  type EstimateSeries, type PriceEstimate,
} from '@/lib/planner-bench/price-estimates';
import {
  BOUNDARY_CARRY_HALF_LIFE_HOURS, LEVEL_NORM_DAYS, LEVEL_REVERSION_PER_DAY, RECENCY_HALF_LIFE_DAYS, WIND_FIT_DAYS,
} from '../../../../supabase/functions/_shared/planner/energy-price-shape';
import PriceEstimateChart, { ESTIMATE_COLOUR, kr, REAL_COLOUR } from './PriceEstimateChart';

const db = supabase as unknown as SupabaseClient;
const DAYS = 60;
/** An error this large in a day's level is worth a second look, SEK/kWh. */
const LARGE_ERROR = 0.5;

/** A line sample for the legend, so a series is named by its stroke and not by its colour alone. */
const Sample: React.FC<{ kind: 'real' | 'estimate' | 'gap' | 'level' }> = ({ kind }) => (
  <svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true" className="shrink-0">
    {kind === 'gap'
      ? <rect x="1" y="2" width="26" height="8" fill={ESTIMATE_COLOUR} fillOpacity={0.22} />
      : kind === 'level'
        ? <>
          <line x1="1" x2="27" y1="3" y2="3" stroke={ESTIMATE_COLOUR} strokeWidth="1" strokeDasharray="2 3" />
          <line x1="1" x2="27" y1="9" y2="9" stroke={REAL_COLOUR} strokeWidth="1" strokeOpacity={0.55} />
          <line x1="20" x2="20" y1="3" y2="9" stroke={REAL_COLOUR} strokeWidth="1.5" />
        </>
        : <line x1="1" x2="27" y1="6" y2="6" stroke={kind === 'real' ? REAL_COLOUR : ESTIMATE_COLOUR} strokeWidth="2.25"
          strokeDasharray={kind === 'estimate' ? '6 4' : undefined} />}
  </svg>
);

const PriceEstimateAccuracy: React.FC = () => {
  const { t, language } = useLanguage();
  const [params, setParams] = useSearchParams();
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['price-estimate-series', DAYS],
    queryFn: async () => {
      const { data, error } = await db.rpc('get_price_estimate_series', { p_days: DAYS });
      if (error) throw new Error(error.message);
      return (data ?? { estimates: [], actuals: [] }) as EstimateSeries;
    },
    retry: false,
    staleTime: 15 * 60_000,
  });

  const all = useMemo(() => priceEstimates(query.data ?? { estimates: [], actuals: [] }), [query.data]);
  const actuals = useMemo(() => actualsByDay(query.data?.actuals ?? []), [query.data]);
  const homes = useMemo(() => [...new Map(all.map(e => [e.homeId, e.homeName])).entries()], [all]);
  const homeId = homes.some(([id]) => id === params.get('home')) ? params.get('home')! : homes[0]?.[0] ?? null;
  const estimates = useMemo(() => all.filter(e => e.homeId === homeId), [all, homeId]);
  // Open on the newest estimate that has something to judge it by.
  const fallback = [...estimates].reverse().find(e => e.days.some(d => d.was !== null)) ?? estimates[estimates.length - 1];
  const index = Math.max(0, estimates.findIndex(e => e.issuedOn === (params.get('estimate') ?? fallback?.issuedOn)));
  const estimate: PriceEstimate | undefined = estimates[index];
  const days = useMemo(() => estimate ? chartDays(estimate, actuals) : [], [estimate, actuals]);
  const summary = useMemo(() => summariseEstimates(estimates), [estimates]);

  const select = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) merged.set(key, value);
    setParams(merged, { replace: true });
    setFocusDay(null);
  };
  // Two key presses can land before the page has drawn the first: step from where the last one went.
  const at = useRef(index);
  at.current = index;
  const step = (by: number) => {
    const to = estimates[at.current + by];
    if (!to) return;
    at.current += by;
    select({ estimate: to.issuedOn });
  };

  // Left and right step through the estimates, unless a control of its own has the keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target && target !== document.body && !target.closest('[data-estimate-nav]')) return;
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const dayLabel = (day: string) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${day}T12:00:00Z`));
  const basisLabel = (basis: string) => basis === 'wind' ? t('vindprognos', 'wind forecast')
    : basis === 'recent_norm' ? t(`${LEVEL_NORM_DAYS} dagars norm`, `${LEVEL_NORM_DAYS}-day norm`)
      : t('publicerad nivå', 'published level');
  const ahead = (lead: number) => lead === 0 ? t('samma dag', 'same day') : lead === 1 ? t('1 dag', '1 day') : t(`${lead} dagar`, `${lead} days`);
  const percentPerDay = Math.round(LEVEL_REVERSION_PER_DAY * 100);

  if (query.isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar…', 'Loading…')}</div>;
  if (query.isError) return <Alert variant="destructive"><AlertDescription>{(query.error as Error).message}</AlertDescription></Alert>;
  if (!estimate) {
    return <p data-testid="price-estimate-accuracy" className="text-sm text-muted-foreground">
      {t(`Inga prisuppskattningar har sparats de senaste ${DAYS} dagarna.`, `No price estimate has been kept in the last ${DAYS} days.`)}
    </p>;
  }

  const bases = [...new Set(estimate.days.map(d => d.basis))];
  const largest = Math.max(0.01, ...summary.flatMap(row => [row.levelError, row.quarterError]));

  return (
    <div data-testid="price-estimate-accuracy" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t('Marknaden publicerar priser en dag i förväg, men en plan täcker 72 timmar. Resten av planen räknar på en uppskattning. Här syns varje uppskattning mot vad dagarna sedan kostade. Importpris, kr/kWh.',
            'The market publishes prices one day ahead, but a plan covers 72 hours. The rest of the plan runs on an estimate. Here each estimate is set against what those days then cost. Import price, SEK/kWh.')}
        </p>
        {homes.length > 1 && (
          <Select value={homeId ?? undefined} onValueChange={value => { const merged = new URLSearchParams(params); merged.set('home', value); merged.delete('estimate'); setParams(merged, { replace: true }); }}>
            <SelectTrigger id="price-estimate-home" className="w-56" aria-label={t('Hem', 'Home')}><SelectValue /></SelectTrigger>
            <SelectContent>{homes.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
          </Select>
        )}
      </div>

      <Card>
        <CardHeader className="space-y-3 pb-3">
          <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:justify-between sm:gap-3" data-estimate-nav>
            <Button id="price-estimate-previous" variant="outline" className="min-h-11" disabled={index === 0} onClick={() => step(-1)}
              aria-label={t('Föregående uppskattning', 'Previous estimate')}>
              <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
              <span className="sm:hidden">{t('Föregående', 'Previous')}</span>
              <span className="hidden sm:inline">{t('Föregående uppskattning', 'Previous estimate')}</span>
            </Button>
            <div className="order-first col-span-2 text-center sm:order-none" aria-live="polite">
              <CardTitle id="price-estimate-title" className="text-lg">{t('Uppskattning gjord', 'Estimate made')} {dayLabel(estimate.issuedOn)}</CardTitle>
              <p className="text-xs text-muted-foreground">{t(`${index + 1} av ${estimates.length}`, `${index + 1} of ${estimates.length}`)}</p>
            </div>
            <Button id="price-estimate-next" variant="outline" className="min-h-11" disabled={index >= estimates.length - 1} onClick={() => step(1)}
              aria-label={t('Nästa uppskattning', 'Next estimate')}>
              <span className="sm:hidden">{t('Nästa', 'Next')}</span>
              <span className="hidden sm:inline">{t('Nästa uppskattning', 'Next estimate')}</span>
              <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground" aria-label={t('Teckenförklaring', 'Legend')}>
            <li className="flex items-center gap-1.5"><Sample kind="real" />{t('Verkligt pris, när det publicerats', 'Real price, once published')}</li>
            <li className="flex items-center gap-1.5"><Sample kind="estimate" />{t('Uppskattning', 'Estimate')}</li>
            <li className="flex items-center gap-1.5"><Sample kind="gap" />{t('Gapet per kvart (kvartsfel)', 'Gap per quarter-hour (quarter error)')}</li>
            <li className="flex items-center gap-1.5"><Sample kind="level" />{t('Dagens medelpris, uppskattat och verkligt (nivåfel)', 'The day’s mean price, estimated and real (level error)')}</li>
          </ul>
        </CardHeader>
        <CardContent className="space-y-5">
          <PriceEstimateChart days={days} dayLabel={dayLabel} focusDay={focusDay} onFocusDay={setFocusDay} />

          <div className="overflow-x-auto">
            <table id="price-estimate-days" className="w-full whitespace-nowrap text-sm tabular-nums">
              <caption className="sr-only">{t('Dagarna i diagrammet', 'The days in the chart')}</caption>
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t('Dag', 'Day')}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t('Framåt', 'Ahead')}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t('Nivå från', 'Level from')}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t('Gjord', 'Made at')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('Trodde', 'Believed')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('Blev', 'Was')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('Nivåfel', 'Level error')}</th>
                  <th scope="col" className="py-1.5 text-right font-medium">{t('Kvartsfel', 'Quarter error')}</th>
                </tr>
              </thead>
              <tbody>
                {estimate.days.map(day => (
                  <tr key={day.day} tabIndex={0} data-day={day.day}
                    className={`border-t outline-none focus-visible:ring-2 focus-visible:ring-ring ${focusDay === day.day ? 'bg-muted' : ''}`}
                    onMouseEnter={() => setFocusDay(day.day)} onMouseLeave={() => setFocusDay(null)}
                    onFocus={() => setFocusDay(day.day)} onBlur={() => setFocusDay(null)}>
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                      {dayLabel(day.day)}
                      {day.quarters < DAY_QUARTERS && <span className="ml-2 text-xs text-muted-foreground">{t(`${day.quarters} av ${DAY_QUARTERS} kvartar`, `${day.quarters} of ${DAY_QUARTERS} quarter-hours`)}</span>}
                    </th>
                    <td className="py-1.5 pr-3">{ahead(day.leadDays)}</td>
                    <td className="py-1.5 pr-3">{basisLabel(day.basis)}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{formatHomeTime(day.issuedAt, estimate.timezone)}</td>
                    <td className="py-1.5 pr-3 text-right">{kr(day.believed)}</td>
                    <td className="py-1.5 pr-3 text-right">{day.was === null ? '–' : kr(day.was)}</td>
                    <td className={`py-1.5 pr-3 text-right font-medium ${day.levelError !== null && Math.abs(day.levelError) > LARGE_ERROR ? 'text-destructive' : ''}`}>
                      {day.levelError === null ? t('väntar', 'waiting') : kr(day.levelError, true)}
                    </td>
                    <td className="py-1.5 text-right">{day.quarterError === null ? '–' : kr(day.quarterError)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 max-w-3xl text-xs text-muted-foreground">
              {t('Trodde och Blev är dagens medelpris. Nivåfel = trodde − blev: plus betyder att uppskattningen var för hög. Kvartsfel är hur långt en kvart låg från det verkliga priset i genomsnitt, alltså den skuggade ytans medelhöjd.',
                'Believed and Was are the day’s mean price. Level error = believed − was: plus means the estimate was too high. Quarter error is how far a quarter-hour was from the real price on average, which is the mean height of the shaded gap.')}
            </p>
          </div>

          <section id="price-estimate-method" aria-labelledby="price-estimate-method-title" className="rounded-md border px-4 py-3">
            <h3 id="price-estimate-method-title" className="text-sm font-medium">{t('Så gjordes uppskattningen', 'How this estimate was made')}</h3>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground max-w-3xl">
              <li>
                <span className="text-foreground">{t('Form.', 'Shape.')}</span>{' '}
                {t(`Hur priset brukar röra sig över ett dygn, lärt av hemmets publicerade priser. Nya dagar väger tyngst (hälften så mycket efter ${RECENCY_HALF_LIFE_DAYS} dagar), och vardagar och helger hålls isär.`,
                  `How the price usually moves over a day, learnt from this home’s published prices. Recent days weigh most (half as much after ${RECENCY_HALF_LIFE_DAYS} days), and weekdays and weekends are told apart.`)}
              </li>
              <li>
                <span className="text-foreground">{t('Nivå.', 'Level.')}</span>{' '}
                {t('Dagens medelpris, den tunna streckade linjen.', 'The day’s mean price, the thin dotted line.')}{' '}
                {bases.includes('wind') && t(`Här sattes den av vindprognosen: de senaste ${WIND_FIT_DAYS} dagarna visar vad en dag kostar vid en viss vind, och blåsigare dagar är billigare. Hur långt de publicerade priserna låg från sin egen vind följer med, mindre för varje dag framåt (${percentPerDay} % per dag).`,
                  `Here the wind forecast set it: the last ${WIND_FIT_DAYS} days show what a day costs at a given wind, and windier days are cheaper. How far the published prices stood from their own wind is carried along, less for each day ahead (${percentPerDay} % per day).`)}
                {bases.includes('recent_norm') && t(` Utan vindmodell dras den publicerade nivån mot mediandagen de senaste ${LEVEL_NORM_DAYS} dagarna, ${percentPerDay} % av vägen per dag framåt.`,
                  ` Without a wind model the published level is drawn toward the median day of the last ${LEVEL_NORM_DAYS} days, ${percentPerDay} % of the way per day ahead.`)}
                {bases.includes('published') && t(' Med för lite historik förs den publicerade nivån bara vidare.', ' With too little history the published level is simply carried forward.')}
              </li>
              <li>
                <span className="text-foreground">{t('Uppskattning = nivå × form.', 'Estimate = level × shape.')}</span>{' '}
                {t(`De första kvartarna börjar dessutom från det sista publicerade priset och glider in i modellen över ungefär ${BOUNDARY_CARRY_HALF_LIFE_HOURS} timmar.`,
                  `The first quarter-hours also start from the last published price and ease into the model over about ${BOUNDARY_CARRY_HALF_LIFE_HOURS} hours.`)}
              </li>
            </ol>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              {t('Ett stort nivåfel betyder att nivån (steg 2) missade. Ett kvartsfel som är klart större än nivåfelet betyder att formen (steg 1) missade: topparna kom vid andra tider eller blev högre än vanligt.',
                'A large level error means the level (step 2) missed. A quarter error clearly larger than the level error means the shape (step 1) missed: the peaks came at other times or rose higher than usual.')}
            </p>
          </section>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t(`Alla uppskattningar, senaste ${DAYS} dagarna`, `All estimates, last ${DAYS} days`)}</CardTitle>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {t(`Samma två fel som ovan, i medeltal över alla uppskattade dagar som sedan publicerats. Dagar uppskattade till mindre än hälften (${MIN_SUMMARY_QUARTERS} kvartar) räknas inte.`,
              `The same two errors as above, averaged over every estimated day the market has since published. Days estimated for less than half (${MIN_SUMMARY_QUARTERS} quarter-hours) are left out.`)}
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table id="price-estimate-summary" className="w-full whitespace-nowrap text-sm tabular-nums">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('Framåt', 'Ahead')}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('Nivå från', 'Level from')}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('Dagar', 'Days')}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('Nivåfel, medel', 'Level error, mean')}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('Kvartsfel, medel', 'Quarter error, mean')}</th>
                <th scope="col" className="py-1.5 font-medium">{t('Lutar', 'Leans')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.length === 0 && (
                <tr><td colSpan={6} className="py-2 text-muted-foreground">{t('Inga uppskattade dagar har publicerats än.', 'No estimated day has been published yet.')}</td></tr>
              )}
              {summary.map(row => {
                const bar = (value: number) => (
                  <div className="flex items-center gap-2">
                    <span className="w-10 text-right font-medium">{kr(value)}</span>
                    <span className="h-2 rounded-sm" style={{ width: `${Math.max(2, (value / largest) * 140)}px`, background: ESTIMATE_COLOUR, opacity: 0.6 }} aria-hidden="true" />
                  </div>
                );
                return (
                  <tr key={`${row.lead}/${row.basis}`} className={`border-t ${estimate.days.some(d => d.leadDays === row.lead && d.basis === row.basis) ? 'bg-muted/50' : ''}`}>
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">{ahead(row.lead)}</th>
                    <td className="py-1.5 pr-3">{basisLabel(row.basis)}</td>
                    <td className="py-1.5 pr-3 text-right">{row.days}</td>
                    <td className="py-1.5 pr-3">{bar(row.levelError)}</td>
                    <td className="py-1.5 pr-3">{bar(row.quarterError)}</td>
                    <td className="py-1.5">
                      {Math.abs(row.bias) < 0.005 ? t('varken eller', 'neither way')
                        : row.bias > 0 ? t(`${kr(row.bias)} för högt`, `${kr(row.bias)} too high`) : t(`${kr(-row.bias)} för lågt`, `${kr(-row.bias)} too low`)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 max-w-3xl text-xs text-muted-foreground">
            {t('Skuggade rader är de som uppskattningen ovan hör till. ”Lutar” är nivåfelet med tecken: om uppskattningarna oftare hamnar för högt eller för lågt.',
              'Shaded rows are the ones the estimate above belongs to. “Leans” is the level error with its sign: whether estimates more often land too high or too low.')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default PriceEstimateAccuracy;
