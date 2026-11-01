/** Independent TEST worker: corrections are research records, never household forecasts. */
import { buildPriceCorrection, PRICE_CORRECTION_ALGORITHM, type PriceCorrectionForecast, type PriceCorrectionInput } from '../_shared/price-correction.ts';
import { buildPriceCorrectionV2, PRICE_CORRECTION_V2_ALGORITHM, type PriceCorrectionV2Forecast } from '../_shared/price-correction-v2.ts';

export type CorrectionAlgorithm = typeof PRICE_CORRECTION_ALGORITHM | typeof PRICE_CORRECTION_V2_ALGORITHM;
export type CorrectionForecast = PriceCorrectionForecast | PriceCorrectionV2Forecast;
export interface CorrectionReservation { id: string; algorithm: CorrectionAlgorithm; status: 'pending' | 'paired' | 'unavailable'; context: PriceCorrectionInput }
export interface CorrectionStore {
  verifyToken(token: string): Promise<boolean>;
  begin(algorithm: CorrectionAlgorithm): Promise<CorrectionReservation | null>;
  complete(id: string, forecast: CorrectionForecast): Promise<void>;
}
const STUDIES = [
  { algorithm: PRICE_CORRECTION_ALGORITHM, calculate: buildPriceCorrection },
  { algorithm: PRICE_CORRECTION_V2_ALGORITHM, calculate: buildPriceCorrectionV2 },
] as const;
export function createPriceCorrectionHandler(projectUrl: string, store: CorrectionStore) {
  return async (request: Request): Promise<Response> => {
    if (projectUrl !== 'https://vxqpgbzseckgceopitpm.supabase.co') return Response.json({ error: 'test_lane_only' }, { status: 403 });
    if (request.method !== 'POST') return Response.json({ error: 'post_required' }, { status: 405 });
    const token = request.headers.get('x-energy-market-archive-token');
    if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });
    try {
      if (!await store.verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 });
      // Independent reservations: a failed version cannot prevent the other
      // study from retaining its completed forecast. Retries reuse each fence.
      const results = await Promise.allSettled(STUDIES.map(async study => {
        const reservation = await store.begin(study.algorithm);
        if (!reservation) return { algorithm: study.algorithm, status: 'no_household_forecast' };
        if (reservation.algorithm !== study.algorithm) throw new Error('Wrong correction algorithm');
        if (reservation.status !== 'pending') return { algorithm: study.algorithm, id: reservation.id, status: 'already_saved' };
        const forecast = study.calculate(reservation.context);
        await store.complete(reservation.id, forecast);
        return { algorithm: study.algorithm, id: reservation.id, status: forecast.status,
          training_quarters: forecast.fit?.training.quarters ?? 0,
          corrected_quarters: forecast.targets.filter(row => row.corrected !== null).length };
      }));
      const runs = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (results.some(result => result.status === 'rejected')) {
        console.error('test_price_correction_failed');
        return Response.json({ error: 'test_price_correction_failed', runs }, { status: 500 });
      }
      return Response.json(runs.every(run => run.status === 'no_household_forecast') ? { status: 'no_household_forecast' } : { runs });
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
    async begin(algorithm) {
      const { data, error } = await client.rpc('begin_test_price_correction', { p_algorithm: algorithm });
      if (error) throw new Error('Correction reservation failed');
      return data;
    },
    async complete(id, forecast) {
      const { error } = await client.rpc('complete_test_price_correction', { p_id: id, p_forecast: forecast });
      if (error) throw new Error('Correction completion failed');
    },
  }));
}
