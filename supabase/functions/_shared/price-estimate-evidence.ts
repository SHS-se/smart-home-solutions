/** Immutable research evidence. TEST only; it never chooses or validates a live plan. */
import type { StoredPriceRow, PriceOutlook } from './planner/energy-price-shape.ts';
import type { OptimisationSnapshot } from './planner/planning-contracts.ts';

export const TEST_MARKET_PROJECT_URL = 'https://vxqpgbzseckgceopitpm.supabase.co';
export const ARCHIVED_MARKET_DATASETS = ['wind_day_ahead', 'load_day_ahead', 'load_week_ahead', 'weather_medium_range'] as const;
export interface MarketForecastContext {
  known_at: string;
  datasets: Record<typeof ARCHIVED_MARKET_DATASETS[number], {
    latest_attempt_id: string | null;
    latest_data_id: string | null;
  }>;
}
export interface PriceForecastGeneration {
  id: string;
  home_id: string;
  generated_at: string;
  model_as_of: string;
  timezone: string;
  zone: string;
  algorithm: string;
  market_context: MarketForecastContext;
  inputs: {
    format_version: 1;
    slot_starts: string[];
    published_import_sek_per_kwh: (number | null)[];
    price_history_available: boolean;
    price_history: StoredPriceRow[];
    smhi_wind_outlook: NonNullable<OptimisationSnapshot['wind_outlook']> | null;
  };
  outlook: PriceOutlook;
}
interface EvidenceDatabase {
  rpc(name: string, parameters?: Record<string, unknown>): PromiseLike<{
    data: unknown; error: { code?: string } | null;
  }>;
}

function isContext(data: unknown): data is MarketForecastContext {
  if (!data || typeof data !== 'object' || !('known_at' in data) || typeof data.known_at !== 'string' ||
    !Number.isFinite(Date.parse(data.known_at)) || !('datasets' in data) || !data.datasets || typeof data.datasets !== 'object') return false;
  const datasets = data.datasets as Record<string, unknown>;
  return ARCHIVED_MARKET_DATASETS.every(dataset => {
    const value = datasets[dataset];
    return value !== null && typeof value === 'object' &&
      ['latest_attempt_id', 'latest_data_id'].every(key => key in value &&
        ((value as Record<string, unknown>)[key] === null || typeof (value as Record<string, unknown>)[key] === 'string'));
  });
}

/** Pin committed observation IDs before calculation; provider dates do not order availability. */
export async function testPriceForecastContext(
  db: EvidenceDatabase, projectUrl: string, zone: string | null,
): Promise<MarketForecastContext | null> {
  if (projectUrl !== TEST_MARKET_PROJECT_URL || zone !== 'SE3') return null;
  try {
    const { data, error } = await db.rpc('read_test_price_forecast_context');
    if (error) throw new Error('context_read_failed');
    if (data === null) return null; // Archive enablement is separate from planner admission.
    if (!isContext(data)) throw new Error('invalid_context');
    return data;
  } catch {
    console.error('[PRICE-FORECAST-EVIDENCE] context unavailable; this calculation cannot be archived');
    return null;
  }
}

/** A failed research write is explicit and never replaces a computed household estimate. */
export async function recordTestPriceForecastGeneration(
  db: EvidenceDatabase, projectUrl: string, generation: PriceForecastGeneration,
): Promise<boolean> {
  if (projectUrl !== TEST_MARKET_PROJECT_URL || generation.zone !== 'SE3') return false;
  try {
    const { error } = await db.rpc('record_test_price_forecast_generation', { p_generation: generation });
    if (error) throw new Error('generation_write_failed');
    return true;
  } catch {
    console.error('[PRICE-FORECAST-EVIDENCE] generation archive failed', { generation_id: generation.id });
    return false;
  }
}
