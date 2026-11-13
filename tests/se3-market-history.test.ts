/** Synthetic market observations. */
import { assertEquals, assertRejects } from '@std/assert';
import { marketFoundationDb } from './helpers/market-foundation-db.ts';
import { collectionPlan, parseCollectionRequest } from '../supabase/functions/_shared/market-collection-plan.ts';
import { marketDaySpan } from '../supabase/functions/_shared/demand-forecast-quality.ts';
import { parseSvkFlowResponse } from '../supabase/functions/_shared/svk-physical-flows.ts';
import { parseJaoResponse } from '../supabase/functions/_shared/jao-nordic-market-data.ts';
import { assessMarketObservation } from '../supabase/functions/_shared/market-evidence-assessment.ts';

Deno.test('SE3 backfill uses native Stockholm day bounds and keeps absent physical readings missing', () => {
  const day = '2026-10-25';
  assertEquals(parseCollectionRequest(JSON.stringify({ history: day })), { kind: 'market_history', day });
  const plan = collectionPlan('market_history', new Date('2026-10-27T12:00Z'), day);
  assertEquals(plan.map(row => row.dataset), ['jao_day_ahead_net_position', 'spot_price', 'jao_day_ahead_border_flows', 'svk_physical_imports', 'svk_physical_exports', 'generation_actual']);
  const request = parseCollectionRequest(JSON.stringify({ netPositionHistory: day }));
  assertEquals(collectionPlan(request.kind, new Date('2026-10-27T12:00Z'), request.day, request.flowHistoryDataset).map(row => row.dataset), ['jao_day_ahead_net_position']);
  const borderRequest = parseCollectionRequest(JSON.stringify({ borderFlowHistory: day }));
  assertEquals(collectionPlan(borderRequest.kind, new Date('2026-10-27T12:00Z'), borderRequest.day, borderRequest.flowHistoryDataset).map(row => row.dataset), ['jao_day_ahead_border_flows']);
  assertEquals(parseJaoResponse('jao_day_ahead_net_position', { rejected: false, messages: [], data: [
    { dateTimeUtc: '2026-10-24T22:00Z', lastModifiedOn: '2026-10-24T12:45:00', hub_SE3: -230, hub_SE4: 56 },
  ] }).records[0].values, { hub_SE3: -230 });
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
      '20261113134000_se3_market_history', '20261113205000_test_se3_net_import_forecast', '20261113220000_test_se3_gross_flow_forecasts']) {
      await db.exec(await Deno.readTextFile(`supabase/migrations/${migration}.sql`));
    }
    await db.exec('SELECT private.enable_test_market_archive()');
    const day = '2026-10-25';
    const [start] = marketDaySpan(day);
    const iso = (ms: number) => new Date(ms).toISOString();
    const quarter = 900_000;
    const now = new Date('2026-11-01T12:00Z');
    const plan = collectionPlan('market_history', now, day);
    const add = async (documents: Record<string, object>, requests = plan) => {
      const batchId = crypto.randomUUID();
      await db.query('INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,$2,$3,$4)',
        [batchId, 'market_history', now.toISOString(), requests]);
      for (const request of requests.filter(request => request.dataset in documents)) {
        const row = { id: crypto.randomUUID(), batch_id: batchId, request_key: request.key, dataset: request.dataset,
          zone: request.zone, requested_from: request.from, requested_to: request.to, requested_at: now.toISOString(), resolved_at: now.toISOString(),
          result: { status: 'data', document: documents[request.dataset] } };
        await db.query('SELECT record_test_market_observation($1,$2)', [row, assessMarketObservation(row)]);
      }
    };
    const interval = { startMs: start, endMs: start + 2 * quarter, resolution: 'PT15M', value: 4 };
    const cell = <T extends object>(at: number, values: T) => ({ start: iso(at), end: iso(at + quarter), values });
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
    const missing = { forecast_d2: null, forecast_d3: null, reconstructed_d2: null, reconstructed_d3: null,
      gross_forecast_d2: null, gross_forecast_d3: null, gross_reconstructed_d2: null, gross_reconstructed_d3: null };
    assertEquals(result[0], { ...missing, start: '2026-10-24T22:00:00+00:00', spot: 4, generation: { B14: 4, B19: null }, measured: { SE2: 20, FI: -10 },
      scheduled: { SE2: 20, SE4: -7, DK1: null, FI: null, NO1: null } });
    assertEquals(result[1], { ...missing, start: '2026-10-24T22:15:00+00:00', spot: 4, generation: { B14: 4, B19: null }, measured: null,
      scheduled: { SE2: null, SE4: null, DK1: null, FI: null, NO1: null } });
    await db.exec('RESET ROLE');
    await add({ svk_physical_imports: { unit: 'MW', records: [] } });
    assertEquals((await read(day))[0], { ...(result[0] as object), measured: { FI: -10 } });

    // Forecast for 1 November uses a repeated Stockholm quarter on 25 October.
    const priorWeeks = ['2026-10-25', '2026-10-18', '2026-10-11', '2026-10-04'];
    for (const [index, prior] of priorWeeks.entries()) {
      const requests = collectionPlan('market_history', now, prior);
      const start = marketDaySpan(prior)[0] + 8 * quarter;
      const cells = [cell(start, { hub_SE3: -100 * (index + 1) })];
      if (index === 0) cells.push(cell(start + 4 * quarter, { hub_SE3: -300 }));
      cells.push(cell(start + quarter, { hub_SE3: -1000 }));
      const records = cells.map((value, cellIndex) => ({
        ...value, provider_modified_at: index === 2 && cellIndex === cells.length - 1 ? '2026-11-01T12:00:00Z' : '2026-10-26T12:00:00Z',
      }));
      const grossRecords = records.map(({ values, ...record }, cellIndex) => ({
        ...record,
        values: {
          border_SE3_SE2: values.hub_SE3,
          border_SE3_SE4: 125, border_SE3_SE3SWL: -25,
          border_SE3_SE3KS: 30, border_SE3_SE3FS: -20, border_SE3_NO1: 10,
          ...(cellIndex === records.length - 1 && index === 1 ? { border_SE3_SE3SWL: null } : {}),
        },
      }));
      await add({
        jao_day_ahead_net_position: { semantics: 'day_ahead_net_position', unit: 'MW', records },
        jao_day_ahead_border_flows: { semantics: 'day_ahead_border_flow', unit: 'MW', records: grossRecords },
      }, requests);
    }
    for (const origin of ['2026-10-29', '2026-10-30']) {
      assertEquals((await db.query('SELECT private.record_test_se3_net_import_forecasts($1) AS saved', [origin])).rows, [{ saved: 1 }]);
      assertEquals((await db.query('SELECT private.record_test_se3_net_import_forecasts($1) AS saved', [origin])).rows, [{ saved: 0 }]);
      assertEquals((await db.query('SELECT private.record_test_se3_gross_flow_forecasts($1) AS saved', [origin])).rows, [{ saved: 1 }]);
      assertEquals((await db.query('SELECT private.record_test_se3_gross_flow_forecasts($1) AS saved', [origin])).rows, [{ saved: 0 }]);
    }
    await db.exec('SET ROLE authenticated');
    const forecast = await read('2026-11-01') as Record<string, unknown>[];
    assertEquals([forecast[8].forecast_d2, forecast[8].forecast_d3], [275, 275]);
    assertEquals([forecast[8].reconstructed_d2, forecast[8].reconstructed_d3], [true, true]);
    assertEquals([forecast[9].forecast_d2, forecast[9].forecast_d3], [null, null]);
    const gross = { imports_mw: 295, exports_mw: -140 };
    assertEquals([forecast[8].gross_forecast_d2, forecast[8].gross_forecast_d3], [gross, gross]);
    assertEquals([forecast[8].gross_reconstructed_d2, forecast[8].gross_reconstructed_d3], [true, true]);
    assertEquals([forecast[9].gross_forecast_d2, forecast[9].gross_forecast_d3], [null, null]);
    await db.exec('RESET ROLE');
    await db.exec('CREATE OR REPLACE FUNCTION is_staff(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$; SET ROLE authenticated;');
    await assertRejects(() => read(day), Error, 'Market history is staff-only');
    await db.exec('RESET ROLE; SET ROLE anon;');
    await assertRejects(() => read(day), Error, 'permission denied');
  } finally { await db.close(); }
});
