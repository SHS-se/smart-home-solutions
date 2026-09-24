import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';

const migration = (name: string) => Deno.readTextFile(`supabase/migrations/${name}.sql`);
const home = '11111111-1111-4111-8111-111111111111';
const nextPlan = '22222222-2222-4222-8222-222222222222';

Deno.test('JSONB plan publication preserves payloads, operational state and generation guards', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE homes (id uuid PRIMARY KEY);
      CREATE TABLE customers (id uuid PRIMARY KEY);
      CREATE FUNCTION energy_home_matches_customer(uuid, uuid) RETURNS boolean
        LANGUAGE sql AS $$ SELECT $1 = $2 $$;
      INSERT INTO homes VALUES ('${home}'); INSERT INTO customers VALUES ('${home}');
    `);
    const initial = await migration('20260810120000_add_quarter_hour_energy_optimisation');
    const start = initial.indexOf('CREATE TABLE public.energy_optimisation_current (');
    await db.exec(initial.slice(start, initial.indexOf('\n);', start) + 3));
    const ack = await migration('20260820160000_add_energy_plan_acknowledgements');
    await db.exec(ack.slice(ack.indexOf('ALTER TABLE'), ack.indexOf('\nUPDATE')));
    await db.exec(`ALTER TABLE energy_optimisation_current
      ADD COLUMN replan_request_id uuid, ADD COLUMN replan_requested_at timestamptz,
      ADD COLUMN replan_completed_request_id uuid, ADD COLUMN replan_error text,
      ADD COLUMN ha_runtime jsonb, ADD COLUMN battery_projection jsonb;
      ALTER TABLE energy_optimisation_current ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE ON energy_optimisation_current TO service_role;
    `);
    await db.exec(await migration('20260909120100_fixed_energy_plans'));
    const recommendations = await migration('20260923103000_replan_recommendations');
    await db.exec(recommendations.slice(0, recommendations.indexOf('CREATE FUNCTION public.energy_value_change_recommendation')));
    await db.exec(await migration('20260924121500_store_energy_plan_jsonb'));
    await db.exec(await migration('20260924160000_streamline_energy_plan_storage'));
    const signature = await db.query<{ proargnames: unknown }>("SELECT proargnames FROM pg_proc WHERE oid='store_energy_optimisation_current(jsonb)'::regprocedure");
    assertEquals(signature.rows[0].proargnames, null);
    // Larger than the 4.9 MB plan involved in the reported production-path timeout.
    const plan = { mode: 'live', plan_id: home, policy: Array.from({ length: 60_000 },
      (_, i) => ({ slot: i, values: [0, 1.25, -3], explanation: 'Keep the complete planner output unchanged.' })) };
    const row = {
      home_id: home, customer_id: home, snapshot_id: home, plan_id: home,
      input_hash: 'a'.repeat(64), captured_at: '2026-09-24T11:30:00Z',
      issued_at: '2026-09-24T11:31:00Z', valid_until: '2026-09-25T11:30:00Z',
      binding_until: '2026-09-24T11:45:00Z', status: 'ready', model_version: 'test',
      snapshot: { mode: 'live', observations: [1, 2, 3] }, plan,
      generation_request_id: 'request-1', plan_schema_version: 8,
      ha_ack_status: 'pending', ha_acknowledged_at: null, ha_integration_version: 'test',
      ha_ack_request_id: null, ha_ack_error: null, fixed_plan_generation_revision: 0,
      replan_error: null, battery_projection: { values: [1, 2] }, updated_at: '2026-09-24T11:31:00Z',
    };
    const store = (value: unknown) => db.query('SELECT store_energy_optimisation_current($1::jsonb)', [JSON.stringify(value)]);
    const read = async () => (await db.query<{ value: typeof row & {
      fixed_plan_revision: number; fixed_plan: unknown; replan_request_id: string;
      ha_runtime: unknown; replan_recommendations: { key: string }[];
    } }>('SELECT to_jsonb(c) AS value FROM energy_optimisation_current c')).rows[0].value;
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(() => store(row), Error, 'permission denied');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    await assertRejects(() => store({ p_row: row }), Error, 'null value');
    await store(row);
    const inserted = await read();
    assertEquals(inserted.plan, plan);
    assertEquals(inserted.snapshot, row.snapshot);
    assertEquals(inserted.battery_projection, row.battery_projection);
    assertEquals(inserted.fixed_plan_revision, 0);
    await db.query(`UPDATE energy_optimisation_current SET
      fixed_plan_revision=1, fixed_plan='{"id":"fixed"}', replan_request_id=$1,
      ha_runtime='{"state":"running"}', replan_error='previous failure',
      replan_recommendations=$2`, [home, [
      { key: 'before', occurred_at: '2026-09-24T11:30:00Z' },
      { key: 'during', occurred_at: '2026-09-24T11:33:00Z' },
    ]]);
    const replacement = { ...row, plan_id: nextPlan, plan: { ...plan, plan_id: nextPlan },
      generation_request_id: 'request-2', fixed_plan_generation_revision: 1,
      // These are not publication fields and must never overwrite concurrent state.
      fixed_plan: null, fixed_plan_revision: 99, replan_request_id: null, ha_runtime: null,
      replan_recommendations: [],
    };
    await assertRejects(() => store({ ...replacement, fixed_plan_generation_revision: 0 }),
      Error, 'Fixed plan changed during generation');
    assertEquals((await read()).plan_id, home);
    await store(replacement);
    const saved = await read();
    assertEquals(saved.plan, replacement.plan);
    assertEquals(saved.generation_request_id, 'request-2');
    assertEquals(saved.replan_error, null);
    assertEquals(saved.fixed_plan_revision, 1);
    assertEquals(saved.fixed_plan, { id: 'fixed' });
    assertEquals(saved.replan_request_id, home);
    assertEquals(saved.ha_runtime, { state: 'running' });
    assertEquals(saved.replan_recommendations.map(r => r.key), ['during']);
    await assertRejects(() => store({ ...replacement, input_hash: 'invalid' }), Error, 'check constraint');
    assertEquals((await read()).input_hash, row.input_hash);
    // Revising the generation marker alone cannot bypass the existing guard.
    await assertRejects(() => db.exec(`UPDATE energy_optimisation_current SET
      fixed_plan_generation_revision=0, plan='{"changed":true}'`),
      Error, 'Fixed plan changed during generation');
    await db.exec('RESET ROLE');
    for (const object of [{ keep: null, extra: { huge: [1, 2] } }, null, [], 'text']) {
      const result = await db.query<{ picked: unknown }>(
        "SELECT energy_replan_pick($1::jsonb, ARRAY['keep','keep','missing']) picked", [JSON.stringify(object)]);
      assertEquals(result.rows[0].picked, object && !Array.isArray(object) && typeof object === 'object'
        ? { keep: null } : object);
    }
  } finally { await db.close(); }
});

Deno.test('retention drains bounded batches and preserves other homes and recent data', async () => {
  const db = new PGlite();
  try {
    const tables = ['actual_slots', 'pool_slots', 'device_slots', 'plan_runs', 'forecast_runs'];
    for (const table of tables) {
      const column = table.endsWith('slots') ? 'start_ts' : 'issued_at';
      await db.exec(`CREATE TABLE energy_optimisation_${table} (
        id integer PRIMARY KEY, home_id uuid, ${column} timestamptz);
        INSERT INTO energy_optimisation_${table}
        SELECT n, '${home}', now() - interval '1100 days' FROM generate_series(1,1005) n;
        INSERT INTO energy_optimisation_${table} VALUES
          (1006, '${home}', now()), (1007, '${nextPlan}', now() - interval '1100 days');`);
    }
    await db.exec(await migration('20260924160100_bound_energy_retention_batches'));
    await db.query('SELECT prune_energy_optimisation_data($1)', [home]);
    for (const table of tables) {
      assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int n FROM energy_optimisation_${table}`)).rows[0].n, 7);
    }
    await db.query('SELECT prune_energy_optimisation_data($1)', [home]);
    for (const table of tables) {
      assertEquals((await db.query(`SELECT id FROM energy_optimisation_${table} ORDER BY id`)).rows, [{ id: 1006 }, { id: 1007 }]);
    }
  } finally { await db.close(); }
});
