/** Native Nordic network bounds. Directional extrema are never summed into import capacity. */
export type JaoDataset = 'jao_max_net_positions' | 'jao_max_exchanges';
export interface JaoDocument {
  provider: 'jao'; unit: 'MW'; resolution: 'PT15M';
  semantics: 'net_position_bounds' | 'individual_directional_extrema_not_simultaneous';
  records: { start: string; end: string; provider_modified_at: string | null; values: Record<string, number | null> }[];
  rejected: boolean; messages: unknown;
}
const STEP = 900_000;
export function jaoRequest(dataset: JaoDataset, from: string, to: string): URL {
  const a = Date.parse(from), b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > 48 * 3_600_000) throw new Error('JAO requires a positive window of at most 48 hours');
  const url = new URL(`https://publicationtool.jao.eu/nordic/api/data/${dataset === 'jao_max_net_positions' ? 'maxNetPos' : 'maxExchanges'}`);
  url.search = new URLSearchParams({ FromUtc: from, ToUtc: to, Skip: '0', Take: '1000', Filter: '{}' }).toString();
  return url;
}
export function parseJaoResponse(dataset: JaoDataset, value: unknown): JaoDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JAO response');
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.data) || typeof body.rejected !== 'boolean' || !('messages' in body)) throw new Error('Missing JAO response metadata');
  const data = body.data;
  if (data.length >= 1000 || ['totalRows', 'totalRowsWithFilter'].some(key =>
    typeof body[key] === 'number' && body[key] > data.length)) throw new Error('Truncated JAO response');
  const records = data.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid JAO record');
    const row = raw as Record<string, unknown>, at = typeof row.dateTimeUtc === 'string' ? Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(row.dateTimeUtc) ? row.dateTimeUtc : `${row.dateTimeUtc}Z`) : NaN;
    if (!Number.isFinite(at) || at % STEP) throw new Error('JAO timestamp must be an aligned UTC quarter');
    const values: Record<string, number | null> = {};
    for (const [key, cell] of Object.entries(row)) {
      if (!(dataset === 'jao_max_net_positions' ? /^(min|max)_/.test(key) : key.startsWith('border_'))) continue;
      if (cell !== null && (typeof cell !== 'number' || !Number.isFinite(cell))) throw new Error('Invalid JAO MW value');
      values[key] = cell as number | null;
    }
    if (!Object.keys(values).length) throw new Error('JAO record has no native bounds');
    if (!(row.lastModifiedOn === null || typeof row.lastModifiedOn === 'string')) throw new Error('Invalid JAO modification metadata');
    return { start: new Date(at).toISOString(), end: new Date(at + STEP).toISOString(),
      provider_modified_at: row.lastModifiedOn as string | null, values };
  });
  return { provider: 'jao', unit: 'MW', resolution: 'PT15M',
    semantics: dataset === 'jao_max_net_positions' ? 'net_position_bounds' : 'individual_directional_extrema_not_simultaneous',
    records, rejected: body.rejected, messages: body.messages };
}
