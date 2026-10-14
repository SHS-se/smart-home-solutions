import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { changeImpacts, untypedEvents, MIN_SIDE_DAYS, type ChangeImpact } from '@/lib/change-impact';
import { fetchEnergyDeviceReadings } from '@/lib/energy-device-readings';
import { ENERGY_EVENT_LABELS, treatmentOf } from '@/lib/energy-events';
import { fetchEnergyHistoryNotes, fetchEnergyUsageReadings, fetchSharedWeatherObservations } from '@/lib/energy-temperature-storage';
import { resolveDailyUsageReadings } from '@/lib/energy-usage-resolution';
import { buildMonthlyEnergyFlows, toDailyEnergyReadings } from '@/lib/energy-usage-series';
import { buildMonthlyEnergySavings, summariseEnergySavings } from '@/lib/energy-savings';
import { useEnergyBillingSeries } from '@/hooks/use-energy-billing-series';

// Same keys and lifetimes as the Energy history page, so both read one cached copy.
const CACHED = { staleTime: 5 * 60 * 1000, gcTime: 30 * 60 * 1000, refetchOnMount: false, refetchOnWindowFocus: false, retry: false } as const;
/** Enough complete years to describe normal weather without reading the whole station record. */
const NORMAL_WEATHER_YEARS = 10;

/**
 * What followed each lasting change the customer has recorded, in bought
 * electricity over a normal-weather year. Shown beside the savings estimate
 * because it is the same question asked of the past: what did a change do?
 */
