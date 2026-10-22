/** Read-only TEST scores and exact numerical replay of a saved paired forecast. */
import { isDeepStrictEqual } from 'node:util';
import { PROBE_PROJECT, testProbeServiceKey } from './planner-probe-auth.ts';
import { buildPricePair, type PricePairForecast } from '../supabase/functions/_shared/price-pair.ts';
import type { PricePairReservation } from '../supabase/functions/energy-price-experiment/index.ts';
import type { EntsoeInterval } from '../supabase/functions/_shared/entsoe-market-data.ts';

if (Deno.args.length !== 2 || Deno.args[0] !== '--out') throw new Error('Usage: deno task research:prices:paired-report --out NEW_DIRECTORY');
const out = Deno.args[1];
await Deno.mkdir(out); // Do not replace an earlier evidence bundle.
const key = await testProbeServiceKey();
const headers = { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' };
async function read<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`https://${PROBE_PROJECT}.supabase.co/rest/v1/${path}`, {
    headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`TEST paired report HTTP ${response.status}`);
  return await response.json();
}
interface PairSummary { id: string; status: string }
interface PairReport { truth_cutoff: number; scores: unknown[]; pairs: PairSummary[] }
const report = await read<PairReport>('rpc/read_test_price_pair_report', {});
const latest = report.pairs.find(pair => pair.status === 'paired');
let replay: { id: string; matches: boolean } | null = null;
if (latest) {
  const pairs = await read<(PricePairReservation & { forecast: PricePairForecast })[]>(
    `energy_test_price_pairs?${new URLSearchParams({ id: `eq.${latest.id}`, select: 'id,status,context,forecast' })}`,
  );
  if (pairs.length !== 1) throw new Error('Saved pair unavailable for replay');
  const pair = pairs[0];
  const evidence = await read<{ id: string; result: { status: string; document?: { intervals: EntsoeInterval[] } } }[]>(
    `energy_market_forecast_observations?${new URLSearchParams({ id: `eq.${pair.context.actualObservationId}`, select: 'id,result' })}`,
  );
  if (evidence.length !== 1) throw new Error('Pinned actual observation unavailable for replay');
  const actualIntervals = evidence[0].result.status === 'data' ? evidence[0].result.document!.intervals : [];
  const calculated = buildPricePair({ ...pair.context, actualIntervals });
  replay = { id: pair.id, matches: isDeepStrictEqual(calculated, pair.forecast) };
  await Deno.writeTextFile(`${out}/replay-evidence.json`, JSON.stringify({ pair, observation: evidence[0] }) + '\n');
}
const result = { project: PROBE_PROJECT, generated_at: new Date().toISOString(), ...report, replay,
  interpretation: 'Paired prospective all-in import SEK/kWh. Eligible prices were unknown to TEST when saved. Scores use the latest revision at truth_cutoff. Count distinct target days; overlapping origins are correlated. D+3 may be partial. These shadow ridge arms do not change the household estimator.' };
await Deno.writeTextFile(`${out}/report.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (replay && !replay.matches) throw new Error('Paired forecast replay differs');
