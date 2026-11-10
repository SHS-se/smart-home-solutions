/** Independently generated synthetic weather and prices. No household forecasts or measured prices. */
import { assert, assertEquals } from '@std/assert';
import { buildWeatherPrice, type WeatherPriceInput, type WeatherSite } from './price-weather.ts';

const HOUR = 3_600_000, QUARTER = 900_000, DAY = 86_400_000;
const ORIGIN = Date.parse('2026-03-20T10:47:00Z');
const FIRST_HOUR = Date.parse('2026-02-20T00:00:00Z');
const wind = (at: number) => 7 + 4 * Math.sin(at / DAY * 1.3) + 2 * Math.sin(at / DAY * 0.31);
const windPower = (speed: number) => Math.min(1, Math.max(0, (speed ** 3 - 27) / 1701));
/** Synthetic market: windier hours are cheaper, evenings dearer. */
const price = (at: number) => Math.exp(0.9 - 1.1 * windPower(wind(Math.floor(at / HOUR) * HOUR)) + 0.2 * Math.sin((at % DAY) / DAY * 2 * Math.PI));
function site(offset = 0): WeatherSite {
  const times = Array.from({ length: 35 * 24 }, (_, hour) => new Date(FIRST_HOUR + hour * HOUR).toISOString());
  return { times, series: {
    wind_speed_120m: times.map(time => wind(Date.parse(time)) + offset), temperature_2m: times.map((_, hour) => 4 + Math.sin(hour / 5)),
    shortwave_radiation: times.map((_, hour) => Math.max(0, 200 * Math.sin((hour % 24 - 6) / 12 * Math.PI))),
  } };
}
function input(): WeatherPriceInput {
  const history: WeatherPriceInput['history'] = [];
  for (let at = FIRST_HOUR + DAY; at < ORIGIN; at += QUARTER) history.push({ start: new Date(at).toISOString(), price: price(at) });
  const targets = Array.from({ length: 192 }, (_, quarter) => new Date(Date.parse('2026-03-21T23:00:00Z') + quarter * QUARTER).toISOString());
  return { origin: new Date(ORIGIN).toISOString(), history, targets, weather: { id: 'synthetic-weather', sites: [site(), site()] } };
}

Deno.test('a windier target quarter is forecast cheaper and the synthetic relation is recovered', () => {
  const result = buildWeatherPrice(input());
  assertEquals(result.status, 'forecast');
  assertEquals(result.targets.length, 192);
  const errors = result.targets.map(target => Math.abs(target.candidate! - price(Date.parse(target.start))) / price(Date.parse(target.start)));
  assert(errors.reduce((sum, value) => sum + value, 0) / errors.length < 0.08);
  assert(result.trainingQuarters > 96 * 20);
});

Deno.test('a missing weather value leaves that quarter unforecast: no zero, no neighbour, no other source', () => {
  const data = input();
  const gap = Date.parse(data.targets[40]), hour = Math.floor(gap / HOUR) * HOUR;
  const index = data.weather!.sites[1].times.indexOf(new Date(hour).toISOString());
  data.weather!.sites[1].series.wind_speed_120m[index] = null;
  const result = buildWeatherPrice(data);
  const missing = result.targets.filter(target => target.candidate === null);
  // The whole local day loses its day-mean wind only when fewer than 23 hours remain; one hour removes four quarters.
  assertEquals(missing.length, 4);
  assert(missing.every(target => target.reason === 'weather_missing' && Math.floor(Date.parse(target.start) / HOUR) * HOUR === hour));
  assertEquals(result.status, 'forecast');
});

Deno.test('no weather document or less than a week of known prices is an explicit unavailable run', () => {
  const none = buildWeatherPrice({ ...input(), weather: null });
  assertEquals([none.status, none.reason, none.targets.every(target => target.candidate === null)], ['unavailable', 'weather_missing', true]);
  const short = input(); short.history = short.history.slice(-96 * 6);
  const result = buildWeatherPrice(short);
  assertEquals([result.status, result.reason, result.trainingQuarters], ['unavailable', 'history_too_short', 96 * 6]);
});

Deno.test('the last known day lifts the level, and less so one day further out', () => {
  const plain = buildWeatherPrice(input());
  const lifted = input();
  const lastKnown = Date.parse(lifted.history[lifted.history.length - 1].start);
  for (const row of lifted.history) if (Date.parse(row.start) > lastKnown - DAY) row.price *= 1.5;
  const result = buildWeatherPrice(lifted);
  const ratio = (index: number) => result.targets[index].candidate! / plain.targets[index].candidate!;
  assert(result.anchor! > plain.anchor!);
  assert(ratio(0) > 1 && ratio(100) > 1);
  assert(ratio(0) > ratio(100));
});
