/** The weather-price regression shared by the TEST replay and live forecasts. */
import { fitRidge, predictRidge } from './ridge.ts';

export const WEATHER_PRICE_ALGORITHM = 'se3-weather-price-v1';
const TIME_ZONE = 'Europe/Stockholm';
const HOUR = 3_600_000, DAY = 86_400_000;
/** Fewer known quarters than one week cannot separate the daily shape from the weather. */
const MIN_TRAINING_QUARTERS = 96 * 7;
/** Share of the last known day's level error that is left after each further day of lead. */
const ANCHOR_PER_DAY = 0.7;
const PRICE_FLOOR = 0.05;

export interface WeatherSite {
  times: string[];
  series: { wind_speed_120m: (number | null)[]; temperature_2m: (number | null)[]; shortwave_radiation: (number | null)[] };
}
export interface WeatherPriceInput {
  /** Everything below was available at this instant. */
  origin: string;
  /** Newest known price per quarter, at most 28 days back, including published future quarters. */
  history: { start: string; price: number }[];
  /** Quarters to forecast: unpublished at the origin. */
  targets: string[];
  /** One weather document: its past hours train the model, its future hours drive the targets. */
  weather: { id: string; sites: WeatherSite[] } | null;
}
export interface WeatherPriceTarget { start: string; candidate: number | null; reason: 'weather_missing' | null }
export interface WeatherPriceForecast {
  algorithm: typeof WEATHER_PRICE_ALGORITHM;
  status: 'forecast' | 'unavailable';
  reason: 'weather_missing' | 'history_too_short' | null;
  weatherObservationId: string | null;
  trainingQuarters: number;
  /** Mean log error of the last known day, before decay. */
  anchor: number | null;
  targets: WeatherPriceTarget[];
}

const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
function local(at: number) {
  const value = Object.fromEntries(parts.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return { day: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour) + Number(value.minute) / 60,
    weekend: value.weekday === 'Sat' || value.weekday === 'Sun' };
}
/** Cubic wind power proxy between cut-in (3 m/s) and rated speed (12 m/s). Not a generation figure. */
const windPower = (speed: number) => Math.min(1, Math.max(0, (speed ** 3 - 27) / (1728 - 27)));

export type RegionalWeatherHour = readonly [at: number, wind: number, temperature: number, radiation: number];
interface HourlyWeather { wind: number; temperature: number; radiation: number }
/** Ten-site means per hour. An hour with any missing site value stays missing. */
export function regionalWeatherHours(sites: WeatherSite[]): RegionalWeatherHour[] {
  const hours: RegionalWeatherHour[] = [];
  if (!sites.length) return hours;
  sites[0].times.forEach((time, index) => {
    let wind = 0, temperature = 0, radiation = 0;
    for (const site of sites) {
      if (site.times[index] !== time) return;
      const speed = site.series.wind_speed_120m?.[index], temp = site.series.temperature_2m?.[index], sun = site.series.shortwave_radiation?.[index];
      if (typeof speed !== 'number' || typeof temp !== 'number' || typeof sun !== 'number'
        || !Number.isFinite(speed) || !Number.isFinite(temp) || !Number.isFinite(sun)) return;
      wind += windPower(speed); temperature += temp; radiation += sun;
    }
    hours.push([Date.parse(time), wind / sites.length, temperature / sites.length, radiation / sites.length]);
  });
  return hours;
}

export function buildWeatherPrice(input: WeatherPriceInput): WeatherPriceForecast {
  const weather = input.weather;
  return fitWeatherPrice(input, weather && { id: weather.id, hours: regionalWeatherHours(weather.sites) });
}

export function fitWeatherPrice(
  input: Omit<WeatherPriceInput, 'weather'>,
  weather: { id: string; hours: readonly RegionalWeatherHour[] } | null,
): WeatherPriceForecast {
  const unavailable = (reason: 'weather_missing' | 'history_too_short', trainingQuarters = 0): WeatherPriceForecast => ({
    algorithm: WEATHER_PRICE_ALGORITHM, status: 'unavailable', reason, weatherObservationId: weather?.id ?? null, trainingQuarters,
    anchor: null, targets: input.targets.map(start => ({ start, candidate: null, reason: reason === 'weather_missing' ? 'weather_missing' : null })) });
  if (!weather) return unavailable('weather_missing');
  const hours = new Map(weather.hours.map(([at, wind, temperature, radiation]) => [at, { wind, temperature, radiation } satisfies HourlyWeather]));
  // Local-day mean wind: the day's level follows the day's wind, the hour's shape the hour's.
  const byDay = new Map<string, number[]>();
  for (const [at, value] of hours) {
    const day = local(at).day, list = byDay.get(day) ?? [];
    list.push(value.wind); byDay.set(day, list);
  }
  const features = (at: number): number[] | null => {
    const weather = hours.get(Math.floor(at / HOUR) * HOUR);
    const place = local(at), day = byDay.get(place.day);
    // A 23-hour DST day is complete; anything shorter is a partial day at the edge of the document.
    if (!weather || !day || day.length < 23) return null;
    const angle = place.hour / 24 * 2 * Math.PI, weekend = place.weekend ? 1 : 0;
    const harmonics = [Math.sin(angle), Math.cos(angle), Math.sin(2 * angle), Math.cos(2 * angle), Math.sin(3 * angle), Math.cos(3 * angle)];
    return [weather.wind, weather.temperature, weather.radiation, day.reduce((sum, value) => sum + value, 0) / day.length,
      ...harmonics, weekend, ...harmonics.slice(0, 4).map(value => value * weekend)];
  };
  const rows: { at: number; x: number[]; y: number }[] = [];
  for (const { start, price } of input.history) {
    const at = Date.parse(start);
    if (!Number.isFinite(at) || !Number.isFinite(price)) continue;
    const x = features(at);
    if (x) rows.push({ at, x, y: Math.log(Math.max(price, PRICE_FLOOR)) });
  }
  if (rows.length < MIN_TRAINING_QUARTERS) return unavailable(hours.size ? 'history_too_short' : 'weather_missing', rows.length);
  rows.sort((left, right) => left.at - right.at);
  const fit = fitRidge(rows.map(row => row.x), rows.map(row => row.y));
  const lastKnown = rows[rows.length - 1].at;
  const recent = rows.filter(row => row.at > lastKnown - DAY);
  const anchor = recent.reduce((sum, row) => sum + row.y - predictRidge(fit, row.x), 0) / recent.length;
  const targets = input.targets.map((start): WeatherPriceTarget => {
    const at = Date.parse(start), x = Number.isFinite(at) ? features(at) : null;
    if (!x) return { start, candidate: null, reason: 'weather_missing' };
    return { start, candidate: Math.exp(predictRidge(fit, x) + anchor * ANCHOR_PER_DAY ** ((at - lastKnown) / DAY)), reason: null };
  });
  return { algorithm: WEATHER_PRICE_ALGORITHM, status: targets.some(target => target.candidate !== null) ? 'forecast' : 'unavailable',
    reason: targets.some(target => target.candidate !== null) ? null : 'weather_missing', weatherObservationId: weather.id,
    trainingQuarters: rows.length, anchor, targets };
}
