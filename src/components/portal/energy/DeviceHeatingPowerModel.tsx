import { useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, XAxis, YAxis,
} from 'recharts';
import { z } from 'zod';
import { ChartContainer } from '@/components/ui/chart';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { WEATHER_HEATING_METHOD } from '../../../../supabase/functions/_shared/planner/weather-heating';

const weatherBand = z.object({
  outdoor_c: z.number(),
  min_c: z.number(),
  max_c: z.number(),
  watts: z.number().positive(),
  spread_w: z.number().nonnegative(),
  days: z.number().int().positive(),
  hours: z.number().positive(),
}).refine(band => band.min_c <= band.outdoor_c && band.outdoor_c <= band.max_c);

const weatherProfile = z.object({
  method: z.literal(WEATHER_HEATING_METHOD),
  points: z.array(weatherBand),
});

type WeatherBand = z.infer<typeof weatherBand>;

function HeatingPowerChart({ bands, title }: { bands: WeatherBand[]; title: string }) {
  const { language, t } = useLanguage();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const bandId = useId();
  const first = bands[0], last = bands[bands.length - 1];
  const activeIndex = Math.min(selectedIndex, bands.length - 1);
  const selected = bands[activeIndex];
  const format = (value: number, digits: number) => value.toLocaleString(language === 'sv' ? 'sv-SE' : 'en-GB', {
    maximumFractionDigits: digits,
  });
  const label = (band: WeatherBand) => band.min_c === band.max_c
    ? `${format(band.min_c, 1)} °C`
    : `${format(band.min_c, 1)}–${format(band.max_c, 1)} °C`;
  const power = (watts: number) => `${format(watts / 1000, 3)} kW`;
  const data: { temperature: number; typical: number | null; estimate: number }[] = bands.map(band => ({
    temperature: band.outdoor_c, typical: band.watts / 1000, estimate: band.watts / 1000,
  }));
  if (first.min_c < first.outdoor_c) data.unshift({ temperature: first.min_c, typical: null, estimate: first.watts / 1000 });
  if (last.max_c > last.outdoor_c) data.push({ temperature: last.max_c, typical: null, estimate: last.watts / 1000 });
  const color = 'hsl(var(--primary))';

  return <>
    <ChartContainer className="h-56 w-full min-w-0" config={{}}
      role="img" aria-label={title} aria-describedby={`${bandId}-legend`}>
      <ComposedChart data={data} margin={{ top: 12, right: 20, bottom: 22, left: 0 }}>
        <CartesianGrid vertical={false} className="stroke-border" />
        <XAxis type="number" dataKey="temperature" domain={[Math.floor(first.min_c) - 1, Math.ceil(last.max_c) + 1]}
          tickFormatter={value => format(value, 1)} minTickGap={18}
          label={{ value: t('Utomhustemperatur (°C)', 'Outdoor temperature (°C)'), position: 'bottom', fill: 'hsl(var(--muted-foreground))' }} />
        <YAxis width={44} domain={[0, Math.max(...bands.map(band => (band.watts + band.spread_w) / 1000))]}
          tickFormatter={value => format(value, 2)}
          label={{ value: 'kW', angle: -90, position: 'insideLeft', fill: 'hsl(var(--muted-foreground))' }} />
        {bands.map(band => (
          <ReferenceArea key={band.outdoor_c} x1={band.min_c} x2={band.max_c}
            y1={Math.max(0, band.watts - band.spread_w) / 1000} y2={(band.watts + band.spread_w) / 1000}
            fill={color} fillOpacity={band === selected ? 0.26 : 0.13} stroke="none" />
        ))}
        <ReferenceLine x={selected.outdoor_c} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 4" />
        {bands.length > 1 && <Line dataKey="estimate" stroke={color} strokeDasharray="4 4" dot={false} isAnimationActive={false} />}
        <Line dataKey="typical" stroke="none" dot={{ r: 4, fill: color, stroke: 'none' }}
          activeDot={false} isAnimationActive={false} />
      </ComposedChart>
    </ChartContainer>
    <p id={`${bandId}-legend`} className="text-xs text-muted-foreground">
      {t('Punkter visar medianen av dagarnas effekt vid uppvärmning. Fälten visar observerade utomhustemperaturer och typisk variation kring medianen.',
        'Dots show median daily draw while heating. Shading shows the observed outdoor temperatures and typical variation around the median.')}
      {bands.length > 1 && ` ${t('Den streckade linjen visar modellens uppskattning.', 'The dashed line shows the model estimate.')}`}
    </p>
    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      <label htmlFor={bandId} className="font-medium">{t('Utomhustemperaturintervall', 'Outdoor temperature band')}</label>
      <select id={bandId} className="min-h-11 rounded-md border border-input bg-background px-3"
        value={activeIndex} onChange={event => setSelectedIndex(Number(event.target.value))}>
        {bands.map((band, index) => <option key={band.outdoor_c} value={index}>{label(band)}</option>)}
      </select>
    </div>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-live="polite">
      <div><dt className="text-muted-foreground">{t('Typisk effekt', 'Typical draw')}</dt><dd className="font-medium">{power(selected.watts)}</dd></div>
      <div><dt className="text-muted-foreground">{t('Typisk variation', 'Typical variation')}</dt><dd className="font-medium">±{power(selected.spread_w)}</dd></div>
      <div><dt className="text-muted-foreground">{t('Observerade dagar', 'Observed days')}</dt><dd className="font-medium">{format(selected.days, 0)}</dd></div>
      <div><dt className="text-muted-foreground">{t('Uppvärmningstimmar', 'Heating hours')}</dt><dd className="font-medium">{format(selected.hours, 2)}</dd></div>
    </dl>
  </>;
}

export default function DeviceHeatingPowerModel({ homeId, deviceKey, children }: {
  homeId: string;
  deviceKey: string;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  const model = useQuery({
    queryKey: ['device-heating-power-model', homeId, deviceKey],
    queryFn: async () => {
      const { data, error } = await supabase.from('energy_optimisation_device_operating_points')
        .select('operating_points').eq('home_id', homeId).eq('device_key', deviceKey)
        .filter('operating_points->>method', 'eq', WEATHER_HEATING_METHOD).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return weatherProfile.parse(data.operating_points).points;
    },
  });
  if (model.isPending) return <p className="text-sm text-muted-foreground">{t('Laddar enhetsmodell…', 'Loading device model…')}</p>;
  if (model.isError) return <p className="text-sm text-destructive" role="alert">{t('Kunde inte läsa enhetsmodellen.', 'Could not load the device model.')}</p>;
  if (model.data === null) return children;
  const title = t('Eleffekt vid uppvärmning efter utomhustemperatur', 'Heating power by outdoor temperature');
  return <section className="space-y-3 rounded-md border p-4 text-sm">
    <h3 className="font-semibold">{title}</h3>
    {model.data.length > 0 ? <HeatingPowerChart bands={model.data} title={title} />
      : <p className="text-muted-foreground">{t('Samlar in mätningar av effekt vid uppvärmning.', 'Collecting power readings while heating.')}</p>}
  </section>;
}
