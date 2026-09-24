import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { replanReference, type ReplanPreviousPlan } from '../supabase/functions/_shared/replan-continuity.ts';
import { snapshot as exampleSnapshot } from '../src/lib/energy-shift/optimisation-snapshot.fixture.ts';
import type { OptimisationPlan, OptimisationSnapshot } from '../supabase/functions/_shared/energy-optimisation.ts';

const home = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

Deno.test('replan read preserves decisions and atomic fixed state with a smaller service-only payload', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE energy_optimisation_current (home_id uuid PRIMARY KEY,
        plan jsonb, fixed_plan jsonb, fixed_plan_revision int);
      ALTER TABLE energy_optimisation_current ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON energy_optimisation_current TO service_role;
    `);
    const original = await Deno.readTextFile('supabase/migrations/20260914220000_narrow_energy_replan_state.sql');
    await db.exec(original);
    await db.exec(original.slice(original.indexOf('CREATE FUNCTION public.get_energy_replan_state'))
      .replaceAll('get_energy_replan_state', 'original_replan_state'));
    const pick = await Deno.readTextFile('supabase/migrations/20260924160000_streamline_energy_plan_storage.sql');
    await db.exec(pick.slice(pick.indexOf('CREATE OR REPLACE FUNCTION public.energy_replan_pick')));
    const migration = await Deno.readTextFile('supabase/migrations/20260924170000_speed_up_energy_portal_and_replan_reads.sql');
    await db.exec(migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION')));
    type State = {
      previous_plan: ReplanPreviousPlan | null; fixed_plan: unknown; fixed_plan_revision: number;
    } | null;
    const read = async (id = home) => {
      const { value, original } = (await db.query<{ value: State; original: State }>(
        'SELECT get_energy_replan_state($1) AS value, original_replan_state($1) AS original', [id])).rows[0];
      assertEquals(value, original, 'Optimized projection must preserve the complete RPC result');
      return value;
    };
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assertRejects(() => read(), Error, 'permission denied');
      await db.exec('RESET ROLE');
    }
    await db.query('INSERT INTO energy_optimisation_current VALUES ($1, null, null, 0)', [home]);
    await db.exec('SET ROLE service_role');
    assertEquals(await read(other), null);
    assertEquals((await read())!.previous_plan, null);
    await db.exec('RESET ROLE');

    for (const fixtureName of ['schema-6-dispatched-ev-plan', 'schema-8-battery-plan']) {
      const fixture = JSON.parse(await Deno.readTextFile(`contracts/ha-api/fixtures/${fixtureName}.json`));
      const plan: OptimisationPlan = fixture.plan;
      assert(plan.mode === "live");
      const base = exampleSnapshot();
      const snapshot: OptimisationSnapshot = { ...base, snapshot_id: other,
        schema_version: plan.schema_version, mode: plan.mode, capabilities: plan.capabilities,
        slots: plan.plans.priority.slots.map(slot => ({ ...base.slots[0], start: slot.start })),
      };
      const now = new Date(plan.plans.priority.slots[0].start);
      const variants = [
        plan,
        { ...plan, valid_until: now.toISOString() },
        { ...plan, issued_at: new Date(now.getTime() + 1).toISOString() },
        { ...plan, plan_id: other },
        { ...plan, fixed_plan: { id: 'fixed', starts_at: plan.issued_at, ends_at: plan.valid_until } },
        { ...plan, capabilities: { ...plan.capabilities, battery: !plan.capabilities.battery } },
        { ...plan, plans: { ...plan.plans, priority: { ...plan.plans.priority, slots: [] } } },
        { ...plan, plans: { ...plan.plans, priority: { ...plan.plans.priority, status: 'infeasible' as const } } },
      ];
      for (const candidate of variants) {
        const fixed = { id: 'scheduled', slots: [{ start: plan.issued_at }] };
        await db.query(`UPDATE energy_optimisation_current SET plan=$2, fixed_plan=$3,
          fixed_plan_revision=7 WHERE home_id=$1`, [home, candidate, fixed]);
        await db.exec('SET ROLE service_role');
        const state = (await read())!;
        await db.exec('RESET ROLE');
        assertEquals(state.fixed_plan, fixed);
        assertEquals(state.fixed_plan_revision, 7);
        for (const time of [now, new Date(now.getTime() + 900_000), new Date(plan.valid_until)]) {
          assertEquals(replanReference(state.previous_plan, snapshot, time), replanReference(candidate, snapshot, time));
        }
        assertEquals(state.previous_plan!.plans.priority.slots.map(s => s.start), candidate.plans.priority.slots.map(s => s.start));
        if (candidate === plan) {
          assert(replanReference(plan, snapshot, now), 'fixture must exercise a usable reference');
          const before = JSON.stringify({ plan, fixed_plan: fixed, fixed_plan_revision: 7 }).length;
          const after = JSON.stringify(state).length;
          assert(after < before / 10, `expected >90% reduction: ${before} -> ${after}`);
          console.log(`${fixtureName}: previous-plan read ${before} -> ${after} bytes`);
        }
      }
    }
    // Missing fields stay missing, distinct from explicit JSON nulls.
    const sparse = { capabilities: { battery: null }, plans: { priority: { slots: [{ start: 'x' }, { start: 'x', battery_command: null }] } } };
    await db.query('UPDATE energy_optimisation_current SET plan=$1', [sparse]);
    assertEquals<unknown>((await read())!.previous_plan, sparse);
    for (const value of [null, [], 7, {}, { plans: null }, { plans: [] },
      { plans: {} }, { plans: { priority: null } }, { plans: { priority: [] } },
      { plans: { priority: {} } }, { plans: { priority: { slots: null } } },
      { plans: { priority: { slots: {} } } }, { plans: { priority: { slots: [] } } }]) {
      await db.query('UPDATE energy_optimisation_current SET plan=$1::jsonb', [JSON.stringify(value)]);
      assertEquals<unknown>((await read())!.previous_plan, value);
    }
    await db.exec("UPDATE energy_optimisation_current SET plan='null'::jsonb");
    assertEquals((await read())!.previous_plan, null);
  } finally { await db.close(); }
});
