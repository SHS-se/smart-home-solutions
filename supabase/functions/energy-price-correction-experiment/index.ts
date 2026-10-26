/** Independent TEST worker: corrections are research records, never household forecasts. */
import { buildPriceCorrection, type PriceCorrectionForecast, type PriceCorrectionInput } from '../_shared/price-correction.ts';

export interface CorrectionReservation { id: string; status: 'pending' | 'paired' | 'unavailable'; context: PriceCorrectionInput }
export interface CorrectionStore {
  verifyToken(token: string): Promise<boolean>;
  begin(): Promise<CorrectionReservation | null>;
  complete(id: string, forecast: PriceCorrectionForecast): Promise<void>;
}
export function createPriceCorrectionHandler(projectUrl: string, store: CorrectionStore) {
  return async (request: Request): Promise<Response> => {
    if (projectUrl !== 'https://vxqpgbzseckgceopitpm.supabase.co') return Response.json({ error: 'test_lane_only' }, { status: 403 });
    if (request.method !== 'POST') return Response.json({ error: 'post_required' }, { status: 405 });
    const token = request.headers.get('x-energy-market-archive-token');
    if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });
    try {
      if (!await store.verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const reservation = await store.begin();
      if (!reservation) return Response.json({ status: 'no_household_forecast' });
      if (reservation.status !== 'pending') return Response.json({ id: reservation.id, status: 'already_saved' });
      const forecast = buildPriceCorrection(reservation.context);
      await store.complete(reservation.id, forecast);
      return Response.json({ id: reservation.id, status: forecast.status, training_quarters: forecast.fit?.training.quarters ?? 0,
        corrected_quarters: forecast.targets.filter(row => row.corrected !== null).length });
    } catch {
      console.error('test_price_correction_failed');
      return Response.json({ error: 'test_price_correction_failed' }, { status: 500 });
    }
  };
}
if (import.meta.main) {
  const { createClient } = await import('@supabase/supabase-js');
  const projectUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const client = createClient(projectUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  Deno.serve(createPriceCorrectionHandler(projectUrl, {
    async verifyToken(token) {
      const { data, error } = await client.rpc('verify_test_market_archive_token', { p_token: token });
      if (error) throw new Error('Correction authentication failed');
      return data === true;
    },
    async begin() {
      const { data, error } = await client.rpc('begin_test_price_correction');
      if (error) throw new Error('Correction reservation failed');
      return data;
    },
    async complete(id, forecast) {
      const { error } = await client.rpc('complete_test_price_correction', { p_id: id, p_forecast: forecast });
      if (error) throw new Error('Correction completion failed');
    },
  }));
}
