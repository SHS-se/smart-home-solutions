import { assert, assertEquals } from '@std/assert';
import { blendWeatherPrice, priceWeatherFeeds } from './live-weather-price.ts';
import type { RegionalWeatherHour } from './price-weather.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const origin = '2026-10-24T22:10:00Z'; // 25 October in Stockholm, before the clock change.
const cycle = '2026-10-24T18:00:00Z';
const first = Date.parse(cycle) - 28 * DAY;
const last = Date.parse('2026-10-30T00:00:00Z');
const starts = ['2026-10-26T22:45:00.000Z', '2026-10-26T23:00:00.000Z',
  '2026-10-27T12:00:00.000Z', '2026-10-27T23:00:00.000Z',
  '2026-10-28T12:00:00.000Z', '2026-10-28T23:00:00.000Z'];

function wind(at: number) {
  return 0.55 + 0.4 * Math.sin(at / HOUR / 31);
}

function feed(source: 'ecmwf' | 'gfs', gap?: number) {
  const history: RegionalWeatherHour[] = [], forecast: RegionalWeatherHour[] = [];
  for (let at = first; at <= last; at += HOUR) {
    if (at === gap) continue;
    const input = at < Date.parse(origin) ? wind(at) : source === 'ecmwf' ? 0.15 : 0.9;
    const hour: RegionalWeatherHour = [at, input, 10, 0];
    (at < Date.parse(cycle) ? history : forecast).push(hour);
  }
  return { source, forecast_cycle: cycle, history, forecast };
}

function scenario() {
  const archive: { start_ts: string; import_price_sek_per_kwh: number }[] = [];
  for (let at = first; at < Date.parse(origin) - HOUR; at += HOUR / 4) {
    if (at === first + 8 * DAY) continue; // A missing middle quarter is ordinary.
    archive.push({ start_ts: new Date(at).toISOString(), import_price_sek_per_kwh: Math.exp(1.8 - 2 * wind(at)) });
  }
  archive.push({ start_ts: starts[4], import_price_sek_per_kwh: -0.1 });
  return { origin, archive, baseline: [1, 1, 0, 1, -0.1, 1], plannedSlots: starts.length,
    slots: starts.map((start, index) => ({ start, import_price_sek_per_kwh: index === 2 ? 0 : null })) };
}

Deno.test('SE3 price preparation averages the two fitted prices only on unpublished D+2/D+3 Stockholm quarters', () => {
  const input = scenario();
  const ecmwf = blendWeatherPrice({ ...input, feeds: priceWeatherFeeds([feed('ecmwf')]) });
  const gfs = blendWeatherPrice({ ...input, feeds: priceWeatherFeeds([feed('gfs')]) });
  const combined = blendWeatherPrice({ ...input, feeds: priceWeatherFeeds([feed('ecmwf'), feed('gfs')]) });
  for (const index of [1, 3]) {
    assert(ecmwf.prices[index] !== gfs.prices[index]);
    assertEquals(combined.prices[index], (ecmwf.prices[index] + gfs.prices[index]) / 2);
    assertEquals(combined.sources[starts[index]], 'blend');
    assertEquals(ecmwf.sources[starts[index]], 'ecmwf');
    assertEquals(gfs.sources[starts[index]], 'gfs');
  }
  for (const index of [0, 2, 4, 5]) assertEquals(combined.prices[index], input.baseline[index]);
  assertEquals(combined.counts, { blend: 2, ecmwf: 0, gfs: 0, existing: 0 });
});

Deno.test('a missing feed, individual hour, or unusable history leaves a price from the surviving source', () => {
  const input = scenario();
  const gfs = blendWeatherPrice({ ...input, feeds: priceWeatherFeeds([feed('gfs')]) });
  const ecmwf = blendWeatherPrice({ ...input, feeds: priceWeatherFeeds([feed('ecmwf')]) });
  const firstTargetHour = Date.parse(starts[1]);
  const gap = blendWeatherPrice({ ...input, feeds: priceWeatherFeeds([feed('ecmwf', firstTargetHour), feed('gfs')]) });
  assertEquals(gap.prices[1], gfs.prices[1]);
  assertEquals(gap.sources[starts[1]], 'gfs');
  assertEquals(gap.sources[starts[3]], 'blend');
  const unusable = blendWeatherPrice({ ...input, feeds: priceWeatherFeeds([feed('ecmwf'),
    { ...feed('gfs'), history: [], forecast: [['not an hour', 0, 0, 0]] }]) });
  assertEquals(unusable, ecmwf);
  const noWeather = blendWeatherPrice({ ...input, feeds: {} });
  assertEquals(noWeather.prices, input.baseline);
  assertEquals(noWeather.counts, { blend: 0, ecmwf: 0, gfs: 0, existing: 2 });
});