export default function HomeChangesCard({ customerId, sekPerKwh }: { customerId: string; sekPerKwh: number | null }) {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const eventsPath = `${useLocation().pathname}?tab=setup&section=changes`;
  const notes = useQuery({ queryKey: ['energy-history-notes', customerId], queryFn: () => fetchEnergyHistoryNotes(customerId), enabled: !!customerId, ...CACHED });
  const hasChanges = (notes.data ?? []).some(note => treatmentOf(note.event_type) === 'step');
  const usage = useQuery({ queryKey: ['energy-usage-readings', customerId], queryFn: () => fetchEnergyUsageReadings(customerId), enabled: hasChanges, ...CACHED });
  const devices = useQuery({ queryKey: ['energy-device-readings', customerId], queryFn: () => fetchEnergyDeviceReadings(customerId), enabled: hasChanges, ...CACHED });
  const thisYear = new Date().getUTCFullYear();
  const weatherFrom = `${thisYear - NORMAL_WEATHER_YEARS}-01-01`, weatherTo = `${thisYear}-12-31`;
  const weather = useQuery({ queryKey: ['energy-shared-weather-observations', weatherFrom, weatherTo], queryFn: () => fetchSharedWeatherObservations(weatherFrom, weatherTo), enabled: hasChanges, ...CACHED, staleTime: 60 * 60 * 1000 });
  const readings = useMemo(() => usage.data && devices.data ? resolveDailyUsageReadings(usage.data, devices.data) : null, [usage.data, devices.data]);
  const impacts = useMemo(() => !hasChanges || !readings || !weather.data ? null : changeImpacts({
    bought: readings.filter(reading => reading.reading_kind === 'grid_import')
      .map(reading => ({ date: reading.reading_date, kwh: Number(reading.consumption_kwh) })),
    weather: weather.data.map(day => ({ observed_on: day.observed_on, temperature_c: Number(day.temperature_c) })),
    events: notes.data ?? [],
  }).reverse(), [hasChanges, readings, weather.data, notes.data]);
  // Solar and a battery need no before-and-after: what the home used without buying it is
  // measured directly, by comparing whole-home use with grid import, and priced from the bills.
  const generates = (impact: ChangeImpact) => impact.changes.some(change => change.eventType === 'solar_installed' || change.eventType === 'battery_installed');
  const hasGeneration = (notes.data ?? []).some(note => note.event_type === 'solar_installed' || note.event_type === 'battery_installed');
  const billing = useEnergyBillingSeries(customerId, hasGeneration);
  const flows = useMemo(() => readings ? buildMonthlyEnergyFlows(toDailyEnergyReadings(readings)) : null, [readings]);
  const generationValue = (date: string) => {
    if (!flows || billing.isLoading || billing.error) return null;
    const summary = summariseEnergySavings(buildMonthlyEnergySavings(billing.series.filter(month => month.monthKey >= date.slice(0, 7)), flows));
    return summary.savingSek !== null && summary.measuredMonths > 0 ? summary : null;
  };

  // Without access to energy history (no subscription) there is nothing to show and no error worth raising here.
  if (notes.isLoading || notes.isError || usage.isError || devices.isError || weather.isError) return null;
  const whole = (value: number) => Math.round(value).toLocaleString(locale);
  const signed = (value: number) => Math.round(value).toLocaleString(locale, { signDisplay: 'exceptZero' });
  const day = (date: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  const untyped = untypedEvents(notes.data ?? []);

  const month = (key: string) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`));
  const generated = (impact: ChangeImpact) => {
    const value = generates(impact) ? generationValue(impact.date) : null;
    if (!value) return null;
    const period = value.firstMeasuredMonth === value.lastMeasuredMonth ? month(value.firstMeasuredMonth!) : `${month(value.firstMeasuredMonth!)} – ${month(value.lastMeasuredMonth!)}`;
    return <p className="mt-1 text-sm" data-testid="home-change-generation">{t(
      `Uppmätt sedan dess: ${whole(value.selfConsumedKwh ?? 0)} kWh använt utan att köpa det och ${whole(value.exportedKwh ?? 0)} kWh sålt, värt ${whole(value.savingSek!)} SEK (${period}).`,
      `Measured since: ${whole(value.selfConsumedKwh ?? 0)} kWh used without buying it and ${whole(value.exportedKwh ?? 0)} kWh sold, worth ${whole(value.savingSek!)} SEK (${period}).`)}</p>;
  };

  const finding = (impact: ChangeImpact) => {
    if (impact.status === 'insufficient') return <p className="text-sm text-muted-foreground">{
      impact.reason === 'before_short' ? t(`Kräver minst ${MIN_SIDE_DAYS} dagar med dagliga värden före förändringen (${impact.beforeDays} hittills).`, `Needs at least ${MIN_SIDE_DAYS} days of daily readings before the change (${impact.beforeDays} so far).`)
        : impact.reason === 'after_short' ? t(`Kräver minst ${MIN_SIDE_DAYS} dagar med dagliga värden efter förändringen (${impact.afterDays} hittills).`, `Needs at least ${MIN_SIDE_DAYS} days of daily readings after the change (${impact.afterDays} so far).`)
        : impact.reason === 'no_heating_season' ? t('Kan mätas först när en uppvärmningssäsong har passerat efter förändringen.', 'Measurable once a heating season has passed since the change.')
        : t('Väderdata saknas.', 'Weather data is missing.')}</p>;
    if (!impact.clear) return <p className="text-sm text-muted-foreground">{t(
      `Ingen tydlig förändring: ${signed(impact.changeKwhPerYear)} kWh per år ligger inom den normala variationen på ±${whole(impact.noiseKwhPerYear)}.`,
      `No clear change: ${signed(impact.changeKwhPerYear)} kWh per year is within the normal variation of ±${whole(impact.noiseKwhPerYear)}.`)}</p>;
    return <>
      <p className={`text-lg font-semibold tabular-nums ${impact.changeKwhPerYear < 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`} data-testid="home-change-figure">
        {signed(impact.changeKwhPerYear)} kWh {t('per år', 'per year')}
        {sekPerKwh !== null && <span className="ml-2 text-sm font-normal text-muted-foreground">{t('cirka', 'about')} {signed(impact.changeKwhPerYear * sekPerKwh)} SEK {t('per år med dagens rörliga pris', 'per year at today’s variable price')}</span>}
      </p>
      <p className="text-xs text-muted-foreground">{t(
        `${whole(impact.beforeKwhPerYear)} → ${whole(impact.afterKwhPerYear)} kWh köpt el, över de ${whole(impact.comparedDaysPerYear)} dagar av ett normalår som båda perioderna har mätt. Normal variation ±${whole(impact.noiseKwhPerYear)}.`,
        `${whole(impact.beforeKwhPerYear)} → ${whole(impact.afterKwhPerYear)} kWh bought, over the ${whole(impact.comparedDaysPerYear)} days of a normal year that both periods measured. Normal variation ±${whole(impact.noiseKwhPerYear)}.`)}</p>
    </>;
  };

  return <Card data-testid="home-changes"><CardHeader><CardTitle className="text-lg">{t('Förändringar i huset', 'Changes to your home')}</CardTitle>
    <p className="text-sm text-muted-foreground">{t('Köpt el under ett normalt väderår, året före och året efter varje förändring du har registrerat.', 'Bought electricity in a normal-weather year, the year before and the year after each change you have recorded.')}</p>
  </CardHeader><CardContent className="space-y-4">
    {impacts === null && hasChanges && <p className="text-sm text-muted-foreground">{t('Beräknar…', 'Calculating…')}</p>}
    {impacts?.map(impact => <div key={impact.changes.map(change => change.id).join('|')} className="border-t pt-3 first:border-t-0 first:pt-0" data-testid="home-change">
      <p className="text-sm font-medium">{impact.changes.map(change => t(ENERGY_EVENT_LABELS[change.eventType].sv, ENERGY_EVENT_LABELS[change.eventType].en)).join(' + ')}
        <span className="ml-2 font-normal text-muted-foreground">{day(impact.date)}</span></p>
      {impact.changes.some(change => change.text) && <p className="mb-1 truncate text-xs text-muted-foreground">{impact.changes.map(change => change.text.split('\n')[0]).filter(Boolean).join(' · ')}</p>}
      {finding(impact)}
      {generated(impact)}
    </div>)}
    {!hasChanges && <p className="text-sm text-muted-foreground" data-testid="home-changes-empty">{untyped === 0
      ? t('Registrera renoveringar och installationer som händelser, så mäts vad som följde.', 'Record renovations and installations as events, and what followed is measured.')
      : untyped === 1
        ? t('En registrerad händelse saknar typ. Ange vad den var, till exempel renovering eller solceller, så mäts vad som följde.', 'One recorded event has no type. Say what it was, such as a renovation or solar panels, and what followed is measured.')
        : t(`${untyped} registrerade händelser saknar typ. Ange vad de var, till exempel renovering eller solceller, så mäts vad som följde.`, `${untyped} recorded events have no type. Say what they were, such as a renovation or solar panels, and what followed is measured.`)}</p>}
    <p className="text-xs text-muted-foreground">
      {hasChanges && t('Siffran är förändringen som följde efter datumet. Den hör till den registrerade förändringen bara om allt annat som ändrats i huset också är registrerat. ', 'The figure is the change that followed the date. It belongs to the recorded change only if everything else that changed in the home is recorded too. ')}
      <Link className="underline" to={eventsPath}>{t('Hantera händelser', 'Manage events')}</Link>
    </p>
  </CardContent></Card>;
}
