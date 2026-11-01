/** Independently constructed synthetic provider data; contains no household or measured inputs. */
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { collectionKind, collectionPlan } from '../supabase/functions/_shared/market-collection-plan.ts';
import { intervalMean, intervalCoverage } from '../supabase/functions/_shared/market-intervals.ts';
import { parseJaoResponse, jaoRequest } from '../supabase/functions/_shared/jao-nordic-market-data.ts';
import { assessMarketObservation } from '../supabase/functions/_shared/market-evidence-assessment.ts';
import { marketDaySpan, scoreDemandForecasts, type DemandEvidence } from '../supabase/functions/_shared/demand-forecast-quality.ts';
import type { EntsoeInterval } from '../supabase/functions/_shared/entsoe-market-data.ts';
const UUID = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
Deno.test('acquisition plans preserve six-hour weather and exact generation sources, with DST-complete network windows', () => {
  for (const day of ['2026-03-28', '2026-10-24', '2026-11-01']) {
    const at = new Date(`${day}T12:00:00Z`), plan = collectionPlan('day_ahead', at);
    assertEquals(plan.filter(r => r.dataset.includes('load') || r.dataset.includes('wind')).length, 2);
    assert(!plan.some(r => r.dataset === 'weather_medium_range' || r.dataset === 'load_week_ahead'));
    const jao = plan.filter(r => r.dataset === 'jao_max_net_positions');
    assert(jao.every(r => Date.parse(r.to) - Date.parse(r.from) <= 48 * 3_600_000));
    assertEquals(jao.reduce((s, r) => s + Date.parse(r.to) - Date.parse(r.from), 0) / 3_600_000,
      day === '2026-03-28' ? 47 : day === '2026-10-24' ? 49 : 48);
    const generation = collectionPlan('generation', at);
    assertEquals(generation.length, 9);
    assertEquals(new Set(generation.map(r => r.key)).size, 9);
    const context = collectionPlan('market_context', at);
    assertEquals(context.length, 11);
    assertEquals(context.filter(r => r.dataset === 'load_actual').length, 1);
    assertEquals(new Set(context.filter(r => r.zone !== 'SE3').map(r => r.zone)).size, 5);
  }
  assertEquals(collectionKind('{"context":true}'), 'market_context');
  assertThrows(() => collectionKind('{"context":true,"generation":true}'));
});
Deno.test('native coverage treats holes and conflicting overlaps as missing, identical duplicates once', () => {
  const rows = [{ startMs: 0, endMs: 5, value: 10 }, { startMs: 0, endMs: 5, value: 10 }, { startMs: 5, endMs: 10, value: 20 }];
  assertEquals(intervalMean(rows, 0, 10), 15);
  assertEquals(intervalCoverage(rows, 0, 12), { expectedMs: 12, coveredMs: 10, missingMs: 2, conflictMs: 0, duplicateMs: 5 });
  assertEquals(intervalMean([...rows, { startMs: 4, endMs: 6, value: 30 }], 0, 10), null);
  assertEquals(intervalMean(rows, 0, 11), null);
});
Deno.test('JAO retains signed directional semantics, rejections and native nulls and rejects truncated responses', () => {
  const response = { data: [{ dateTimeUtc: '2026-10-25T00:00:00Z', lastModifiedOn: '2026-10-24T12:00:00', min_SE3: -800, max_SE3: null }], rejected: false, messages: null };
  const doc = parseJaoResponse('jao_max_net_positions', response);
  assertEquals(doc.records[0].values, { min_SE3: -800, max_SE3: null });
  assertEquals(doc.records[0].end, '2026-10-25T00:15:00.000Z');
  assertEquals(parseJaoResponse('jao_max_net_positions', { ...response, rejected: true }).rejected, true);
  assertThrows(() => parseJaoResponse('jao_max_net_positions', { ...response, totalRows: 2 }));
  assertThrows(() => jaoRequest('jao_max_exchanges', '2026-10-24T00:00Z', '2026-10-26T01:00Z'));
});
function demandRow(id: number, dataset: string, day: string, value: number): DemandEvidence {
  const [start, end] = marketDaySpan(day);
  const interval = (at: number): EntsoeInterval => ({ startMs: at, endMs: at + 900_000, value, unit: 'MAW', psrType: null,
    businessType: 'A04', flow: 'consumption', resolution: 'PT15M', seriesId: 'synthetic' });
  return { id: UUID(id), sequence: id, dataset, zone: 'SE3', requested_from: new Date(start).toISOString(), requested_to: new Date(end).toISOString(),
    recorded_at: new Date(start - 3_600_000).toISOString(), result: { status: 'data', document: { processType: dataset === 'load_actual' ? 'A16' : 'A01',
      intervals: Array.from({ length: (end - start) / 900_000 }, (_, i) => interval(start + i * 900_000)) } } };
}
Deno.test('prospective demand scores complete 23/25-hour days, normalizes origins, removes newer omitted actuals and excludes late forecasts', () => {
  for (const [day, quarters] of [['2026-03-29', 92], ['2026-10-25', 100]] as const) {
    const forecast = demandRow(1, 'load_day_ahead', day, 120), truth = demandRow(3, 'load_actual', day, 100), repeated = { ...forecast, id: UUID(2), sequence: 2 };
    const scored = scoreDemandForecasts([forecast, repeated, truth]);
    assertEquals(scored.samples.length, 1);
    assertEquals(scored.samples[0].observation_id, repeated.id);
    assertEquals(scored.samples[0].quarters, quarters);
    assertEquals(scored.samples[0].mae_mw, 20);
    const revision = structuredClone(truth); revision.id = UUID(4); revision.sequence = 4; revision.result.document!.intervals.shift();
    assertEquals(scoreDemandForecasts([forecast, truth, revision]).samples.length, 0);
    assertEquals(scoreDemandForecasts([{ ...forecast, recorded_at: truth.requested_to }, truth]).samples.length, 0);
  }
});
Deno.test('week-ahead native daily minima and maxima are never scored as mean load', () => {
  const truth = demandRow(2, 'load_actual', '2026-10-25', 100), forecast = demandRow(1, 'load_week_ahead', '2026-10-25', 0);
  const [startMs, endMs] = marketDaySpan('2026-10-25');
  forecast.result.document = { processType: 'A31', intervals: ['A60', 'A61'].map((businessType, i) => ({ ...truth.result.document!.intervals[0],
    startMs, endMs, businessType, resolution: 'P1D', value: i ? 130 : 90 })) };
  const scored = scoreDemandForecasts([forecast, truth]);
  assertEquals(scored.samples[0].min_error_mw, -10);
  assertEquals(scored.samples[0].max_error_mw, 30);
  assertEquals(scored.samples[0].mae_mw, 20);
});
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA private; CREATE SCHEMA cron; CREATE SCHEMA net; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION is_staff(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE TABLE homes(id uuid PRIMARY KEY,name text); INSERT INTO homes VALUES('${UUID(99)}','Synthetic home');
    CREATE TABLE energy_optimisation_price_slots(home_id uuid,start_ts timestamptz,import_price_sek_per_kwh numeric NOT NULL,export_price_sek_per_kwh numeric NOT NULL DEFAULT 0,source text NOT NULL DEFAULT 'synthetic',received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(home_id,start_ts));
    CREATE TABLE cron.job(jobid integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text UNIQUE,schedule text,command text);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS integer LANGUAGE sql AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) ON CONFLICT(jobname) DO UPDATE SET schedule=$2,command=$3 RETURNING jobid $$;
    CREATE FUNCTION cron.unschedule(integer) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid=$1 RETURNING true $$;
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;`);
  for (const migration of ['20261022180000_test_market_forecast_vintages','20261022190000_test_medium_range_weather','20261022210000_test_generation_mix',
    '20261022211000_test_generation_validation_permissions','20261022220000_test_hydro_nuclear_forecasts','20261022230000_test_paired_price_experiment',
    '20261022233000_test_price_pair_comparison_ui','20261026100000_test_price_residual_correction','20261101110000_test_price_residual_v2']) {
    await db.exec(await Deno.readTextFile(`supabase/migrations/${migration}.sql`));
  }
  return db;
}
Deno.test('foundation SQL writes observation and assessment atomically, preserves unknown history and confines access', async () => {
  const db = await database();
  try {
    await db.exec('SELECT private.enable_test_market_archive()');
    const old = demandRow(1, 'load_day_ahead', '2026-10-25', 120);
    await db.query(`INSERT INTO energy_market_forecast_observations(id,dataset,zone,requested_from,requested_to,requested_at,resolved_at,result)
      VALUES($1,'load_day_ahead','SE3',$2,$3,$2,$2,$4)`, [old.id, old.requested_from, old.requested_to, old.result]);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261101144000_market_data_foundation.sql'));
    assertEquals((await db.query('SELECT batch_id FROM energy_market_forecast_observations')).rows, [{ batch_id: null }]);
    const plan = collectionPlan('market_context', new Date('2026-10-25T12:00Z')), batch = UUID(10), p = plan[0];
    await db.query('INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,$2,$3,$4)', [batch, 'market_context', '2026-10-25T12:00Z', plan]);
    const row = { id: UUID(2), batch_id: batch, request_key: p.key, dataset: p.dataset, zone: p.zone, requested_from: p.from, requested_to: p.to,
      requested_at: '2026-10-25T12:00Z', resolved_at: '2026-10-25T12:01Z', result: { status: 'provider_error', http_status: 503, error_code: 'http_503',
        raw_xml: 'synthetic failure', body_sha256: 'synthetic' } };
    const assessment = assessMarketObservation(row);
    await assertRejects(() => db.query('SELECT record_test_market_observation($1,$2)', [row, { ...assessment, status: 'data' }]));
    assertEquals((await db.query('SELECT id FROM energy_market_forecast_observations WHERE id=$1', [row.id])).rows.length, 0);
    await db.exec('SET ROLE service_role');
    await db.query('SELECT record_test_market_observation($1,$2)', [row, assessment]);
    await db.query('SELECT record_test_market_observation($1,$2)', [row, assessment]);
    await assertRejects(() => db.query('SELECT record_test_market_observation($1,$2)', [{ ...row, result: { ...row.result, raw_xml: 'changed' } }, assessment]));
    await assertRejects(() => db.exec('DELETE FROM energy_market_forecast_observations'));
    await assertRejects(() => db.exec('INSERT INTO energy_market_forecast_observations DEFAULT VALUES'));
    const snapshot = (await db.query<{ s: { observation_ids: string[] } }>('SELECT read_test_market_snapshot() s')).rows[0].s;
    assertEquals(snapshot.observation_ids, [old.id, row.id]);
    await db.query('SELECT assess_test_market_observation($1,$2)', [old.id, assessMarketObservation(old)]);
    assertEquals((await db.query('SELECT result FROM energy_market_forecast_observations WHERE id=$1', [old.id])).rows, [{ result: old.result }]);
    await assertRejects(() => db.query('SELECT read_test_market_documents($1)', [Array(9).fill(row.id)]));
    const projected = (await db.query<{ d: { result: object }[] }>('SELECT read_test_market_documents($1) d', [[row.id]])).rows[0].d;
    assert(!JSON.stringify(projected).includes('synthetic failure'));
    assertEquals((await db.query('SELECT status,http_status FROM energy_market_observation_index WHERE id=$1', [row.id])).rows, [{ status: 'provider_error', http_status: 503 }]);
    await db.exec('RESET ROLE; SET ROLE authenticated');
    await assertRejects(() => db.exec('SELECT read_test_market_snapshot()'));
    await assertRejects(() => db.exec('SELECT * FROM energy_market_observation_index'));
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});
Deno.test('retirement unschedules price workers while keeping price ledger capture and historical reports', async () => {
  const db = await database();
  try {
    await db.exec('SELECT private.enable_test_market_archive()');
    await db.query('SELECT private.enable_test_price_experiment($1)', [UUID(99)]);
    await db.exec('SELECT private.enable_test_price_correction()');
    await db.query("INSERT INTO energy_optimisation_price_slots(home_id,start_ts,import_price_sek_per_kwh) VALUES($1,'2026-10-24T00:00Z',0.9)", [UUID(99)]);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261101143000_retire_test_price_workers.sql'));
    assertEquals((await db.query("SELECT jobname FROM cron.job WHERE jobname LIKE 'test-energy-price%'")).rows, []);
    await db.query('SELECT private.enable_test_price_ledger($1)', [UUID(99)]);
    await db.query("INSERT INTO energy_optimisation_price_slots(home_id,start_ts,import_price_sek_per_kwh) VALUES($1,'2026-10-25T00:00Z',1.2)", [UUID(99)]);
    assertEquals((await db.query('SELECT import_price_sek_per_kwh::text price FROM energy_test_price_observations ORDER BY sequence')).rows, [{ price: '0.9' }, { price: '1.2' }]);
    await db.exec('SELECT read_test_price_pair_report(); SELECT read_test_price_correction_report()');
    await assertRejects(() => db.exec('SELECT begin_test_price_pair()'));
    await assertRejects(() => db.exec("SELECT begin_test_price_correction('se3-price-residual-v2')"));
  } finally { await db.close(); }
});
