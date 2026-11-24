import { useState } from 'react';
import { CartesianGrid, ComposedChart, Line, ReferenceLine, Scatter, XAxis, YAxis } from 'recharts';
import { ChartContainer } from '@/components/ui/chart';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatHeatingRange, HEATING_BAND_WIDTH_C } from '../../../../supabase/functions/_shared/planner/heating-bands';
import type { HeatPumpStartup } from './heat-pump-startup-schema';
import { HeatingBandSelect } from './HeatingBandSelect';
import { useHomeTimeZone } from './HomeTimeZoneContext';

type Band = HeatPumpStartup['bands'][number];

const START = 'hsl(var(--destructive))';
const RUNNING = 'hsl(var(--primary))';
const MUTED = 'hsl(var(--muted-foreground))';

/** Even kW steps for an axis reaching at least `top`. */
function kwTicks(top: number) {
  const step = top > 2 ? 1 : 0.5, end = Math.max(step, Math.ceil(top / step) * step);
  return Array.from({ length: Math.round(end / step) + 1 }, (_, i) => i * step);
}

function Legend({ items }: { items: { label: string; color: string; mark: 'dash' | 'line' | 'dot' }[] }) {
  return <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    {items.map(item => <li key={item.label} className="flex items-center gap-1.5">
      <svg width="18" height="8" aria-hidden="true">{item.mark === 'dot'
        ? <circle cx="9" cy="4" r="3.5" fill={item.color} />
        : <line x1="0" y1="4" x2="18" y2="4" stroke={item.color} strokeWidth="2" strokeDasharray={item.mark === 'dash' ? '4 3' : undefined} />}</svg>
      {item.label}
    </li>)}
  </ul>;
}

