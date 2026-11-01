/** TEST-only bounded reads. Credentials never become report artifacts. */
import { PROBE_PROJECT, testProbeServiceKey } from './planner-probe-auth.ts';
import type { MarketBatch } from '../supabase/functions/_shared/market-collection-plan.ts';
import type { AssessedObservation, MarketAssessment } from '../supabase/functions/_shared/market-evidence-assessment.ts';
export interface MarketSnapshot { at: string; assessor_version: string; observation_ids: string[]; assessed_ids: string[]; batches: MarketBatch[] }
export interface MarketIndex extends Omit<AssessedObservation, 'result'> {
  sequence: number; batch_id: string | null; request_key: string | null; recorded_at: string; requested_at: string;
  status: string; assessor_version: string | null; http_status: number | null; error_code: string | null;
  body_sha256: string | null; facts: Record<string, unknown> | null;
}
export async function marketEvidenceClient() {
  const key = await testProbeServiceKey();
  const headers = { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' };
  async function read<T>(path: string, body?: object): Promise<T> {
    const response = await fetch(`https://${PROBE_PROJECT}.supabase.co/rest/v1/${path}`, {
      headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`TEST market evidence HTTP ${response.status}`);
    if (response.status === 204) return undefined as T; // PostgREST void RPC protocol.
    return await response.json();
  }
  return {
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
