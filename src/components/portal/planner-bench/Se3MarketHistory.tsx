import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

const db = supabase as unknown as SupabaseClient;
const TZ = 'Europe/Stockholm';
const FIRST_DAY = '2026-10-22';
const BORDERS = ['SE2', 'SE4', 'NO1', 'FI', 'DK1'] as const;
type Border = typeof BORDERS[number];
type Flow = 'net' | 'gross' | Border;
type Values = Record<string, number | null> | null;
interface MarketQuarter { start: string; spot: number | null; generation: Values; measured: Values; scheduled: Values }
interface Series { key: string; label: string; colour: string; dash?: string }
const GENERATION = [
  { key: 'nuclear', types: ['B14'], sv: 'Kärnkraft', en: 'Nuclear', colour: '#8b75dc' },
  { key: 'hydro', types: ['B10', 'B11', 'B12'], sv: 'Vattenkraft', en: 'Hydro', colour: '#3d8bcb' },
  { key: 'wind', types: ['B18', 'B19'], sv: 'Vindkraft', en: 'Wind', colour: '#249c8a' },
  { key: 'solar', types: ['B16'], sv: 'Solkraft', en: 'Solar', colour: '#c88925' },
  { key: 'gas', types: ['B04'], sv: 'Gas', en: 'Gas', colour: '#c5656a' },
  { key: 'other', types: [], sv: 'Övrigt', en: 'Other', colour: '#778899' },
];
const generationTypes = new Set(GENERATION.flatMap(item => item.types));
const changeDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const stockholmToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function sum(values: (number | null | undefined)[]) {
  return values.length && values.every((value): value is number => typeof value === 'number')
    ? values.reduce((total, value) => total + value, 0) : null;
}

function flowValues(flows: Values, mode: Flow) {
  const borders = BORDERS.map(border => flows?.[border]);
  if (mode === 'gross') return [sum(borders.map(value => value == null ? value : Math.max(0, value))),
    sum(borders.map(value => value == null ? value : Math.min(0, value)))];
  return [mode === 'net' ? sum(borders) : flows?.[mode] ?? null, null];
}

const axis = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
const foreground = 'hsl(var(--foreground))';
const muted = 'hsl(var(--muted-foreground))';
const grid = 'hsl(var(--border))';

