import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';
import { homeMonthBounds } from '../src/lib/energy-shift/home-time.ts';

Deno.test('pool checkpoints enforce own-home seed, independent predecessor states, generations and descendant invalidation beyond twelve summaries', async () => {
  const db = new PGlite(), id = '11111111-1111-4111-8111-111111111111', version = `roi-month-v5:${'a'.repeat(64)}`;
  const model = { captured_at:'2026-10-12T00:00:00Z',timezone:'Europe/Stockholm',capabilities:{},device_models:[],services:[],grid:{},comfort:{},policy:{},criteria:{},roi_solar_profile:null,roi_pool_seed:null };
  const state = (poolC: number) => ({ poolC, heaterState: { kind: 'off', seconds: 900 } });
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.role',true),'') $$;
      CREATE FUNCTION can_access_energy_billing_customer(id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT id=NULLIF(current_setting('test.uid',true),'')::uuid $$;
      CREATE TABLE customers(id uuid PRIMARY KEY); CREATE TABLE homes(id uuid PRIMARY KEY,customer_id uuid);
      CREATE FUNCTION energy_home_matches_customer(home uuid,customer uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM homes WHERE id=home AND customer_id=customer) $$;
      INSERT INTO customers VALUES('${id}'); INSERT INTO homes VALUES('${id}','${id}');`);
    for (const migration of ['20261011175100_roi_saved_reports.sql','20261012110000_roi_solar_history.sql','20261012140000_roi_pool_continuity.sql']) await db.exec(await Deno.readTextFile(`supabase/migrations/${migration}`));
    await db.exec(`SET test.role='authenticated'; SET test.uid='${id}'; SET ROLE authenticated;`);
    await assertRejects(() => db.query('SELECT publish_energy_roi_pool_seed($1,$1,$2,30)',[id,'2025-10']), Error, 'permission denied');
    await db.exec("RESET ROLE; SET test.role='service_role'; SET ROLE service_role;");
    const seed = (await db.query<{seed:{month:string;temperatureC:number;hash:string}}>('SELECT publish_energy_roi_pool_seed($1,$1,$2,30) AS seed',[id,'2025-10'])).rows[0].seed;
    await db.exec(`RESET ROLE; SET test.role='authenticated'; SET ROLE authenticated;`);
    const pinned = (await db.query<{report:{generation:number;checkpoints:object}}>('SELECT pin_energy_roi_report($1,$1,$2,$3::jsonb,NULL) AS report',[id,version,{...model,roi_pool_seed:seed}])).rows[0].report;
    const save = async (month: string, start: string, end: string, parentHash: string, initial: object, hash: string, expected: string|null = null) => (await db.query<{report:{months:object;checkpoints:Record<string,{final:object;inputHash:string}>}}>(
      'SELECT save_energy_roi_month($1,$1,$2,$3,$4::jsonb,$5,$6) AS report',[id,pinned.generation,version,{month,start,end,coverage:1,baseline:{},recorded:{},scheduler:{},modeled:{},replay:{},quality:{},gaps:{},solar:{profileHash:null},pool:{parentHash,initial,final:{baseline:state(30.5),scheduler:state(30)}}},hash,expected])).rows[0].report;
    let initial = { baseline: {poolC:30,heaterState:{kind:'off_unobserved'}},scheduler:{poolC:30,heaterState:{kind:'off_unobserved'}} }, parentHash = seed.hash;
    let result: Awaited<ReturnType<typeof save>>;
    for (let index = 0; index < 13; index++) {
      const at = new Date(Date.UTC(2025,9+index,15));
      const month = at.toISOString().slice(0,7), hash = index.toString(16).padStart(64,'0');
      const bounds = homeMonthBounds(at.toISOString(),0,'Europe/Stockholm');
      result = await save(month,new Date(bounds.startMs).toISOString(),new Date(bounds.endMs).toISOString(),parentHash,initial,hash);
      initial = result.checkpoints[month].final as typeof initial; parentHash = hash;
    }
    assertEquals(Object.keys(result!.months).length,12); assertEquals(Object.keys(result!.checkpoints).length,13);
    assertEquals('2025-10' in result!.checkpoints,true);
    await assertRejects(() => save('2026-11','2026-10-31T23:00:00.000Z','2026-11-30T23:00:00.000Z','f'.repeat(64),initial,'e'.repeat(64)), Error, 'predecessor changed');
    // The first summary was evicted; its checkpoint still guards children.
    const changed = await save('2025-10','2025-09-30T22:00:00.000Z','2025-10-31T23:00:00.000Z',seed.hash,{baseline:{poolC:30,heaterState:{kind:'off_unobserved'}},scheduler:{poolC:30,heaterState:{kind:'off_unobserved'}}},'f'.repeat(64));
    assertEquals(Object.keys(changed.checkpoints),['2025-10']);
    assertEquals(Object.keys(changed.months),['2025-10']);
    await assertRejects(() => db.query('SELECT pin_energy_roi_report($1,$1,$2,$3::jsonb,NULL)',[id,`roi-month-v4:${'a'.repeat(64)}`,model]), Error, 'Invalid compact');
  } finally { await db.close(); }
});
