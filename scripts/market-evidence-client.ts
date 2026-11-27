import { isNucsFlowDataset, NUCS_NATIVE_BUCKET, type NucsFlowDataset, type NucsFlowEvidence, type NucsDomainArchive } from '../supabase/functions/_shared/nucs-flow-based.ts';
import { streamNucsDomain } from '../supabase/functions/_shared/nucs-domain-reader.ts';
/** TEST-only bounded reads. Credentials never become report artifacts. */
import { readMarketProvider } from '../supabase/functions/_shared/market-provider-response.ts';
import { PROBE_PROJECT, testProbeServiceKey } from './planner-probe-auth.ts';
import type { MarketBatch } from '../supabase/functions/_shared/market-collection-plan.ts';
import type { MarketArchiveObservation } from '../supabase/functions/energy-market-archive/index.ts';
import type { AssessedObservation, MarketAssessment } from '../supabase/functions/_shared/market-evidence-assessment.ts';
export interface MarketSnapshot { at: string; assessor_version: string; observation_ids: string[]; assessed_ids: string[]; batches: MarketBatch[] }
export interface MarketIndex extends Omit<AssessedObservation, 'result'> {
  sequence: number; batch_id: string | null; request_key: string | null; recorded_at: string; requested_at: string;
  status: string; assessor_version: string | null; http_status: number | null; error_code: string | null;
  body_sha256: string | null; facts: Record<string, unknown> | null;
}
export interface NucsForecastContext {
  known_at: string;
  from: string;
  to: string;
  products: Record<NucsFlowDataset, { id: string | null; batch_id: string; sequence: number | null; status: string; requested_at: string; recorded_at: string | null } | null>;
}
export async function marketEvidenceClient() {
  const key = await testProbeServiceKey();
  const headers = { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' };
  async function send(path: string, body?: object): Promise<Response> {
    const response = await fetch(`https://${PROBE_PROJECT}.supabase.co/rest/v1/${path}`, {
      headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`TEST market evidence HTTP ${response.status}`);
    return response;
  }
  async function read<T>(path: string, body?: object): Promise<T> {
    const response = await send(path, body);
    if (response.status === 204) return undefined as T; // PostgREST void RPC protocol.
    return await response.json();
  }
  return {
    nucsContext: (from: string, to: string) => read<NucsForecastContext | null>('rpc/read_test_nucs_forecast_context', { p_from: from, p_to: to }),
    async *nucsDomains(id: string, from: string, to: string) {
      const rows = await read<{ dataset: string; result: NucsFlowEvidence }[]>('rpc/read_test_market_documents', { p_ids: [id] });
      const row = rows[0];
      if (rows.length !== 1 || !isNucsFlowDataset(row.dataset) || !row.dataset.endsWith('_domain') ||
          row.result.status !== 'data' || !('source_observation_id' in row.result.document)) throw new Error('Expected a committed NUCS domain archive');
      const native = row.result.document as NucsDomainArchive;
      for (const publication of native.publications) {
        const archive = publication.archive;
        if (archive.bucket !== NUCS_NATIVE_BUCKET || !/^nucs\/[a-f0-9]{64}\.zip$/.test(archive.path)) throw new Error('Invalid NUCS archive path');
        const response = await fetch('https://' + PROBE_PROJECT + '.supabase.co/storage/v1/object/authenticated/' + archive.bucket + '/' + archive.path, { headers });
        if (!response.ok) throw new Error('TEST NUCS archive download failed');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const digest = Array.from(sha, b => b.toString(16).padStart(2, '0')).join('');
        if (digest !== archive.sha256 || bytes.length !== archive.bytes) throw new Error('NUCS native archive integrity mismatch');
        yield* streamNucsDomain(bytes, publication, { from, to });
      }
    },
    research: (query: Record<string, unknown>) => readMarketProvider(new URL(`https://${PROBE_PROJECT}.supabase.co/functions/v1/energy-market-research`), key,
      (url, options) => fetch(url, { ...options, method: 'POST', headers, body: JSON.stringify({ provider: 'nucs', ...query }) })),
    saveBatch: async (batch: MarketBatch) => { await send('energy_market_collection_batches', batch); },
    record: (row: MarketArchiveObservation, assessment: MarketAssessment) => read('rpc/record_test_market_observation', { p_observation: row, p_assessment: assessment }),
    status: (since: number) => read('rpc/read_test_market_quality_status', { p_since: since }),
    snapshot: () => read<MarketSnapshot>('rpc/read_test_market_snapshot', {}),
    async index(ids: string[]) {
      const rows: MarketIndex[] = [];
      for (let at = 0; at < ids.length; at += 64) rows.push(...await read<MarketIndex[]>(`energy_market_observation_index?${new URLSearchParams({
        select: '*', id: `in.(${ids.slice(at, at + 64).join(',')})`, order: 'sequence',
      })}`));
      if (rows.length !== new Set(ids).size) throw new Error('Snapshot index is incomplete');
      return rows;
    },
    async documents<T>(ids: string[]): Promise<T[]> {
      const rows: T[] = [];
      for (let at = 0; at < ids.length; at += 8) rows.push(...await read<T[]>('rpc/read_test_market_documents', { p_ids: ids.slice(at, at + 8) }));
      if (rows.length !== new Set(ids).size) throw new Error('Parsed-document projection is incomplete');
      return rows;
    },
    assess: (id: string, assessment: MarketAssessment) => read('rpc/assess_test_market_observation', { p_id: id, p_assessment: assessment }),
  };
}
export async function newPrivateEvidenceDirectory(args: string[], usage: string): Promise<string> {
  if (args.length !== 2 || args[0] !== '--out') throw new Error(usage);
  const out = await Deno.realPath(await Deno.mkdir(args[1], { mode: 0o700 }).then(() => args[1]));
  const repo = await Deno.realPath(new URL('..', import.meta.url));
  if (out === repo || out.startsWith(`${repo}/`)) {
    await Deno.remove(out);
    throw new Error('Evidence reports must be outside the public repository');
  }
  return out;
}
