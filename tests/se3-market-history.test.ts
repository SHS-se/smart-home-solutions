/** Synthetic market observations. */
import { assertEquals, assertRejects } from '@std/assert';
import { marketFoundationDb } from './helpers/market-foundation-db.ts';
import { collectionPlan, parseCollectionRequest } from '../supabase/functions/_shared/market-collection-plan.ts';
import { marketDaySpan } from '../supabase/functions/_shared/demand-forecast-quality.ts';
import { parseSvkFlowResponse } from '../supabase/functions/_shared/svk-physical-flows.ts';
import { assessMarketObservation } from '../supabase/functions/_shared/market-evidence-assessment.ts';

Deno.test('SE3 backfill uses native Stockholm day bounds and keeps absent physical readings missing', () => {
  const day = '2026-10-25';
  assertEquals(parseCollectionRequest(JSON.stringify({ history: day })), { kind: 'market_history', day });
  const plan = collectionPlan('market_history', new Date('2026-10-27T12:00Z'), day);
  assertEquals(plan.map(row => row.dataset), ['spot_price', 'jao_day_ahead_border_flows', 'svk_physical_imports', 'svk_physical_exports', 'generation_actual']);
  assertEquals((Date.parse(plan[0].to) - Date.parse(plan[0].from)) / 3_600_000, 25);
  const data = parseSvkFlowResponse('svk_physical_exports', { success: true, result: { total: 1, records: [
    { start_time_utc: '2026-10-24T22:00:00', from_bidding_zone: 'SE3', to_bidding_zone: 'FI', power: 100, power_unit: 'MW' },
  ] } }, plan[0].from, plan[0].to);
  assertEquals(data.records.map(record => record.values), [{ FI: -100 }]);
});

Deno.test('SE3 staff day projection keeps native blocks, holes, revisions and both SE4 paths', async () => {
  const db = await marketFoundationDb();
  try {
    for (const migration of ['20261101143000_retire_test_price_workers', '20261101144000_market_data_foundation',
      '20261101162000_weather_accuracy_quality_monitor', '20261101164000_verified_regional_context',
      '20261101180000_retrospective_regional_backfill', '20261101181000_native_history_request_windows',
      '20261113134000_se3_market_history']) {
      await db.exec(await Deno.readTextFile(`supabase/migrations/${migration}.sql`));
    }
    await db.exec('SELECT private.enable_test_market_archive()');
    const day = '2026-10-25';
    const [start] = marketDaySpan(day);
    const iso = (ms: number) => new Date(ms).toISOString();
    const quarter = 900_000;
    const now = new Date('2026-11-01T12:00Z');
    const plan = collectionPlan('market_history', now, day);
    const add = async (documents: Record<string, object>) => {
      const batchId = crypto.randomUUID();
      await db.query('INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,$2,$3,$4)',
        [batchId, 'market_history', now.toISOString(), plan]);
      for (const request of plan.filter(request => request.dataset in documents)) {
        const row = { id: crypto.randomUUID(), batch_id: batchId, request_key: request.key, dataset: request.dataset,
          zone: request.zone, requested_from: request.from, requested_to: request.to, requested_at: now.toISOString(), resolved_at: now.toISOString(),
          result: { status: 'data', document: documents[request.dataset] } };
        await db.query('SELECT record_test_market_observation($1,$2)', [row, assessMarketObservation(row)]);
      }
    };
    const interval = { startMs: start, endMs: start + 2 * quarter, resolution: 'PT15M', value: 4 };
    const cell = (at: number, values: object) => ({ start: iso(at), end: iso(at + quarter), values });
    await add({
      spot_price: { intervals: [{ ...interval, unit: 'MWH', currency: 'EUR' }] },
      generation_actual: { intervals: [{ ...interval, unit: 'MAW', flow: 'production', psrType: 'B14' },
        { ...interval, unit: 'MAW', flow: 'production', psrType: 'B19' },
        { ...interval, unit: 'MAW', flow: 'production', psrType: 'B19', value: 5 }] },
      svk_physical_imports: { unit: 'MW', records: [cell(start, { SE2: 20 })] },
      svk_physical_exports: { unit: 'MW', records: [cell(start, { FI: -10 })] },
      jao_day_ahead_border_flows: { unit: 'MW', records: [cell(start, { border_SE3_SE2: -20, border_SE3_SE4: 3, border_SE3_SE3SWL: 4 }),
        cell(start + quarter, { border_SE3_SE4: 3, border_SE3_SE3SWL: null })] },
    });
    const read = async (date: string) => (await db.query<{ day: unknown[] }>('SELECT get_test_se3_market_day($1) AS day', [date])).rows[0].day;
    await db.exec('SET ROLE authenticated');
    const result = await read(day);
    assertEquals(result.length, 100);
    assertEquals((await read('2026-03-29')).length, 92);
    assertEquals(result[0], { start: '2026-10-24T22:00:00+00:00', spot: 4, generation: { B14: 4, B19: null }, measured: { SE2: 20, FI: -10 },
      scheduled: { SE2: 20, SE4: -7, DK1: null, FI: null, NO1: null } });
    assertEquals(result[1], { start: '2026-10-24T22:15:00+00:00', spot: 4, generation: { B14: 4, B19: null }, measured: null,
      scheduled: { SE2: null, SE4: null, DK1: null, FI: null, NO1: null } });
    await db.exec('RESET ROLE');
    await add({ svk_physical_imports: { unit: 'MW', records: [] } });
    assertEquals((await read(day))[0], { ...(result[0] as object), measured: { FI: -10 } });
    await db.exec('CREATE OR REPLACE FUNCTION is_staff(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$; SET ROLE authenticated;');
    await assertRejects(() => read(day), Error, 'Market history is staff-only');
    await db.exec('RESET ROLE; SET ROLE anon;');
    await assertRejects(() => read(day), Error, 'permission denied');
  } finally { await db.close(); }
});
