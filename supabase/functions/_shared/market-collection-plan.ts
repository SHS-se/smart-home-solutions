/** Fixed provider products and cadences. This is acquisition policy, never a price model. */
import { ZONE_STATIONS } from './market-wind.ts';
import { nucsParameters, type NucsArchiveDataset } from './nucs-market-data.ts';
import type { SmhiDataset } from './smhi-observations.ts';
import { marketDate, marketDaySpan } from './demand-forecast-quality.ts';
import { ARCHIVED_MARKET_DATASETS } from './price-estimate-evidence.ts';

export const GENERATION_DATASETS = [...ARCHIVED_MARKET_DATASETS.filter(dataset => dataset !== 'weather_medium_range'), 'generation_actual', 'sweden_hydrology',
  'production_outages', 'generation_outages', 'installed_generation_units'] as const;
export const NEIGHBOUR_ZONES = ['SE2', 'SE4', 'NO1', 'FI', 'DK1'] as const;
export type NeighbourZone = typeof NEIGHBOUR_ZONES[number];
export type CollectionKind = 'day_ahead' | 'generation' | 'market_context' | 'weather_truth' | 'regional_context' | 'market_history';
export type ArchiveDataset = typeof GENERATION_DATASETS[number] | 'load_actual' |
  'spot_price' | 'svk_physical_imports' | 'svk_physical_exports' | 'jao_day_ahead_border_flows' | 'jao_day_ahead_net_position' | 'neighbour_load_day_ahead' | 'neighbour_wind_day_ahead' | 'jao_max_net_positions' | 'jao_max_exchanges' | SmhiDataset | NucsArchiveDataset;
export type MarketZone = 'SE3' | NeighbourZone | 'NORDIC_CCR';
export interface MarketRequest { key: string; dataset: ArchiveDataset; zone: MarketZone; from: string; to: string; station_id?: string; neighbour?: NeighbourZone; direction?: 'import' | 'export' }
export interface MarketBatch { id: string; kind: CollectionKind; requested_at: string; plan: MarketRequest[] }
const DAY = 86_400_000;
export function parseCollectionRequest(body: string): { kind: CollectionKind; day?: string; netPositionOnly?: true } {
  const value: unknown = body.trim() ? JSON.parse(body) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archive request');
  const keys = Object.keys(value);
  if (!keys.length) return { kind: 'day_ahead' };
  if (keys.length === 1 && 'generation' in value && value.generation === true) return { kind: 'generation' };
  if (keys.length === 1 && 'context' in value && value.context === true) return { kind: 'market_context' };
  if (keys.length === 1 && 'truth' in value && value.truth === true) return { kind: 'weather_truth' };
  if (keys.length === 1 && 'regional' in value && value.regional === true) return { kind: 'regional_context' };
  if (keys.length === 1 && ('history' in value || 'netPositionHistory' in value)) {
    const day = 'history' in value ? value.history : value.netPositionHistory;
    if ('history' in value && day === true) return { kind: 'market_history' };
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day) {
      return 'history' in value ? { kind: 'market_history', day } : { kind: 'market_history', day, netPositionOnly: true };
    }
  }
  throw new Error('Invalid archive request');
}

export function collectionKind(body: string): CollectionKind { return parseCollectionRequest(body).kind; }

