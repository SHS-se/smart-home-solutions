/** Bounded, credential-redacted capacity evidence for TEST research only. */
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
  let response: Response, bytes: Uint8Array<ArrayBuffer>;
  try {
    response = await fetchProvider(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing provider body');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Provider body too large'); }
      chunks.push(part.value);
    }
    bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    // Plain XML/HTTP error bodies can echo request details. Never retain the credential.
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      let text = new TextDecoder().decode(bytes);
      for (const value of new Set([token, encodeURIComponent(token), new URLSearchParams({ token }).toString().slice(6)])) {
        if (value) text = text.replaceAll(value, '[REDACTED]');
      }
      bytes = new TextEncoder().encode(text);
    }
  } catch { return { ...empty, status: 'transport_error', error_code: 'entsoe_capacity_transport_failed' }; }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let binary = ''; for (const value of bytes) binary += String.fromCharCode(value);
  const evidence = { http_status: response.status, body_sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''),
    raw_base64: btoa(binary), error_code: null };
  if (!response.ok) return { ...evidence, status: 'provider_error', error_code: `http_${response.status}` };
  try {
    const document = dataset === 'installed_generation_units' ? await parseNuclearRoster(bytes) : await parseNuclearOutages(bytes);
    return { ...evidence, status: 'data', document: document as CapacityDocuments[K] };
  } catch { return { ...evidence, status: 'parse_error', error_code: 'unsupported_or_invalid_capacity_document' }; }
}
