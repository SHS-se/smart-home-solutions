/** Fixed provider products and cadences. This is acquisition policy, never a price model. */
import { ARCHIVED_MARKET_DATASETS } from './price-estimate-evidence.ts';

export const GENERATION_DATASETS = [...ARCHIVED_MARKET_DATASETS, 'generation_actual', 'sweden_hydrology',
  'production_outages', 'generation_outages', 'installed_generation_units'] as const;
export const NEIGHBOUR_ZONES = ['SE2', 'SE4', 'NO1', 'FI', 'DK1'] as const;
export type NeighbourZone = typeof NEIGHBOUR_ZONES[number];
export type CollectionKind = 'day_ahead' | 'generation' | 'market_context';
export type ArchiveDataset = typeof GENERATION_DATASETS[number] | 'load_actual' |
  'neighbour_load_day_ahead' | 'neighbour_wind_day_ahead' | 'jao_max_net_positions' | 'jao_max_exchanges';
export type MarketZone = 'SE3' | NeighbourZone | 'NORDIC_CCR';
export interface MarketRequest { key: string; dataset: ArchiveDataset; zone: MarketZone; from: string; to: string }
export interface MarketBatch { id: string; kind: CollectionKind; requested_at: string; plan: MarketRequest[] }
const DAY = 86_400_000;
const stockholmDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
function marketMidnight(date: string): number {
  const nominal = Date.parse(`${date}T00:00:00Z`);
  for (const hours of [1, 2]) {
    const at = nominal - hours * 3_600_000;
    const next = at + 3_600_000;
    if (stockholmDate.format(at) === date && stockholmDate.format(at - 1) !== date && stockholmDate.format(next) === date) return at;
  }
  throw new Error('Unsupported Stockholm market date');
}

export function collectionKind(body: string): CollectionKind {
  const value: unknown = body.trim() ? JSON.parse(body) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archive request');
  const keys = Object.keys(value);
  if (!keys.length) return 'day_ahead';
  if (keys.length === 1 && 'generation' in value && value.generation === true) return 'generation';
  if (keys.length === 1 && 'context' in value && value.context === true) return 'market_context';
  throw new Error('Invalid archive request');
}

export function collectionPlan(kind: CollectionKind, now: Date): MarketRequest[] {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  const requests: MarketRequest[] = [];
  const add = (dataset: ArchiveDataset, zone: MarketZone, from: number, to: number) => {
    const start = new Date(from).toISOString(), end = new Date(to).toISOString();
    requests.push({ key: `${dataset}/${zone}/${start}/${end}`, dataset, zone, from: start, to: end });
  };
  if (kind === 'day_ahead') {
    for (const dataset of ['wind_day_ahead', 'load_day_ahead'] as const) add(dataset, 'SE3', today, today + 3 * DAY);
    const localDay = stockholmDate.format(now);
    const endDay = new Date(Date.parse(`${localDay}T00:00:00Z`) + 2 * DAY).toISOString().slice(0, 10);
    const end = marketMidnight(endDay);
    // Two local market days can contain 49 hours. Split the native window; never truncate the DST tail.
    for (const dataset of ['jao_max_net_positions', 'jao_max_exchanges'] as const) {
      for (let start = marketMidnight(localDay); start < end; start += 2 * DAY) add(dataset, 'NORDIC_CCR', start, Math.min(start + 2 * DAY, end));
    }
  } else if (kind === 'market_context') {
    add('load_actual', 'SE3', minute - 28 * DAY, minute);
    for (const zone of NEIGHBOUR_ZONES) for (const dataset of ['neighbour_load_day_ahead', 'neighbour_wind_day_ahead'] as const) {
      add(dataset, zone, today, today + 3 * DAY);
    }
  } else {
    for (const dataset of GENERATION_DATASETS) {
      const from = dataset === 'generation_actual' ? minute - 28 * DAY
        : dataset === 'installed_generation_units' ? Date.UTC(now.getUTCFullYear(), 0, 1)
        : dataset === 'production_outages' || dataset === 'generation_outages' ? today - 180 * DAY
        : dataset === 'sweden_hydrology' ? today - 49 * DAY
        : dataset === 'weather_medium_range' ? today - 28 * DAY : today;
      const to = dataset === 'generation_actual' ? minute
        : dataset === 'installed_generation_units' ? Date.UTC(now.getUTCFullYear() + 1, 0, 1)
        : dataset === 'sweden_hydrology' ? today + DAY
        : today + (dataset === 'load_week_ahead' ? 9 : dataset === 'weather_medium_range' ||
          dataset === 'production_outages' || dataset === 'generation_outages' ? 7 : 3) * DAY;
      add(dataset, 'SE3', from, to);
    }
  }
  return requests;
}

export const MARKET_CAPABILITY_GAPS = [
  { source: 'NUCS week-ahead outage impacts', status: 'authenticated_access_unverified' },
  { source: 'Full Nordic flow-based domain', status: 'not_collected' },
  { source: 'Hourly week-ahead demand', status: 'provider_publishes_daily_extrema' },
  { source: 'Operational weather issue time', status: 'not_exposed_by_provider' },
] as const;
