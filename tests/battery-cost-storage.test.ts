import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';

const home = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const customer = '33333333-3333-4333-8333-333333333333';

Deno.test('battery curve migration repairs insert/update pruning while preserving frozen results and home isolation', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE customers (id uuid PRIMARY KEY);
      CREATE TABLE homes (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers(id));
      GRANT SELECT ON homes TO service_role;
      CREATE TABLE energy_optimisation_value_curves (store_key text);
      CREATE FUNCTION energy_home_matches_customer(home_id uuid, customer_id uuid) RETURNS boolean
        LANGUAGE sql AS 'SELECT EXISTS (SELECT 1 FROM homes h WHERE h.id = $1 AND h.customer_id = $2)';
      CREATE FUNCTION can_access_energy_billing_customer(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    `);
    await db.query('INSERT INTO customers VALUES ($1)', [customer]);
    await db.query('INSERT INTO homes VALUES ($1,$3),($2,$3)', [home,other,customer]);
    await db.exec(await Deno.readTextFile('supabase/migrations/20260921220000_battery_curve_generation_modes.sql'));
    const insert = (key: string, homeId = home, days = 0, ready = false) => db.query(`
      INSERT INTO energy_optimisation_battery_cost_curves(home_id,key,customer_id,input,created_at,record)
      VALUES ($1,$2,$3,'{"source":"frozen"}',now()-$4*interval '1 day',$5::jsonb)
      ON CONFLICT(home_id,key) DO NOTHING`, [homeId,key,customer,days,ready ? '{"curve":"selected"}' : null]);
    await db.exec('SET ROLE service_role');
    // Reproduce the actual deployed INSERT failure, not just SQL text matching.
    await assertRejects(() => insert('initial'), Error, 'ambiguous');
    await db.exec('RESET ROLE');
    await db.exec(await Deno.readTextFile('supabase/migrations/20260921221000_fix_battery_curve_pruning_alias.sql'));
    await db.exec('SET ROLE service_role');
    await insert('initial');
    await insert('initial'); // Resolver reload uses ON CONFLICT DO NOTHING.
    await db.query(`UPDATE energy_optimisation_battery_cost_curves SET revision=1,progress='{"evaluations":[1]}' WHERE home_id=$1 AND key='initial'`, [home]);
    await db.query(`UPDATE energy_optimisation_battery_cost_curves SET revision=2,record='{"curve":"selected"}',progress='{"evaluations":[]}' WHERE home_id=$1 AND key='initial'`, [home]);
    const row = (await db.query<{revision:number,input:unknown,record:unknown}>(
      'SELECT revision,input,record FROM energy_optimisation_battery_cost_curves WHERE home_id=$1 AND key=$2', [home,'initial'])).rows[0];
    assertEquals(row,{revision:2,input:{source:'frozen'},record:{curve:'selected'}});
    await assertRejects(() => db.query(`UPDATE energy_optimisation_battery_cost_curves SET revision=3,record='{}' WHERE home_id=$1 AND key='initial'`, [home]), Error, 'immutable');

    // Seed historical rows before attaching pruning to test the retention boundary.
    await db.exec('RESET ROLE; ALTER TABLE energy_optimisation_battery_cost_curves DISABLE TRIGGER prune_battery_cost_curves');
    await insert('expired',home,4,true);
    await insert('pending',home,5);
    await insert('recent',home,1,true);
    await insert('other-expired',other,4,true);
    await insert('other-newest',other,3,true);
    await db.exec('ALTER TABLE energy_optimisation_battery_cost_curves ENABLE TRIGGER prune_battery_cost_curves; SET ROLE service_role');
    await insert('next');
    const keys = async (id: string) => (await db.query<{key:string}>(
      'SELECT key FROM energy_optimisation_battery_cost_curves WHERE home_id=$1 ORDER BY key',[id])).rows.map(r=>r.key);
    assertEquals(await keys(home), ['initial','next','pending','recent']);
    assertEquals(await keys(other), ['other-expired','other-newest']);
    await insert('other-pending',other);
    assertEquals(await keys(other), ['other-newest','other-pending']); // Keep latest even if older than two days.
    await assertRejects(() => db.query(`UPDATE energy_optimisation_battery_cost_curves SET revision=1,input='{}' WHERE home_id=$1 AND key='next'`, [home]), Error, 'immutable');
    await db.exec('RESET ROLE; SET ROLE authenticated');
    await assertRejects(() => insert('unauthorized'), Error, 'permission denied');
  } finally {
    await db.close();
  }
});
