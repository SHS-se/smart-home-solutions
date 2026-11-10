import { assertEquals } from '@std/assert';
import { createWeatherPriceHandler, type WeatherPriceContext, type WeatherPriceStore } from '../supabase/functions/energy-price-weather-experiment/index.ts';
import type { WeatherPriceForecast } from '../supabase/functions/_shared/price-weather.ts';

const TEST = 'https://vxqpgbzseckgceopitpm.supabase.co';
const post = (body: unknown = {}, token: string | null = 'synthetic-token') => new Request('https://example.test', { method: 'POST',
  headers: token ? { 'x-energy-market-archive-token': token } : {}, body: JSON.stringify(body) });
function store(context: WeatherPriceContext, saved: { baselineId: string; forecast: WeatherPriceForecast }[] = [], ticks: (string | null)[] = []): WeatherPriceStore {
  return { verifyToken: token => Promise.resolve(token === 'synthetic-token'),
    context: tick => { ticks.push(tick); return Promise.resolve(context); },
    record: (baselineId, forecast) => { saved.push({ baselineId, forecast }); return Promise.resolve({ status: forecast.status, id: 'run', kind: 'prospective' }); } };
}

Deno.test('weather price worker refuses any project but TEST, and any caller without the archive token', async () => {
  const ready: WeatherPriceContext = { status: 'no_household_forecast' };
  assertEquals((await createWeatherPriceHandler('https://oosxndduqzhvrorgogaw.supabase.co', store(ready))(post())).status, 403);
  assertEquals((await createWeatherPriceHandler(TEST, store(ready))(new Request('https://example.test'))).status, 405);
  assertEquals((await createWeatherPriceHandler(TEST, store(ready))(post({}, null))).status, 401);
  assertEquals((await createWeatherPriceHandler(TEST, store(ready))(post({}, 'wrong'))).status, 401);
  assertEquals((await createWeatherPriceHandler(TEST, store(ready))(post({ tick: 'yesterday' }))).status, 400);
});

Deno.test('weather price worker saves an explicit unavailable run when the frozen context has no weather, and passes the replay tick through', async () => {
  const saved: { baselineId: string; forecast: WeatherPriceForecast }[] = [], ticks: (string | null)[] = [];
  const context: WeatherPriceContext = { status: 'ready', baselineId: 'base', truthCutoff: 4, origin: '2026-03-20T10:47:00Z',
    history: [], targets: ['2026-03-22T10:00:00.000Z'], weather: null };
  const response = await createWeatherPriceHandler(TEST, store(context, saved, ticks))(post({ tick: '2026-03-20T10:50:00Z' }));
  assertEquals(await response.json(), { status: 'unavailable', id: 'run', kind: 'prospective', training_quarters: 0, forecast_quarters: 0, target_quarters: 1 });
  assertEquals(ticks, ['2026-03-20T10:50:00Z']);
  assertEquals([saved[0].baselineId, saved[0].forecast.targets[0].candidate, saved[0].forecast.reason], ['base', null, 'weather_missing']);
  const idle = await createWeatherPriceHandler(TEST, store({ status: 'already_saved', baselineId: 'base' }, saved))(post());
  assertEquals([await idle.json(), saved.length], [{ status: 'already_saved' }, 1]);
});
