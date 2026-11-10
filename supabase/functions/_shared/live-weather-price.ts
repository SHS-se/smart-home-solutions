import { localDay } from './planner-wasm/calendar.ts';
import type { StoredPriceRow } from './planner/energy-price-shape.ts';
import type { WeatherPriceSource } from './planner/planning-contracts.ts';
import { fitWeatherPrice, type RegionalWeatherHour } from './price-weather.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const PRICE_WEATHER_TABLE = 'energy_price_weather_feeds';
type Feed = 'ecmwf' | 'gfs';
type PriceWeather = NonNullable<Parameters<typeof fitWeatherPrice>[1]>;
type PriceSlot = { start: string; import_price_sek_per_kwh: number | null };

function weatherHours(rows: unknown): RegionalWeatherHour[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is RegionalWeatherHour =>
    Array.isArray(row) && row.length === 4 && row.every(Number.isFinite) && row[0] % HOUR === 0);
}

/** Each feed is independent. A malformed or missing hour has no estimate. */
export function priceWeatherFeeds(rows: unknown): Partial<Record<Feed, PriceWeather>> {
  const feeds: Partial<Record<Feed, PriceWeather>> = {};
  if (!Array.isArray(rows)) return feeds;
  for (const row of rows) {
    if (!row || (row.source !== 'ecmwf' && row.source !== 'gfs')) continue;
    const cycle = Date.parse(row.forecast_cycle);
    const forecast = weatherHours(row.forecast).filter(([at]) => at >= cycle);
    if (!forecast.length) continue;
    const hours = [...weatherHours(row.history).filter(([at]) => at < cycle), ...forecast];
    feeds[row.source as Feed] = { id: row.forecast_cycle, hours };
  }
  return feeds;
}

/** Overlay the two fitted price curves only on unpublished Stockholm D+2/D+3 quarters. */
export function blendWeatherPrice(options: {
  origin: string;
  slots: readonly PriceSlot[];
  archive: readonly StoredPriceRow[];
  baseline: number[];
  feeds: Partial<Record<Feed, PriceWeather>>;
  plannedSlots: number;
}) {
  const { origin, slots, archive, baseline, feeds, plannedSlots } = options;
  const from = Date.parse(origin) - 28 * DAY;
  const known = new Map<number, { start: string; price: number }>();
  const remember = (start: string, price: number | null) => {
    const at = Date.parse(start);
    if (at >= from && price !== null && Number.isFinite(price)) known.set(at, { start, price });
  };
  for (const row of archive) remember(row.start_ts, row.import_price_sek_per_kwh);
  for (const slot of slots) remember(slot.start, slot.import_price_sek_per_kwh);

  const stockholm = 'Europe/Stockholm';
  const originDay = Date.parse(localDay(origin, stockholm));
  const selected = slots.flatMap((slot, index) => {
    if (known.has(Date.parse(slot.start))) return [];
    const lead = (Date.parse(localDay(slot.start, stockholm)) - originDay) / DAY;
    return lead === 2 || lead === 3 ? [{ start: slot.start, index }] : [];
  });
  const counts = { blend: 0, ecmwf: 0, gfs: 0, existing: 0 };
  const sources: Record<string, WeatherPriceSource> = {};
  if (!selected.length) return { prices: baseline, sources, counts };
  const input = { origin, history: [...known.values()], targets: selected.map(({ start }) => start) };
  const fit = (source: Feed) => {
    const feed = feeds[source];
    if (!feed) return;
    const firstHour = Math.floor(from / HOUR) * HOUR;
    try { return fitWeatherPrice(input, { ...feed, hours: feed.hours.filter(([at]) => at >= firstHour) }).targets; }
    catch { console.warn("[ENERGY-FORECAST] regional price fit unavailable", { source }); }
  };
  const ecmwf = fit('ecmwf');
  const gfs = fit('gfs');
  const prices = baseline.slice();
  for (const [target, { index, start }] of selected.entries()) {
    const a = ecmwf?.[target].candidate ?? NaN;
    const b = gfs?.[target].candidate ?? NaN;
    const hasEcmwf = Number.isFinite(a);
    const hasGfs = Number.isFinite(b);
    const source = hasEcmwf && hasGfs ? 'blend' : hasEcmwf ? 'ecmwf' : hasGfs ? 'gfs' : 'existing';
    if (index < plannedSlots) counts[source]++;
    if (source === 'existing') continue;
    prices[index] = source === 'blend' ? a / 2 + b / 2 : source === 'ecmwf' ? a : b;
    sources[new Date(start).toISOString()] = source;
  }
  return { prices, sources, counts };
}
