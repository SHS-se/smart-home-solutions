import { NEIGHBOUR_ZONES } from './market-collection-plan.ts';

export type SvkFlowDataset = 'svk_physical_imports' | 'svk_physical_exports';
const QUARTER = 900_000;
const LIMIT = 600;

export function svkFlowRequest(dataset: SvkFlowDataset, from: string, to: string): URL {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 25 * 3_600_000) {
    throw new Error('Svenska kraftnät requires a window of at most 25 hours');
  }
  const direction = dataset === 'svk_physical_imports' ? 'to' : 'from';
  const url = new URL('https://data.svk.se/api/action/datastore_search');
  url.search = new URLSearchParams({
    resource_id: '4aa94b88-9f42-4f0a-a6a8-8e47aadc782a', limit: String(LIMIT),
    sort: 'start_time_utc asc, _id asc', fields: 'start_time_utc,from_bidding_zone,to_bidding_zone,power,power_unit',
    filters: JSON.stringify({ [`${direction}_bidding_zone`]: 'SE3', start_time_utc: {
      gte: new Date(start).toISOString().slice(0, 19), lt: new Date(end).toISOString().slice(0, 19),
    } }),
  }).toString();
  return url;
}

export function parseSvkFlowResponse(dataset: SvkFlowDataset, payload: unknown, from: string, to: string) {
  const response = payload as { success?: boolean; result?: { records?: unknown[]; total?: number; total_was_estimated?: boolean } } | null;
  const result = response?.result;
  if (response?.success !== true || !Array.isArray(result?.records) || result.records.length >= LIMIT ||
    (!result.total_was_estimated && result.records.length !== result.total)) throw new Error('Incomplete Svenska kraftnät response');
  const byQuarter = new Map<number, Record<string, number | null>>();
  const importing = dataset === 'svk_physical_imports';
  for (const raw of result.records) {
    const row = raw as Record<string, unknown> | null;
    const time = row?.start_time_utc;
    const at = typeof time === 'string' ? Date.parse(`${time}Z`) : NaN;
    const zone = importing ? row?.from_bidding_zone : row?.to_bidding_zone;
    const power = row?.power;
    if (!(at >= Date.parse(from) && at < Date.parse(to)) || at % QUARTER ||
      (importing ? row?.to_bidding_zone : row?.from_bidding_zone) !== 'SE3' ||
      !NEIGHBOUR_ZONES.some(neighbour => neighbour === zone) || typeof zone !== 'string' ||
      row?.power_unit !== 'MW' || typeof power !== 'number' || !Number.isFinite(power) || power < 0) {
      throw new Error('Invalid Svenska kraftnät flow');
    }
    const values = byQuarter.get(at) ?? {};
    const signed = importing ? power : -power;
    values[zone] = Object.hasOwn(values, zone) && values[zone] !== signed ? null : signed;
    byQuarter.set(at, values);
  }
  return { provider: 'svk', unit: 'MW', resolution: 'PT15M', semantics: 'measured_border_flow', records:
    [...byQuarter].map(([at, values]) => ({ start: new Date(at).toISOString(), end: new Date(at + QUARTER).toISOString(), values })) };
}