export function collectionPlan(kind: CollectionKind, now: Date, day?: string, netPositionOnly = false): MarketRequest[] {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  const requests: MarketRequest[] = [];
  const add = (dataset: ArchiveDataset, zone: MarketZone, from: number, to: number) => {
    const start = new Date(from).toISOString(), end = new Date(to).toISOString();
    requests.push({ key: `${dataset}/${zone}/${start}/${end}`, dataset, zone, from: start, to: end });
  };
  if (kind === 'regional_context') {
    requests.push(...regionalCollectionPlan(new Date(today - DAY).toISOString(), new Date(today + 9 * DAY).toISOString()));
  } else if (kind === 'weather_truth') {
    const to = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    for (const station of ZONE_STATIONS.SE3) for (const dataset of ['smhi_wind_10m_observed', 'smhi_temperature_2m_observed'] as const) {
      add(dataset, 'SE3', to - 90 * DAY, to);
      const request = requests.at(-1)!;
      request.key += `/${station.id}`;
      request.station_id = station.id;
    }
  } else if (kind === 'day_ahead') {
    for (const dataset of ['wind_day_ahead', 'load_day_ahead'] as const) add(dataset, 'SE3', today, today + 3 * DAY);
    const localDay = marketDate(now.getTime());
    const endDay = new Date(Date.parse(`${localDay}T00:00:00Z`) + 2 * DAY).toISOString().slice(0, 10);
    const end = marketDaySpan(endDay)[0];
    // Two local market days can contain 49 hours. Split the native window; never truncate the DST tail.
    for (const dataset of ['jao_max_net_positions', 'jao_max_exchanges'] as const) {
      for (let start = marketDaySpan(localDay)[0]; start < end; start += 2 * DAY) add(dataset, 'NORDIC_CCR', start, Math.min(start + 2 * DAY, end));
    }
  } else if (kind === 'market_history') {
    const currentDay = marketDate(now.getTime());
    if (day && day >= currentDay) throw new Error('Historical collection requires a completed Stockholm day');
    const shift = (offset: number) => new Date(Date.parse(currentDay) + offset * DAY).toISOString().slice(0, 10);
    for (const date of day ? [day] : [-2, -1, 0, 1].map(shift)) {
      const [from, to] = marketDaySpan(date);
      add('jao_day_ahead_net_position', 'NORDIC_CCR', from, to);
      if (netPositionOnly) continue;
      add('spot_price', 'SE3', from, to);
      add('jao_day_ahead_border_flows', 'NORDIC_CCR', from, to);
      if (date < currentDay) {
        add('svk_physical_imports', 'SE3', from, to);
        add('svk_physical_exports', 'SE3', from, to);
      }
      if (day) add('generation_actual', 'SE3', from, to);
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
        : today;
      const to = dataset === 'generation_actual' ? minute
        : dataset === 'installed_generation_units' ? Date.UTC(now.getUTCFullYear() + 1, 0, 1)
        : dataset === 'sweden_hydrology' ? today + DAY
        : today + (dataset === 'load_week_ahead' ? 9 : dataset === 'production_outages' || dataset === 'generation_outages' ? 7 : 3) * DAY;
      add(dataset, 'SE3', from, to);
    }
  }
  return requests;
}

export const MARKET_CAPABILITY_GAPS = [
  { source: 'NUCS flow-based week-ahead net positions (IG-182/184)', status: 'token_verified_no_matching_flow_based_publications_for_tested_weeks' },
  { source: 'Full Nordic flow-based domain', status: 'not_collected' },
  { source: 'Hourly week-ahead demand', status: 'provider_publishes_daily_extrema' },
  { source: 'Operational weather issue time', status: 'not_exposed_by_provider' },
] as const;

/** Same verified products for scheduled collection and history downloads. */
export function regionalCollectionPlan(from: string, to: string): MarketRequest[] {
  // Reuse the provider boundary's closed window validation; no arbitrary endpoint or products can be supplied.
  const requests: MarketRequest[] = [];
  for (const neighbour of NEIGHBOUR_ZONES) for (const direction of ['import', 'export'] as const) for (const dataset of ['nucs_week_ahead_ntc', 'nucs_transmission_outages'] as const) {
    const query = { provider: 'nucs', dataset, direction, neighbour, from, to };
    nucsParameters(query);
    requests.push({ key: `${dataset}/SE3/${from}/${to}/${neighbour}/${direction}`, dataset, zone: 'SE3', from, to, neighbour, direction });
  }
  return requests;
}

/** A regional request for a completed historical window does not refresh the forward-looking feed. */
export function isCurrentCollection(batch: MarketBatch): boolean {
  if (batch.kind === 'market_history') return batch.plan.some(request => request.dataset === 'spot_price') &&
    !batch.plan.some(request => request.dataset === 'generation_actual');
  return batch.kind !== 'regional_context' || batch.plan.some(request => Date.parse(request.to) > Date.parse(batch.requested_at));
}
