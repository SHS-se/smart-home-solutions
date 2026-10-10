import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';
import { resolveRulePolicy } from '../supabase/functions/_shared/planner-wasm/rule-policy.ts';
const sql = await Deno.readTextFile('supabase/migrations/20261008142000_publish_rule_planner_policy.sql');
for (const withBench of [false, true]) {
  Deno.test(`live policy publication is service-only and independent of run history (bench=${withBench})`, async () => {
    const db = new PGlite();
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
      if (withBench) await db.exec(`CREATE TABLE bench_rules(id boolean PRIMARY KEY,criteria jsonb);
        INSERT INTO bench_rules VALUES(true,'{"pool_hot":{"threshold":12,"points":-2}}');`);
      await db.exec(sql);
      const read = async () => (await db.query<{criteria:Record<string,never>}>(
        'SELECT criteria FROM energy_planner_rule_policy WHERE id=true')).rows[0].criteria;
      const published = await read();
      assertEquals(resolveRulePolicy(published).rules.find(r => r.key === 'pool_hot')?.points, withBench ? -2 : -1);
      if (withBench) {
        await db.exec(`UPDATE bench_rules SET criteria='{"pool_hot":{"threshold":18,"points":-1}}' WHERE id=true`);
        assertEquals(resolveRulePolicy(await read()).rules.find(r => r.key === 'pool_hot')?.threshold, 18);
      } else assertEquals(published, {});
      for (const role of ['anon','authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        await assertRejects(read, Error, 'permission denied');
        await db.exec('RESET ROLE');
      }
      await db.exec('SET ROLE service_role');
      await read();
    } finally { await db.close(); }
  });
}

const cleanupSql = await Deno.readTextFile('supabase/migrations/20261010190000_remove_obsolete_planner_criteria.sql');
const retired = ['solar_spill', 'idle_battery', 'dear_buy', 'dearest_buy', 'estimated_buy',
  'unplugged_charge', 'ev_short_gap', 'pool_buffer', 'pool_restart', 'cheap_buy', 'cheapest_buy',
  'dear_load', 'dearest_load', 'base_load_dear_import', 'base_load_dearest_import', 'missed_cheap_quarter',
  'arbitrage_no_export', 'arbitrage_not_full', 'ev_from_home_battery', 'large_load_overlap', 'pool_short_gap', 'early_grid_charge'];
const serviceCriteria = {
  pool_low: { threshold: 1.5, points: -2 }, pool_cold: { enabled: false }, pool_hot: { threshold: 3 },
  ev_low: { threshold: 60 }, ev_short: { points: -2 },
};
for (const withBench of [false, true]) {
  Deno.test(`retired criteria migration preserves all service overrides and publishes cleaned policy (bench=${withBench})`, async () => {
    const db = new PGlite();
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
      if (withBench) await db.exec("CREATE TABLE bench_rules(id boolean PRIMARY KEY,criteria jsonb); INSERT INTO bench_rules VALUES(true,'{}');");
      await db.exec(sql);
      const criteria = { ...serviceCriteria, ...Object.fromEntries(retired.map(key => [key, { points: -1 }])) };
      if (withBench) await db.query('UPDATE bench_rules SET criteria=$1::jsonb WHERE id=true', [JSON.stringify(criteria)]);
      else await db.query('UPDATE energy_planner_rule_policy SET criteria=$1::jsonb WHERE id=true', [JSON.stringify(criteria)]);
      await db.exec(cleanupSql);
      const published = (await db.query<{ criteria: typeof serviceCriteria }>('SELECT criteria FROM energy_planner_rule_policy WHERE id=true')).rows[0].criteria;
      assertEquals(published, serviceCriteria);
      assertEquals(resolveRulePolicy(published).rules.map(r => r.key).sort(), Object.keys(serviceCriteria).filter(k => k !== 'pool_cold').sort());
      if (withBench) {
        assertEquals((await db.query<{ criteria: typeof serviceCriteria }>('SELECT criteria FROM bench_rules WHERE id=true')).rows[0].criteria, serviceCriteria);
        await db.query('UPDATE bench_rules SET criteria=$1::jsonb WHERE id=true', [JSON.stringify({ pool_low: { threshold: 0.5 } })]);
        assertEquals((await db.query<{ criteria: unknown }>('SELECT criteria FROM energy_planner_rule_policy WHERE id=true')).rows[0].criteria, { pool_low: { threshold: 0.5 } });
      }
    } finally { await db.close(); }
  });
}
