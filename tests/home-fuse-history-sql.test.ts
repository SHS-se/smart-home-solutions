import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';
Deno.test('home fuse corrections are scoped, authorized and idempotent', async () => {
  const db = new PGlite();
  const home='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.role',true) $$;
      CREATE TABLE homes(id uuid PRIMARY KEY, customer_id uuid NOT NULL);
      CREATE FUNCTION can_access_energy_billing_customer(id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT id='${home}'::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated,service_role;
      GRANT SELECT ON homes TO authenticated;
      INSERT INTO homes VALUES ('${home}','${home}'),('${other}','${other}');`);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261012210000_add_home_fuse_changes.sql'));
    await db.exec("SET test.role='authenticated'; SET ROLE authenticated;");
    await db.query('SELECT record_home_fuse_change($1,$2,35)',[home,'2026-09-11']);
    await db.query('SELECT record_home_fuse_change($1,$2,35)',[home,'2026-09-11']);
    assertEquals((await db.query('SELECT * FROM home_fuse_changes')).rows.length,1);
    await assertRejects(()=>db.query('SELECT record_home_fuse_change($1,$2,35)',[other,'2026-09-11']),Error,'access denied');
    await assertRejects(()=>db.query('INSERT INTO home_fuse_changes VALUES ($1,$2,25)',[home,'2026-10-01']),Error,'permission denied');
    await db.exec("RESET ROLE; SET test.role='service_role'; SET ROLE service_role;");
    await db.query('SELECT record_home_fuse_change($1,$2,25)',[other,'2026-10-01']);
    await db.exec("RESET ROLE; SET test.role='authenticated'; SET ROLE authenticated;");
    assertEquals((await db.query('SELECT * FROM home_fuse_changes')).rows.length,1);
  } finally { await db.close(); }
});
