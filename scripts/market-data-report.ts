/** Freeze acquisition health and prospective demand accuracy. No provider or database writes. */
import { marketEvidenceClient, newPrivateEvidenceDirectory } from './market-evidence-client.ts';
import { MARKET_CAPABILITY_GAPS } from '../supabase/functions/_shared/market-collection-plan.ts';
import { scoreDemandForecasts, type DemandEvidence } from '../supabase/functions/_shared/demand-forecast-quality.ts';
const out = await newPrivateEvidenceDirectory(Deno.args, 'Usage: deno task research:market:report --out NEW_PRIVATE_DIRECTORY');
const client = await marketEvidenceClient(), snapshot = await client.snapshot();
await Deno.writeTextFile(`${out}/manifest.json`, JSON.stringify(snapshot, null, 2) + '\n');
const assessed = new Set(snapshot.assessed_ids);
const index = (await client.index(snapshot.observation_ids)).map(row => assessed.has(row.id) ? row : { ...row, assessor_version: null, facts: null, http_status: null, error_code: null, body_sha256: null });
const sources = new Map<string, typeof index>();
for (const row of index.sort((a, b) => a.sequence - b.sequence)) {
  const key = `${row.dataset}/${row.zone}`;
  if (!sources.has(key)) sources.set(key, []);
  sources.get(key)!.push(row);
}
const health = [...sources].map(([source, rows]) => {
  const latest = rows.at(-1)!, data = rows.filter(r => r.status === 'data').at(-1);
  const outcomes: Record<string, number> = {};
  const periods: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    outcomes[row.status] = (outcomes[row.status] ?? 0) + 1;
    const hour = row.requested_at.slice(0, 13);
    periods[hour] ??= {};
    const outcome = row.http_status === 503 ? 'http_503' : row.status;
    periods[hour][outcome] = (periods[hour][outcome] ?? 0) + 1;
  }
  return { source, attempts: rows.length, outcomes, periods_utc: periods, unknown_historical_batch_count: rows.filter(r => !r.batch_id).length,
    unassessed: rows.filter(r => !r.assessor_version).length,
    latest_attempt: { id: latest.id, at: latest.requested_at, status: latest.status, http_status: latest.http_status, error: latest.error_code },
    latest_success: data ? { id: data.id, at: data.requested_at, age_hours: (Date.parse(snapshot.at) - Date.parse(data.requested_at)) / 3_600_000,
      body_sha256: data.body_sha256, facts: data.facts } : null };
});
const batches = snapshot.batches.map(batch => ({ id: batch.id, kind: batch.kind, at: batch.requested_at,
  age_hours: (Date.parse(snapshot.at) - Date.parse(batch.requested_at)) / 3_600_000,
  expected: batch.plan.length, saved: index.filter(r => r.batch_id === batch.id).length,
  missing: batch.plan.filter(p => !index.some(r => r.batch_id === batch.id && r.request_key === p.key)).map(p => p.key) }));
const cadence = (['day_ahead', 'generation', 'market_context'] as const).map(kind => {
  const rows = batches.filter(b => b.kind === kind).sort((a, b) => a.at.localeCompare(b.at));
  const hours = kind === 'day_ahead' ? 1 : 6;
  // Cron runs on fixed UTC hours. Compare bucket numbers, rather than mistaking request-time jitter for a missed run.
  const bucket = (at: string) => Math.floor(Date.parse(at) / (hours * 3_600_000));
  return { kind, cadence_hours: hours, latest_batch_age_hours: rows.at(-1)?.age_hours ?? null,
    gaps_between_batches: rows.slice(1).flatMap((r, i) => bucket(r.at) - bucket(rows[i].at) > 1 ? [{
      after: rows[i].at, before: r.at, missed_slots: bucket(r.at) - bucket(rows[i].at) - 1 }] : []),
    interpretation: 'Cadence gaps are measured only after the first recorded batch; earlier scheduled attempts have unknown batch identity.' };
});
const demandIds = index.filter(r => r.zone === 'SE3' && ['load_actual', 'load_day_ahead', 'load_week_ahead'].includes(r.dataset) && r.status === 'data').map(r => r.id);
const evidence = await client.documents<DemandEvidence>(demandIds);
const demand = scoreDemandForecasts(evidence);
await Deno.writeTextFile(`${out}/demand-evidence.json`, JSON.stringify(evidence) + '\n');
await Deno.writeTextFile(`${out}/index.json`, JSON.stringify(index) + '\n');
const report = { snapshot_at: snapshot.at, quality_version: snapshot.assessor_version, cadence, batches, sources: health, demand,
  capability_gaps: MARKET_CAPABILITY_GAPS,
  interpretation: 'HTTP success does not establish completeness or skill. Coverage refers to the requested native window; unpublished future periods and delayed actuals remain visible. Weather accuracy and network-driven price skill are not yet established.' };
await Deno.writeTextFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ out, observations: index.length, batches: batches.length, sources: health.length, demand_scores: demand.scores }, null, 2));
