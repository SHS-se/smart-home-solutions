import {PGlite} from 'npm:@electric-sql/pglite@0.3.14';
import {assertEquals, assertRejects} from '@std/assert';

Deno.test('accuracy schedule is local/DST aware, fenced, immutable and scoped to the authorized home', async () => {
  const db = new PGlite(), home='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA private; CREATE SCHEMA extensions; CREATE SCHEMA cron; CREATE SCHEMA net;
      CREATE FUNCTION extensions.gen_random_bytes(int) RETURNS bytea LANGUAGE sql AS $$SELECT decode(repeat('12',$1),'hex')$$;
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS int LANGUAGE sql AS $$SELECT 1$$;
      CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) RETURNS bigint LANGUAGE sql AS $$SELECT 1::bigint$$;
      CREATE TABLE homes(id uuid PRIMARY KEY); CREATE TABLE customers(id uuid PRIMARY KEY);
      CREATE FUNCTION energy_home_matches_customer(uuid,uuid) RETURNS bool LANGUAGE sql AS $$SELECT $1=$2$$;
      CREATE FUNCTION can_access_energy_billing_customer(uuid) RETURNS bool LANGUAGE sql AS $$SELECT $1=current_setting('test.customer')::uuid$$;
      CREATE TABLE energy_optimisation_current(home_id uuid,customer_id uuid,plan_id uuid,plan jsonb);
      INSERT INTO homes VALUES('${home}'),('${other}'); INSERT INTO customers SELECT id FROM homes;
      INSERT INTO energy_optimisation_current VALUES('${home}','${home}','${home}','{"timezone":"Europe/Stockholm"}');`);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261017103000_shared_forecast_accuracy.sql'));
    const due=async (time:string)=>(await db.query<{at:string}>("SELECT private.energy_accuracy_due($1,'Europe/Stockholm')::text at",[time])).rows[0].at;
    assertEquals(await due('2026-03-29T04:00:00Z'),'2026-03-29 04:00:00+00');
    assertEquals(await due('2026-10-25T05:00:00Z'),'2026-10-25 05:00:00+00');
    assertEquals(await due('2026-10-25T04:59:00Z'),'2026-10-24 16:00:00+00');
    assertEquals(await due('2026-10-25T17:00:00Z'),'2026-10-25 17:00:00+00');
    await db.exec(`INSERT INTO private.energy_accuracy_jobs(home_id,customer_id,scheduled_at,timezone)
      VALUES('${home}','${home}','2026-10-17T16:00:00Z','Europe/Stockholm');`);
    const claim=async ()=>(await db.query<{j:{fence:number}|null}>("SELECT claim_energy_accuracy_job($1,'2026-10-17T16:00:00Z') j",[home])).rows[0].j;
    const first=await claim(); assertEquals(first!.fence,1); assertEquals(await claim(),null);
    await db.exec("UPDATE private.energy_accuracy_jobs SET lease_until=now()-interval '1 second'");
    const second=await claim(); assertEquals(second!.fence,2);
    const complete=async(fence:number)=>(await db.query<{ok:boolean}>("SELECT complete_energy_accuracy_job($1,'2026-10-17T16:00:00Z',$2,$3,'[]') ok",[home,fence,{scheduled_at:'2026-10-17T16:00:00Z',version:1}])).rows[0].ok;
    assertEquals(await complete(1),false); assertEquals(await complete(2),true); assertEquals(await complete(2),false);
    await db.exec(`SET test.customer='${home}'; SET ROLE authenticated;`);
    assertEquals((await db.query<{r:unknown}>('SELECT get_energy_forecast_accuracy($1) r',[other])).rows[0].r,null);
    assertEquals((await db.query<{r:{version:number}}>('SELECT get_energy_forecast_accuracy($1) r',[home])).rows[0].r.version,1);
    await assertRejects(()=>db.exec('SELECT * FROM energy_forecast_records'),Error,'permission denied');
    await assertRejects(()=>db.exec('SELECT claim_energy_accuracy_job(null,null)'),Error,'permission denied');
  } finally {await db.close();}
});
