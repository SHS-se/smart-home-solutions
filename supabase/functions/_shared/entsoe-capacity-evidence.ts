/** Bounded, credential-redacted capacity evidence for TEST research only. */
import { readMarketProvider, marketBodyBase64 } from './market-provider-response.ts';
import { entsoeParameters } from './entsoe-market-data.ts';
import { parseNuclearOutages, parseNuclearRoster, type NuclearRoster, type NuclearOutageDocument } from './nuclear-availability.ts';
export interface CapacityDocuments {
  production_outages: NuclearOutageDocument;
  generation_outages: NuclearOutageDocument;
  installed_generation_units: NuclearRoster;
}
export type CapacityDataset = keyof CapacityDocuments;
export type CapacityEvidence<T> = {
  http_status: number | null; body_sha256: string | null; raw_base64: string | null; error_code: string | null;
} & ({ status: 'data'; document: T } | { status: 'provider_error' | 'transport_error' | 'parse_error' });
export async function captureCapacityEvidence<K extends CapacityDataset>(dataset: K, from: string, to: string,
  token: string, fetchProvider: typeof fetch): Promise<CapacityEvidence<CapacityDocuments[K]>> {
  const empty = { http_status: null, body_sha256: null, raw_base64: null, error_code: null };
  if (!token) return { ...empty, status: 'transport_error', error_code: 'entsoe_token_not_configured' };
  const url = new URL('https://web-api.tp.entsoe.eu/api');
  url.search = entsoeParameters({ dataset, from, to }).toString();
  url.searchParams.set('securityToken', token);
  const held = await readMarketProvider(url, token, fetchProvider);
  if (!held) return { ...empty, status: 'transport_error', error_code: 'entsoe_capacity_transport_failed' };
  const bytes = held.bytes;
  const evidence = { http_status: held.http_status, body_sha256: held.body_sha256, raw_base64: marketBodyBase64(bytes), error_code: null };
  if (held.http_status < 200 || held.http_status >= 300) return { ...evidence, status: 'provider_error', error_code: `http_${held.http_status}` };
  try {
    const document = dataset === 'installed_generation_units' ? await parseNuclearRoster(bytes) : await parseNuclearOutages(bytes);
    return { ...evidence, status: 'data', document: document as CapacityDocuments[K] };
  } catch { return { ...evidence, status: 'parse_error', error_code: 'unsupported_or_invalid_capacity_document' }; }
}
