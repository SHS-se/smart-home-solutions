/** Independent TEST worker: weather price forecasts are research records, never household forecasts. */
import { buildWeatherPrice, type WeatherPriceForecast, type WeatherPriceInput } from '../_shared/price-weather.ts';

export type WeatherPriceContext =
  | { status: 'disabled' | 'no_household_forecast' }
  | { status: 'already_saved'; baselineId: string }
  | ({ status: 'ready'; baselineId: string; truthCutoff: number } & WeatherPriceInput);
export interface WeatherPriceStore {
  verifyToken(token: string): Promise<boolean>;
  /** Frozen inputs as TEST held them when the deployed forecast was generated. */
  context(tick: string | null): Promise<WeatherPriceContext>;
  record(baselineId: string, forecast: WeatherPriceForecast): Promise<{ status: string; id?: string; kind?: string }>;
}
export function createWeatherPriceHandler(projectUrl: string, store: WeatherPriceStore) {
  return async (request: Request): Promise<Response> => {
    if (projectUrl !== 'https://vxqpgbzseckgceopitpm.supabase.co') return Response.json({ error: 'test_lane_only' }, { status: 403 });
    if (request.method !== 'POST') return Response.json({ error: 'post_required' }, { status: 405 });
    const token = request.headers.get('x-energy-market-archive-token');
    if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });
    try {
      if (!await store.verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const body: unknown = await request.json().catch(() => ({}));
      const tick = body && typeof body === 'object' && 'tick' in body ? (body as { tick: unknown }).tick : null;
      if (tick !== null && (typeof tick !== 'string' || !Number.isFinite(Date.parse(tick)))) return Response.json({ error: 'invalid_tick' }, { status: 400 });
      const context = await store.context(tick);
      if (context.status !== 'ready') return Response.json({ status: context.status });
      // A missing weather document or a short history is saved as an explicit unavailable run.
      const forecast = buildWeatherPrice(context);
      const saved = await store.record(context.baselineId, forecast);
      return Response.json({ ...saved, training_quarters: forecast.trainingQuarters,
        forecast_quarters: forecast.targets.filter(target => target.candidate !== null).length, target_quarters: forecast.targets.length });
    } catch {
      console.error('test_weather_price_failed');
      return Response.json({ error: 'test_weather_price_failed' }, { status: 500 });
    }
  };
}
if (import.meta.main) {
  const { createClient } = await import('@supabase/supabase-js');
  const projectUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const client = createClient(projectUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  Deno.serve(createWeatherPriceHandler(projectUrl, {
    async verifyToken(token) {
      const { data, error } = await client.rpc('verify_test_market_archive_token', { p_token: token });
      if (error) throw new Error('Weather price authentication failed');
      return data === true;
    },
    async context(tick) {
      const { data, error } = await client.rpc('read_test_weather_price_context', { p_tick: tick });
      if (error) throw new Error('Weather price context failed');
      return data;
    },
    async record(baselineId, forecast) {
      const { data, error } = await client.rpc('record_test_weather_price', { p_baseline_id: baselineId, p_forecast: forecast });
      if (error) throw new Error('Weather price save failed');
      return data;
    },
  }));
}