function useFormat() {
  const { language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const number = (value: number, digits: number) => value.toLocaleString(locale, { maximumFractionDigits: digits });
  const kw = (value: number | null) => value === null ? '—' : `${number(value / 1000, 2)} kW`;
  return { locale, number, kw };
}

function StartPeaks({ model }: { model: HeatPumpStartup }) {
  const { t } = useLanguage();
  const { number, kw } = useFormat();
  const [selection, setSelection] = useState('');
  const bands = model.bands;
  const selected = bands.find(item => String(item.band_c) === selection)
    ?? bands.reduce<Band | null>((best, item) => !best || item.starts > best.starts ? item : best, null);
  const starts = model.starts.filter(start => start.peak_w !== null)
    .map(start => ({ x: start.outdoor_c, y: start.peak_w! / 1000 }));
  const title = t('Startspikar efter utomhustemperatur', 'Start-up peaks by outdoor temperature');
  const values = bands.flatMap(item => [item.start_peak_max_w, item.running_peak_w, item.first_hour_w, item.running_w])
    .filter((value): value is number => value !== null);
  const ticks = kwTicks(Math.max(0.5, ...starts.map(start => start.y), ...values.map(value => value / 1000)));
  const low = Math.min(...bands.map(item => item.band_c)), high = Math.max(...bands.map(item => item.band_c)) + HEATING_BAND_WIDTH_C;
  const segment = (item: Band, value: number | null) => value === null ? null
    : [{ x: item.band_c, y: value / 1000 }, { x: item.band_c + HEATING_BAND_WIDTH_C, y: value / 1000 }];
  const range = (item: Band) => formatHeatingRange(item.band_c, item.band_c + HEATING_BAND_WIDTH_C, value => number(value, 1));
  return <div className="space-y-3">
    <h4 className="font-medium">{title}</h4>
    {bands.length > 0 && <ChartContainer className="h-64 w-full min-w-0" config={{}} role="img" aria-label={title}>
      <ComposedChart margin={{ top: 12, right: 20, bottom: 22, left: 0 }}>
        <CartesianGrid vertical={false} className="stroke-border" />
        <XAxis type="number" dataKey="x" domain={[low - 1, high + 1]} tickFormatter={value => number(value, 0)} minTickGap={18}
          label={{ value: t('Utomhustemperatur (°C)', 'Outdoor temperature (°C)'), position: 'bottom', fill: MUTED }} />
        <YAxis type="number" dataKey="y" width={44} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={value => number(value, 1)}
          label={{ value: 'kW', angle: -90, position: 'insideLeft', fill: MUTED }} />
        {bands.map(item => {
          const peak = segment(item, item.start_peak_max_w), running = segment(item, item.running_peak_w);
          return [peak && <ReferenceLine key={`start-${item.band_c}`} segment={peak} stroke={START} strokeDasharray="4 4" />,
            running && <ReferenceLine key={`running-${item.band_c}`} segment={running} stroke={RUNNING} strokeDasharray="4 4" />];
        })}
        <Scatter data={starts} fill={START} fillOpacity={0.55} isAnimationActive={false} />
      </ComposedChart>
    </ChartContainer>}
    {bands.length > 0 && <Legend items={[
      { label: t('Start efter vila', 'Start after standing idle'), color: START, mark: 'dot' },
      { label: t('Högsta startspik i intervallet', 'Highest start-up peak in the band'), color: START, mark: 'dash' },
      { label: t('Högsta effekt under drift, avfrostning inräknad', 'Highest power while running, defrosts included'), color: RUNNING, mark: 'dash' },
    ]} />}
    <p className="text-xs text-muted-foreground">
      {starts.length
        ? t('En start är den högsta effekten i en timme som följer på en timme med under 100 W i medel.',
          'A start is the highest power in an hour that follows an hour averaging under 100 W.')
        : t('Inga effektspikar har tagits emot ännu. De skickas från Home Assistant med värmehistoriken.',
          'No power peaks have been received yet. Home Assistant sends them with the heating history.')}
    </p>
    {selected && <>
      <div className="border-t pt-3">
        <HeatingBandSelect options={bands.map(item => ({ key: String(item.band_c), label: range(item) }))}
          selected={String(selected.band_c)} onSelect={setSelection} />
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-live="polite">
        <div><dt className="text-muted-foreground">{t('Starter', 'Starts')}</dt><dd className="font-medium">{number(selected.starts, 0)}</dd></div>
        <div><dt className="text-muted-foreground">{t('Startspik, median', 'Start-up peak, median')}</dt><dd className="font-medium">{kw(selected.start_peak_w)}</dd></div>
        <div><dt className="text-muted-foreground">{t('Startspik, högsta', 'Start-up peak, highest')}</dt><dd className="font-medium">{kw(selected.start_peak_max_w)}</dd></div>
        <div><dt className="text-muted-foreground">{t('Starttimmens effekt', 'Start hour draw')}</dt><dd className="font-medium">{kw(selected.first_hour_w)}</dd></div>
        {selected.recovery_w.map((value, i) => <div key={i}>
          <dt className="text-muted-foreground">{t(`Timme ${i + 1} efter start`, `Hour ${i + 1} after the start`)}</dt>
          <dd className="font-medium">{kw(value)}{selected.recovery_peak_w[i] !== null &&
            <span className="text-muted-foreground"> · {t('topp', 'peak')} {kw(selected.recovery_peak_w[i])}</span>}</dd>
        </div>)}
        <div><dt className="text-muted-foreground">{t('Effekt under drift', 'Running draw')}</dt><dd className="font-medium">{kw(selected.running_w)}</dd></div>
        <div><dt className="text-muted-foreground">{t('Högsta effekt under drift', 'Highest power while running')}</dt><dd className="font-medium">{kw(selected.running_peak_w)}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">
        {t(`Mätt i intervallet: ${number(selected.running_hours, 0)} driftstimmar, medel ${number(selected.outdoor_c, 1)} °C utomhus. Medianer och högsta värden från mätarens timmar.`,
          `Measured in the band: ${number(selected.running_hours, 0)} running hours, ${number(selected.outdoor_c, 1)} °C outdoors on average. Medians and highest values from the meter's hours.`)}
      </p>
    </>}
  </div>;
}

function ModelCheck({ check }: { check: HeatPumpStartup['check'] }) {
  const { t } = useLanguage();
  const { locale, number, kw } = useFormat();
  const timeZone = useHomeTimeZone();
  const title = t('Modellkontroll, senaste 14 dagarna', 'Model check, last 14 days');
  if ('reason' in check) return <div className="space-y-1">
    <h4 className="font-medium">{title}</h4>
    <p className="text-muted-foreground">{check.reason === 'no_training_starts'
      ? t('Det finns ännu inga starter före de senaste 14 dagarna att träna kontrollen på.',
        'There are no starts before the last 14 days to train the check on yet.')
      : t('Värmepumpen har inte gått under de senaste 14 dagarna.', 'The heat pump has not run in the last 14 days.')}</p>
  </div>;
  // Every hour of the period, so the lines break where the heat pump stood idle.
  const byHour = new Map(check.hours.map(hour => [Date.parse(hour.at), hour]));
  const from = Date.parse(check.from), to = Date.parse(check.to);
  const data = Array.from({ length: Math.max(0, Math.round((to - from) / 3_600_000)) }, (_, i) => {
    const x = from + i * 3_600_000, hour = byHour.get(x);
    return { x, measured: hour ? hour.measured_w / 1000 : null,
      predicted: hour?.predicted_w == null ? null : hour.predicted_w / 1000,
      peak: hour?.start && hour.measured_peak_w != null ? hour.measured_peak_w / 1000 : null };
  });
  const dates = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short' });
  const ticks = kwTicks(Math.max(0.5, ...data.flatMap(row => [row.measured ?? 0, row.predicted ?? 0, row.peak ?? 0])));
  return <div className="space-y-3">
    <h4 className="font-medium">{title}</h4>
    <ChartContainer className="h-56 w-full min-w-0" config={{}} role="img" aria-label={title}>
      <ComposedChart data={data} margin={{ top: 12, right: 20, bottom: 8, left: 0 }}>
        <CartesianGrid vertical={false} className="stroke-border" />
        <XAxis type="number" dataKey="x" domain={[from, to]} scale="time"
          tickFormatter={value => dates.format(new Date(value))} minTickGap={24} />
        <YAxis width={44} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={value => number(value, 1)}
          label={{ value: 'kW', angle: -90, position: 'insideLeft', fill: MUTED }} />
        <Line dataKey="measured" stroke={MUTED} strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line dataKey="predicted" stroke={RUNNING} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls={false} isAnimationActive={false} />
        <Scatter dataKey="peak" fill={START} isAnimationActive={false} />
      </ComposedChart>
    </ChartContainer>
    <Legend items={[
      { label: t('Uppmätt effekt per timme', 'Measured hourly draw'), color: MUTED, mark: 'line' },
      { label: t('Modellens förutsägelse', 'Model prediction'), color: RUNNING, mark: 'dash' },
      { label: t('Uppmätt startspik', 'Measured start-up peak'), color: START, mark: 'dot' },
    ]} />
    <p className="text-xs text-muted-foreground">
      {t('Modellen tränas på data före perioden och förutsäger timmarna då värmepumpen gick, utifrån när den startade och utomhustemperaturen.',
        'The model is trained on data before the period and predicts the hours the heat pump ran, from when it started and the outdoor temperature.')}
    </p>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div><dt className="text-muted-foreground">{t('Fel per timme (medel)', 'Hourly error (mean)')}</dt>
        <dd className="font-medium">{check.draw_error_w === null ? '—' : `±${kw(check.draw_error_w)}`}</dd></div>
      <div><dt className="text-muted-foreground">{t('Systematiskt fel', 'Bias')}</dt>
        <dd className="font-medium">{check.draw_bias_w === null ? '—' : `${check.draw_bias_w > 0 ? '+' : ''}${kw(check.draw_bias_w)}`}</dd></div>
      <div><dt className="text-muted-foreground">{t('Startspikar inom modellens högsta', 'Start-up peaks within the model’s highest')}</dt>
        <dd className="font-medium">{check.starts ? `${number(check.starts_within_peak, 0)} / ${number(check.starts, 0)}` : '—'}</dd></div>
      <div><dt className="text-muted-foreground">{t('Drifttimmar inom modellens högsta', 'Running hours within the model’s highest')}</dt>
        <dd className="font-medium">{check.running_peak_hours ? `${number(check.running_peaks_within, 0)} / ${number(check.running_peak_hours, 0)}` : '—'}</dd></div>
    </dl>
    <p className="text-xs text-muted-foreground">{t(
      `Jämfört över ${number(check.running_hours, 0)} timmar då värmepumpen gick. Positivt systematiskt fel betyder att modellen räknar med mer effekt än som mättes.`,
      `Compared over ${number(check.running_hours, 0)} hours in which the heat pump ran. A positive bias means the model expects more power than was measured.`)}</p>
  </div>;
}

export function HeatPumpStartupSection({ model }: { model: HeatPumpStartup }) {
  const { t } = useLanguage();
  return <section className="space-y-4 rounded-md border p-4 text-sm">
    <h3 className="font-semibold">{t('Start och drift för värmepumpen', 'Heat pump start-up and running')}</h3>
    <StartPeaks model={model} />
    <div className="border-t pt-4"><ModelCheck check={model.check} /></div>
  </section>;
}
