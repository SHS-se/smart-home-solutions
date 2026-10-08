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
        INSERT INTO bench_rules VALUES(true,'{"pool_restart":{"threshold":12,"points":-2}}');`);
      await db.exec(sql);
      const read = async () => (await db.query<{criteria:Record<string,never>}>(
        'SELECT criteria FROM energy_planner_rule_policy WHERE id=true')).rows[0].criteria;
      const published = await read();
      assertEquals(resolveRulePolicy(published).rules.find(r => r.key === 'pool_restart')?.points, -2);
      if (withBench) {
        await db.exec(`UPDATE bench_rules SET criteria='{"pool_restart":{"threshold":18,"points":-1}}' WHERE id=true`);
        assertEquals(resolveRulePolicy(await read()).rules.find(r => r.key === 'pool_restart')?.threshold, 18);
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
