import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';

Deno.test('saved ROI RPCs enforce customer access, model generations, month compare-and-swap and twelve-month storage', async () => {
  const db = new PGlite();
  const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const version = `roi-month-v1:${'a'.repeat(64)}`;
  const model = { captured_at: '2026-10-11T00:00:00Z', timezone: 'Europe/Stockholm', capabilities: {}, device_models: [], services: [], grid: {} };
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.role',true),'') $$;
      CREATE FUNCTION can_access_energy_billing_customer(id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT id=NULLIF(current_setting('test.uid',true),'')::uuid $$;
      CREATE TABLE customers(id uuid PRIMARY KEY); CREATE TABLE homes(id uuid PRIMARY KEY,customer_id uuid);
      CREATE FUNCTION energy_home_matches_customer(home uuid,customer uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM homes WHERE id=home AND customer_id=customer) $$;
      INSERT INTO customers VALUES ('${id}'),('${other}'); INSERT INTO homes VALUES ('${id}','${id}'),('${other}','${other}');`);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261011175100_roi_saved_reports.sql'));
    const pin = async (home = id, customer = id, generation: number | null = null) => (await db.query<{ report: { generation: number; months: Record<string, unknown>; model: unknown } }>(
      'SELECT pin_energy_roi_report($1,$2,$3,$4::jsonb,$5) AS report', [home, customer, version, model, generation])).rows[0].report;
    await assertRejects(() => pin(), Error, 'access denied'); // NULL role/access fail closed.
    await db.exec(`SET test.role='authenticated'; SET test.uid='${id}'; SET ROLE authenticated;`);
    await assertRejects(() => pin(other, other), Error, 'access denied');
    await assertRejects(() => pin(other, id), Error, 'access denied');
    const first = await pin(); assertEquals(first.generation, 1); assertEquals(first.months, {});
    assertEquals((await pin()).generation, 1);
    await assertRejects(() => db.query('UPDATE energy_roi_reports SET months=\'{}\''), Error, 'permission denied');
    const save = async (month: string, hash: string, expected: string | null = null, generation = 1, end = '2026-10-01T00:00:00Z') => (await db.query<{ report: { months: Record<string, { inputHash: string }> } }>(
      'SELECT save_energy_roi_month($1,$1,$2,$3,$4::jsonb,$5,$6) AS report', [id, generation, version,
        { month, start: '2025-01-01T00:00:00Z', end, coverage: 1, baseline: {}, recorded: {}, comparison: {}, quality: {}, gaps: {} }, hash, expected])).rows[0].report;
    const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64);
    await save('2026-09', hashA);
    await db.exec(`RESET ROLE; UPDATE energy_roi_reports SET months=jsonb_set(months,'{2026-09,computedAt}','"2025-01-01T00:00:00.000Z"'); SET ROLE authenticated;`);
    await save('2026-09', hashA);
    assertEquals((await db.query<{ old: boolean }>(`SELECT months->'2026-09'->>'computedAt'='2025-01-01T00:00:00.000Z' AS old FROM energy_roi_reports`)).rows[0].old, false);
    await assertRejects(() => save('2026-09', hashB), Error, 'another session');
    await assertRejects(() => save('2026-09', hashB, hashA, 2), Error, 'model changed');
    await assertRejects(() => save('2026-09', hashB, hashA, 1, '2026-09-01T00:00:00Z'), Error, 'another session');
    assertEquals((await save('2026-09', hashB, hashA)).months['2026-09'].inputHash, hashB);
    for (let month = 1; month <= 12; month++) await save(`2025-${String(month).padStart(2,'0')}`, hashA);
    const rows = (await db.query<{ months: Record<string, unknown> }>('SELECT months FROM energy_roi_reports')).rows;
    assertEquals(Object.keys(rows[0].months).length, 12);
    await db.exec(`RESET ROLE; SET test.uid='${other}'; SET ROLE authenticated;`);
    assertEquals((await db.query('SELECT * FROM energy_roi_reports')).rows, []);
    await db.exec(`RESET ROLE; SET test.uid='${id}'; SET ROLE authenticated;`);
    const next = await pin(id, id, 1); assertEquals(next.generation, 2); assertEquals(next.months, {});
    assertEquals((await pin(id, id, 1)).generation, 2); // A stale recalculation adopts the winner.
    await assertRejects(() => save('2026-09', hashA), Error, 'model changed');
    await assertRejects(() => db.query('SELECT pin_energy_roi_report($1,$1,NULL,$2::jsonb,NULL)', [id, model]), Error, 'Invalid compact');
  } finally { await db.close(); }
});