export default function Se3MarketHistory({ forecastDay }: { forecastDay?: string }) {
  const { t, language } = useLanguage();
  const today = stockholmToday();
  const [chosen, setDay] = useState('');
  const [mode, setMode] = useState<Flow>('net');
  const day = chosen || changeDay(today, -1);
  const latest = changeDay(today, 1);
  const query = useQuery({
    queryKey: ['test-se3-market-day', day], retry: false, staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await db.rpc('get_test_se3_market_day', { p_day: day });
      if (error) throw new Error(error.message);
      return data as MarketQuarter[];
    },
  });
  const rows = useMemo(() => (query.data ?? []).map(quarter => {
    const types = Object.entries(quarter.generation ?? {});
    const production = Object.fromEntries(GENERATION.map(group => [group.key, sum(types
      .filter(([type]) => group.key === 'other' ? !generationTypes.has(type) : group.types.includes(type)).map(([, value]) => value))]));
    const [actual, actualExport] = flowValues(quarter.measured, mode);
    const [dayAhead, dayAheadExport] = flowValues(quarter.scheduled, mode);
    return { at: Date.parse(quarter.start), spot: quarter.spot, ...production, actual, actualExport, dayAhead, dayAheadExport };
  }), [query.data, mode]);
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const times = new Intl.DateTimeFormat(locale, { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const detailedTimes = new Intl.DateTimeFormat(locale, { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const price: Series = { key: 'spot', label: t('Spotpris', 'Spot price'), colour: foreground, dash: '3 3' };
  const generation: Series[] = GENERATION.map(item => ({ ...item, label: t(item.sv, item.en) }));
  const flows: Series[] = mode === 'gross' ? [
    { key: 'actual', label: t('Uppmätt import', 'Measured imports'), colour: '#3d8bcb' },
    { key: 'actualExport', label: t('Uppmätt export', 'Measured exports'), colour: '#c5656a' },
    { key: 'dayAhead', label: t('Planerad import', 'Day-ahead imports'), colour: '#3d8bcb', dash: '8 4' },
    { key: 'dayAheadExport', label: t('Planerad export', 'Day-ahead exports'), colour: '#c5656a', dash: '8 4' },
  ] : [
    { key: 'actual', label: t('Uppmätt flöde', 'Measured flow'), colour: '#3d8bcb' },
    { key: 'dayAhead', label: t('Flöde från dagen före-auktionen', 'Day-ahead flow'), colour: '#9c75d8', dash: '8 4' },
  ];

  const renderChart = (title: string, series: Series[], stacked: boolean) => {
    const keys = series.map(item => item.key);
    const data = rows.some(row => keys.some(key => (row as Record<string, number | null>)[key] != null));
    return <section aria-label={title} className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="text-base font-medium">{title}</h3>
        {!stacked && <div>
          <label htmlFor="se3-market-border" className="mb-1 block text-sm">{t('Visa flöden', 'Show flows')}</label>
          <Select value={mode} onValueChange={value => setMode(value as Flow)}>
            <SelectTrigger id="se3-market-border" className="min-h-11 w-52"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="net">{t('Nettoimport', 'Net imports')}</SelectItem><SelectItem value="gross">{t('Import och export', 'Gross imports and exports')}</SelectItem>
              {BORDERS.map(border => <SelectItem key={border} value={border}>{border} ↔ SE3</SelectItem>)}</SelectContent>
          </Select>
        </div>}
      </div>
      {!stacked && <p className="text-xs text-muted-foreground">{t('Plus är import till SE3. Minus är export. Summerade flöden kräver värden för alla fem gränser.', 'Positive is into SE3. Negative is out. Totals require readings from all five borders.')}</p>}
      {!data && <p role="status" className="text-sm text-muted-foreground">{stacked ? t('Ingen produktion har arkiverats för dagen.', 'No generation is archived for this day.') : t('Inga flöden har arkiverats för detta urval.', 'No flows are available for this selection.')}</p>}
      {(data || rows.some(row => row.spot !== null)) && <>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={t('Teckenförklaring', 'Legend')}>
          {[...series, price].map(item => <li key={item.key} className="flex items-center gap-1.5"><svg width="22" height="10" aria-hidden="true"><line x1="0" x2="22" y1="5" y2="5" stroke={item.colour} strokeDasharray={item.dash} strokeWidth="3" /></svg>{item.label}</li>)}
        </ul>
        <div className="h-64 min-w-0 overflow-hidden" data-testid={stacked ? 'se3-generation-chart' : 'se3-flow-chart'}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} accessibilityLayer syncId="se3-market-history" margin={{ top: 16, right: 3, bottom: 0, left: 3 }}>
              <CartesianGrid vertical={false} stroke={grid} strokeDasharray="3 3" />
              <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} scale="time" tickCount={6} minTickGap={26} stroke={muted} tick={axis} tickFormatter={value => times.format(Number(value))} />
              <YAxis yAxisId="mw" width={48} stroke={muted} tick={axis} tickFormatter={value => number.format(Number(value))} label={{ value: 'MW', position: 'insideTopLeft', offset: 0, fill: muted, fontSize: 11 }} />
              <YAxis yAxisId="price" orientation="right" width={45} stroke={muted} tick={axis} domain={['auto', 'auto']} label={{ value: '€/MWh', position: 'insideTopRight', offset: 0, fill: muted, fontSize: 11 }} />
              <Tooltip labelFormatter={value => detailedTimes.format(Number(value))} formatter={(value: number, label: string) => [`${number.format(value)} ${label === price.label ? '€/MWh' : 'MW'}`, label]} contentStyle={{ backgroundColor: 'hsl(var(--popover))', color: foreground, borderColor: grid, fontSize: 12 }} />
              {!stacked && <ReferenceLine yAxisId="mw" y={0} stroke={muted} />}
              {series.map(item => stacked
                ? <Bar key={item.key} yAxisId="mw" dataKey={item.key} stackId="generation" name={item.label} fill={item.colour} isAnimationActive={false} />
                : <Line key={item.key} yAxisId="mw" dataKey={item.key} name={item.label} stroke={item.colour} strokeDasharray={item.dash} type="stepAfter" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />)}
              <Line yAxisId="price" dataKey={price.key} name={price.label} stroke={price.colour} strokeDasharray={price.dash} type="stepAfter" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </>}
      {stacked && <p className="text-xs text-muted-foreground">{t('Staplarna visar rapporterad produktion per kraftslag.', 'Bars show reported generation by source.')}</p>}
    </section>;
  };

  return <Card className="min-w-0" data-testid="se3-market-history">
    <CardHeader className="gap-2">
      <CardTitle className="text-lg">{t('Historik för SE3', 'SE3 market history')}</CardTitle>
      <div className="flex flex-wrap items-end gap-2">
        <Button variant="outline" className="min-h-11" disabled={day <= FIRST_DAY} onClick={() => setDay(changeDay(day, -1))}>{t('Föregående', 'Previous')}</Button>
        <div>
          <label htmlFor="se3-market-day" className="mb-1 block text-sm">{t('Leveransdag', 'Delivery day')}</label>
          <Input id="se3-market-day" type="date" className="min-h-11 w-40" min={FIRST_DAY} max={latest} value={day} onChange={event => {
            const value = event.currentTarget.value;
            if (value >= FIRST_DAY && value <= latest && event.currentTarget.validity.valid) setDay(value);
          }} />
        </div>
        <Button variant="outline" className="min-h-11" disabled={day >= latest} onClick={() => setDay(changeDay(day, 1))}>{t('Nästa', 'Next')}</Button>
        {forecastDay && forecastDay >= FIRST_DAY && forecastDay <= latest && forecastDay !== day && <Button variant="ghost" className="min-h-11" onClick={() => setDay(forecastDay)}>{t('Visa prognosens första leveransdag', 'Show forecast’s first delivery day')}</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{t('Kvartsvärden i Stockholmstid. Spotpriset visas i euro per MWh.', 'Quarter-hour values in Stockholm time. Spot price is shown in euros per MWh.')}</p>
    </CardHeader>
    <CardContent className="min-w-0 space-y-6">
      {query.isLoading && <p role="status" className="text-sm text-muted-foreground">{t('Laddar marknadshistorik…', 'Loading market history…')}</p>}
      {query.isError && <div className="flex flex-wrap items-center gap-2 text-sm" role="alert">{t('Kunde inte hämta marknadshistoriken.', 'Could not load market history.')} <Button variant="outline" className="min-h-11" onClick={() => void query.refetch()}>{t('Försök igen', 'Try again')}</Button></div>}
      {query.data && <>
        {renderChart(t('Produktionsmix och spotpris', 'Generation mix and spot price'), generation, true)}
        {renderChart(t('Import, export och spotpris', 'Imports, exports and spot price'), flows, false)}
        {rows.length > 0 && <details className="min-w-0 overflow-hidden rounded-md border p-3 text-sm">
          <summary className="cursor-pointer py-2">{t('Visa marknadsvärden per kvart', 'Show market values by quarter')}</summary>
          <div className="mt-2 max-h-80 max-w-full overflow-auto" tabIndex={0} aria-label={t('Kvartsvärden', 'Quarter values')}>
            <table className="w-full whitespace-nowrap text-sm tabular-nums"><caption className="sr-only">{t('Spotpris i €/MWh, produktion och flöden i MW', 'Spot price in €/MWh, generation and flows in MW')}</caption>
              <thead><tr><th scope="col" className="px-2 py-2 text-left">{t('Tid', 'Time')}</th>{[price, ...generation, ...flows].map(item => <th scope="col" className="px-2 py-2 text-right" key={item.key}>{item.label}</th>)}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.at} className="border-t"><th scope="row" className="px-2 py-2 text-left font-normal">{detailedTimes.format(row.at)}</th>{[price, ...generation, ...flows].map(item => {
                const value = (row as Record<string, number | null>)[item.key];
                return <td className="px-2 py-2 text-right" key={item.key}>{value == null ? '—' : number.format(value)}</td>;
              })}</tr>)}</tbody>
            </table>
          </div>
        </details>}
      </>}
    </CardContent>
  </Card>;
}
