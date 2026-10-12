import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import { assertEquals, assertRejects } from '@std/assert';

Deno.test('solar publication is scoped, complete, idempotent and rejects stale profiles and v3 writers', async () => {
  const db = new PGlite();
  const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const hash = 'a'.repeat(64), next = 'b'.repeat(64), version = `roi-month-v4:${hash}`;
  const model = { captured_at:'2026-10-12T00:00:00Z',timezone:'Europe/Stockholm',capabilities:{},device_models:[],services:[],grid:{},comfort:{},policy:{},criteria:{},roi_solar_profile:null as string|null };
  const hours = [{ start_ts:'2026-04-30T20:00:00Z',raw_kwh:1,modeled_kwh:.9 },{ start_ts:'2026-04-30T21:00:00Z',raw_kwh:0,modeled_kwh:0 }];
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.role',true),'') $$;
      CREATE FUNCTION can_access_energy_billing_customer(id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT id=NULLIF(current_setting('test.uid',true),'')::uuid $$;
      CREATE TABLE customers(id uuid PRIMARY KEY); CREATE TABLE homes(id uuid PRIMARY KEY,customer_id uuid);
      CREATE FUNCTION energy_home_matches_customer(home uuid,customer uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM homes WHERE id=home AND customer_id=customer) $$;
      INSERT INTO customers VALUES('${id}'),('${other}'); INSERT INTO homes VALUES('${id}','${id}'),('${other}','${other}');`);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261011175100_roi_saved_reports.sql'));
    const legacyLedger = { baseline:{costSek:100},recorded:{costSek:101},scheduler:{costSek:90},modeled:{baselineBill:{totalSek:100},schedulerBill:{totalSek:90},effects:[{value:123}],timing:{value:456}} };
    const legacyEntry = { ledger:legacyLedger,inputHash:hash,computedAt:'2026-10-11T00:00:00.000Z' };
    await db.query('INSERT INTO energy_roi_reports(home_id,customer_id,version,model,months) VALUES($1,$1,$2,$3::jsonb,$4::jsonb)',
      [id,'roi-month-v3:f7abb0ec0cc2ec52ffaf037f3a25746a196a0b482841fc4014a59061b30087ec',model,{'2026-09':legacyEntry}]);
    await db.exec(await Deno.readTextFile('supabase/migrations/20261012110000_roi_solar_history.sql'));
    const upgraded = (await db.query<{version:string;months:Record<string,typeof legacyEntry>}>('SELECT version,months FROM energy_roi_reports')).rows[0];
    assertEquals(upgraded.version.startsWith('roi-month-v4:'),true);
    assertEquals(upgraded.months['2026-09'].computedAt,legacyEntry.computedAt);
    const upgradedLedger = upgraded.months['2026-09'].ledger;
    assertEquals(upgradedLedger.baseline,legacyLedger.baseline);assertEquals(upgradedLedger.scheduler,legacyLedger.scheduler);
    assertEquals(upgradedLedger.recorded,legacyLedger.recorded);assertEquals(upgradedLedger.modeled.baselineBill,legacyLedger.modeled.baselineBill);
    assertEquals(Object.hasOwn(upgradedLedger.modeled,'effects'),false);assertEquals(Object.hasOwn(upgradedLedger.modeled,'timing'),false);

    const pin = (solar: string|null = null, v = version) => db.query('SELECT pin_energy_roi_report($1,$1,$2,$3::jsonb,NULL)',[id,v,{...model,roi_solar_profile:solar}]);
    const publish = (h = hash, input = hours, home = id, customer = id) => db.query('SELECT publish_energy_roi_solar_profile($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',[home,customer,h,hours[0].start_ts,'2026-04-30T22:00:00Z',{provider:'open_meteo_historical_forecast'},input]);
    await db.exec(`SET test.role='authenticated'; SET test.uid='${id}'; SET ROLE authenticated;`);
    await assertRejects(() => pin(null,`roi-month-v3:${hash}`),Error,'Invalid compact');
    await assertRejects(() => publish(),Error,'permission denied');
    await pin();
    await assertRejects(() => db.query('INSERT INTO energy_roi_installations VALUES($1,$1,\'solar\',\'2026-05\',\'owner_stated\')',[id]),Error,'permission denied');
    await db.exec("RESET ROLE; SET test.role='service_role'; SET ROLE service_role;");
    await assertRejects(() => publish(hash,hours,id,other),Error,'access denied');
    await assertRejects(() => publish(hash,hours.slice(1)),Error,'every hour');
    await publish();
    const report = async () => (await db.query<{generation:number;model:typeof model;months:object}>('SELECT generation,model,months FROM energy_roi_reports WHERE home_id=$1',[id])).rows[0];
    const first = await report(); assertEquals(first.generation,4);assertEquals(first.model.roi_solar_profile,hash);assertEquals(first.months,{});
    await publish();assertEquals((await report()).generation,4);
    await assertRejects(() => publish(next,[hours[0],hours[0]]),Error,'duplicate key');
    assertEquals((await report()).model.roi_solar_profile,hash); // Failed replacement is atomic.
    await db.exec(`RESET ROLE; SET test.role='authenticated'; SET test.uid='${other}'; SET ROLE authenticated;`);
    assertEquals((await db.query('SELECT * FROM energy_roi_solar_profiles')).rows,[]);
    assertEquals((await db.query('SELECT * FROM energy_roi_solar_hours')).rows,[]);
    await db.exec(`RESET ROLE; SET test.uid='${id}'; SET ROLE authenticated;`);
    await assertRejects(() => pin(),Error,'profile changed');
    await pin(hash);
    const ledger = {month:'2026-04',start:'2026-04-01T00:00:00Z',end:'2026-05-01T00:00:00Z',coverage:1,baseline:{},recorded:{},scheduler:{},modeled:{},replay:{},quality:{},gaps:{},solar:{profileHash:hash}};
    const save = (generation=4,v=version,solar=hash) => db.query('SELECT save_energy_roi_month($1,$1,$2,$3,$4::jsonb,$5,NULL)',[id,generation,v,{...ledger,solar:{profileHash:solar}},hash]);
    await assertRejects(() => save(1),Error,'model changed');
    await assertRejects(() => save(4,`roi-month-v3:${hash}`),Error,'updated');
    await assertRejects(() => save(4,version,next),Error,'profile changed');
    await save();
    const september = {...ledger,month:'2026-09',start:'2026-09-01T00:00:00Z',end:'2026-10-01T00:00:00Z'};
    await db.query('SELECT save_energy_roi_month($1,$1,4,$2,$3::jsonb,$4,NULL)',[id,version,september,hash]);
    const preservedBefore = (await db.query<{months:Record<string,{ledger:typeof september;inputHash:string}>}>('SELECT months FROM energy_roi_reports')).rows[0].months['2026-09'];

    await db.exec("RESET ROLE; SET test.role='service_role'; SET ROLE service_role;");await publish(next);
    await db.exec(`RESET ROLE; SET test.role='authenticated'; SET test.uid='${id}'; SET ROLE authenticated;`);
    await assertRejects(() => save(),Error,'model changed');
    assertEquals((await report()).generation,5);
    const preserved = (await db.query<{months:Record<string,{ledger:typeof september;inputHash:string}>}>('SELECT months FROM energy_roi_reports')).rows[0].months;
    assertEquals(Object.keys(preserved),['2026-09']);
    assertEquals(preserved['2026-09'].ledger,{...preservedBefore.ledger,solar:{profileHash:next}});
    assertEquals(preserved['2026-09'].inputHash===preservedBefore.inputHash,false);
  } finally { await db.close(); }
});
