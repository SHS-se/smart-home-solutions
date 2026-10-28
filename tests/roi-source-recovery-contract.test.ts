import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';
import { baselineFixture, captureStub } from '../src/lib/home-baseline/fixture.ts';
import { prepareHomeBaseline, projectBaseline } from '../src/lib/home-baseline/model.ts';
import { CALCULATION_VERSION, compactModel, parseSavedReport, type SavedReport } from '../src/lib/home-baseline/saved-months.ts';
import { comparisonMonthLedger } from '../src/lib/home-baseline/savings.ts';
import { withSimulationBasis } from '../src/lib/home-baseline/simulation-state.ts';
import { seedPool, withPoolState, type PoolSeed } from '../src/lib/home-baseline/pool-carry.ts';
import { createWasmPlanner } from '../supabase/functions/_shared/planner-wasm/core.ts';
import type { PoolDynamics } from '../supabase/functions/_shared/planner/pool-response.ts';

const migration = 'supabase/migrations/20261028154500_roi_continuous_storage.sql';
const id = '11111111-1111-4111-8111-111111111111';

Deno.test('current browser reports pin and save through SQL with source recovery and exact seed memories', async () => {
  const db = new PGlite();
  const engine = createWasmPlanner(await Deno.readFile('supabase/functions/_shared/planner-wasm/solver.wasm'));
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.role',true),'') $$;
      CREATE FUNCTION can_access_energy_billing_customer(id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT id=NULLIF(current_setting('test.uid',true),'')::uuid $$;
      CREATE TABLE customers(id uuid PRIMARY KEY); CREATE TABLE homes(id uuid PRIMARY KEY,customer_id uuid);
      CREATE FUNCTION energy_home_matches_customer(home uuid,customer uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM homes WHERE id=home AND customer_id=customer) $$;
      INSERT INTO customers VALUES('${id}'); INSERT INTO homes VALUES('${id}','${id}');`);
    for (const name of ['20261011175100_roi_saved_reports.sql', '20261012110000_roi_solar_history.sql',
      '20261012140000_roi_pool_continuity.sql', '20261017133200_pool_response_roi_state.sql']) {
      await db.exec(await Deno.readTextFile(`supabase/migrations/${name}`));
    }
    const rows = baselineFixture({ start: '2026-08-31T22:00:00.000Z', end: '2026-09-30T22:00:00.000Z' });
    const pin = async (version = CALCULATION_VERSION, generation: number | null = null) => {
      const model = compactModel(rows.snapshot);
      if (version.startsWith('roi-month-v6:')) delete (model as unknown as Record<string, unknown>).roi_simulation_seed;
      return (await db.query<{ report: SavedReport }>('SELECT pin_energy_roi_report($1,$1,$2,$3::jsonb,$4) AS report', [id, version, model, generation])).rows[0].report;
    };
    await db.exec(`SET test.role='authenticated'; SET test.uid='${id}'; SET ROLE authenticated;`);
    // Reproduce the deployed mismatch using the real browser version and model.
    await assertRejects(() => pin(), Error, 'Invalid compact ROI model');
    const old = await pin(`roi-month-v6:${'a'.repeat(64)}`);
    await db.exec('RESET ROLE');
    await db.exec(await Deno.readTextFile('supabase/migrations/20261028120000_roi_source_recovery_contract.sql'));
    await db.exec(await Deno.readTextFile(migration));
    await db.exec('SET ROLE authenticated');
    await assertRejects(() => pin(`roi-month-v6:${'a'.repeat(64)}`), Error, 'ROI calculation updated');
    const upgraded = parseSavedReport(await pin());
    assertEquals(upgraded.generation, old.generation + 1);
    assertEquals(upgraded.months, {});

    // All inputs below are independently specified synthetic equipment/data.
    delete rows.snapshot.device_physics!.pool;
    const response: PoolDynamics = {
      version: 2, response_time_constant_h: .5, heat_c_per_kwh: .08,
      source: null, idle_c_per_h: -.02, reference_c: 30, sample_count: 100,
      rmse_c: .02, instantaneous_rmse_c: .03, constant_gain_rmse_c: .02,
      recovery_evidence: { restarts: 10, shortest_off_h: 1, longest_off_h: 8, profile: [],
        minimum_at_search_boundary: false, steady_heat_fraction_at_observed_peak: null },
      initial_state: { at: rows.start, pending_heat_kwh: 2, source_depletion_kwh: 0 },
      state: { at: rows.end, pending_heat_kwh: 1, source_depletion_kwh: 0 },
    };
    rows.snapshot.pool_model!.thermal_dynamics = response;
    await db.exec("RESET ROLE; SET test.role='service_role'; SET ROLE service_role;");
    const seed = (await db.query<{ seed: PoolSeed }>('SELECT publish_energy_roi_pool_seed($1,$1,$2,30) AS seed', [id, '2026-09'])).rows[0].seed;
    rows.snapshot.roi_pool_seed = seed;
    rows.snapshot.roi_simulation_seed = { month: seed.month, hash: seed.hash };
    await db.exec("RESET ROLE; SET test.role='authenticated'; SET ROLE authenticated;");
    let generation = upgraded.generation;
    for (const memory of ['unobserved', 'constant_gain', 'source_recovery', 'observed_state'] as const) {
      const withSource = memory === 'source_recovery' || memory === 'observed_state';
      response.source = withSource ? { recovery_rate_per_h: .2, heat_loss_c_per_kwh_per_kwh: .0001 } : null;
      response.initial_state = { at: memory === 'unobserved' || memory === 'observed_state' ? '2026-08-01T00:00:00.000Z' : rows.start,
        pending_heat_kwh: 2, source_depletion_kwh: withSource ? 3 : 0 };
      response.state = { at: memory === 'observed_state' ? rows.start : rows.end, pending_heat_kwh: 1, source_depletion_kwh: withSource ? 4 : 0 };
      const report = parseSavedReport(await pin(CALCULATION_VERSION, generation));
      generation = report.generation;
      const checkpoint = memory === 'unobserved' ? null : memory === 'observed_state' ? response.state : response.initial_state;
      const pool = seedPool(seed, checkpoint);
      const input = withSimulationBasis(prepareHomeBaseline(rows), { kind: 'seed', hash: seed.hash, pool });
      input.problem = withPoolState(input.problem, pool.initial.baseline);
      const capture = captureStub({ input, result: projectBaseline(input, engine), engineHash: 'synthetic' });
      const ledger = comparisonMonthLedger(capture);
      const save = async (value = ledger, version = CALCULATION_VERSION) => (await db.query<{ report: SavedReport }>(
        'SELECT save_energy_roi_month($1,$1,$2,$3,$4::jsonb,$5,NULL) AS report', [id, generation, version, value, 'b'.repeat(64)])).rows[0].report;
      await assertRejects(() => save(ledger, `roi-month-v6:${'a'.repeat(64)}`), Error, 'ROI calculation updated');
      const saved = parseSavedReport(await save());
      assertEquals(saved.months['2026-09'].ledger, ledger);
      assertEquals(saved.checkpoints['2026-09'].initial, ledger.continuation!.initial);
      assertEquals(saved.checkpoints['2026-09'].final, ledger.continuation!.final);
      for (const sourceDepletionKwh of [-1, 'invalid', undefined]) {
        const invalid = structuredClone(ledger);
        Object.assign(invalid.continuation!.final.baseline.pool!, { sourceDepletionKwh });
        await assertRejects(() => save(invalid), Error, 'Invalid simulation continuation');
      }
      const wrongMemory = structuredClone(ledger);
      wrongMemory.continuation!.initial.baseline.pool!.pendingHeatKwh++;
      await assertRejects(() => save(wrongMemory), Error, 'predecessor changed');
    }
  } finally { await db.close(); }
});
