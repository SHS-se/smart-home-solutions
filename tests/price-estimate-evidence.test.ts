import { assertEquals } from '@std/assert';
import { testPriceForecastContext, recordTestPriceForecastGeneration, TEST_MARKET_PROJECT_URL,
  type MarketForecastContext, type PriceForecastGeneration } from '../supabase/functions/_shared/price-estimate-evidence.ts';

const context: MarketForecastContext = { known_at: '2026-10-22T16:00:00Z', datasets: {
  wind_day_ahead: { latest_attempt_id: 'wind-attempt', latest_data_id: 'wind-data' },
  load_day_ahead: { latest_attempt_id: 'load-failed', latest_data_id: 'load-prior-data' },
  load_week_ahead: { latest_attempt_id: null, latest_data_id: null },
  weather_medium_range: { latest_attempt_id: 'weather-attempt', latest_data_id: 'weather-data' },
} };
const generation: PriceForecastGeneration = {
  id: 'generation', home_id: 'home', generated_at: '2026-10-22T16:00:01Z',
  model_as_of: '2026-10-22T15:45:00Z', timezone: 'Europe/Stockholm', zone: 'SE3', algorithm: 'model', market_context: context,
  inputs: { format_version: 1, slot_starts: ['2026-10-24T00:00:00Z'], published_import_sek_per_kwh: [null],
    price_history_available: true, price_history: [], smhi_wind_outlook: { provider: 'smhi', zone: 'SE3', days: [{ day: '2026-10-24', mean_speed_m_s: 5 }] } },
  outlook: { shadowImportSekPerKwh: [1.4], levelSekPerKwh: 1.4, observedDays: 0, effectiveDays: 0, shaped: true, levelBasis: 'wind' },
};
Deno.test('price evidence never reads or writes outside TEST and SE3', async () => {
  let calls = 0;
  const db = { rpc: () => { calls++; return Promise.resolve({ data: context, error: null }); } };
  assertEquals(await testPriceForecastContext(db, 'https://oosxndduqzhvrorgogaw.supabase.co', 'SE3'), null);
  assertEquals(await testPriceForecastContext(db, TEST_MARKET_PROJECT_URL, 'SE4'), null);
  assertEquals(await recordTestPriceForecastGeneration(db, 'https://oosxndduqzhvrorgogaw.supabase.co', generation), false);
  assertEquals(calls, 0);
});
Deno.test('price evidence preserves pinned data IDs, exact wind inputs and separate generation/model clocks', async () => {
  const calls: { name: string; parameters?: Record<string, unknown> }[] = [];
  const db = { rpc: (name: string, parameters?: Record<string, unknown>) => {
    calls.push({ name, parameters }); return Promise.resolve({ data: name === 'read_test_price_forecast_context' ? context : null, error: null });
  } };
  const pinned = await testPriceForecastContext(db, TEST_MARKET_PROJECT_URL, 'SE3');
  assertEquals(pinned, context);
  assertEquals(await recordTestPriceForecastGeneration(db, TEST_MARKET_PROJECT_URL, { ...generation, market_context: pinned! }), true);
  assertEquals(calls, [{ name: 'read_test_price_forecast_context', parameters: undefined },
    { name: 'record_test_price_forecast_generation', parameters: { p_generation: generation } }]);
});
Deno.test('disabled and unavailable evidence remain explicit gaps without rejecting household estimates', async () => {
  const disabled = { rpc: () => Promise.resolve({ data: null, error: null }) };
  assertEquals(await testPriceForecastContext(disabled, TEST_MARKET_PROJECT_URL, 'SE3'), null);
  const unavailable = { rpc: () => Promise.resolve({ data: null, error: { code: 'storage_down' } }) };
  assertEquals(await testPriceForecastContext(unavailable, TEST_MARKET_PROJECT_URL, 'SE3'), null);
  assertEquals(await recordTestPriceForecastGeneration(unavailable, TEST_MARKET_PROJECT_URL, generation), false);
  const malformed = { rpc: () => Promise.resolve({ data: { known_at: 'not a timestamp' }, error: null }) };
  assertEquals(await testPriceForecastContext(malformed, TEST_MARKET_PROJECT_URL, 'SE3'), null);
});
