import {PGlite} from '@electric-sql/pglite';
import {assert, assertEquals, assertRejects} from '@std/assert';
import {calculateAccuracy, type AccuracyEvidence} from '../supabase/functions/_shared/forecast-accuracy.ts';
import {calculateReferenceAccuracy, selectReferenceEvidence, type ForecastRecord, type AccuracySlot} from './helpers/forecast-accuracy-reference.ts';

// Independently generated synthetic reporting history, never household recordings.
const HOME='11111111-1111-4111-8111-111111111111', OTHER='22222222-2222-4222-8222-222222222222';
const UNTIL='2026-10-25T06:00:00Z';
const migration='supabase/migrations/20261101190000_compact_forecast_accuracy_evidence.sql';
async function database() {
  const db=new PGlite();
  await db.exec(`CREATE SCHEMA private; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION private.queue_energy_accuracy(uuid[]) RETURNS void LANGUAGE sql AS $$SELECT$$;
    CREATE TABLE energy_forecast_records(home_id uuid,plan_id uuid,published_at timestamptz,horizon_end timestamptz,forecast jsonb);
    CREATE TABLE energy_optimisation_actual_slots(home_id uuid,start_ts timestamptz,total_load_kwh numeric,solar_production_kwh numeric,
      battery_charge_kwh numeric,battery_discharge_kwh numeric,battery_soc numeric);
    CREATE TABLE energy_optimisation_devices(id uuid,home_id uuid,device_key text);
    CREATE TABLE energy_optimisation_device_slots(home_id uuid,start_ts timestamptz,device_id uuid,energy_kwh numeric);
    CREATE TABLE energy_optimisation_price_slots(home_id uuid,start_ts timestamptz,import_price_sek_per_kwh numeric);
    CREATE TABLE energy_optimisation_thermal_slots(home_id uuid,start_ts timestamptz,room_key text,room_temperature_c numeric);
    CREATE TABLE energy_forecast_accuracy_reports(home_id uuid,scheduled_at timestamptz,report jsonb,diagnostics jsonb);
    CREATE TABLE energy_optimisation_current(home_id uuid,plan_id uuid);`);
  await db.exec(await Deno.readTextFile(migration));
  return db;
}
const slot=(start:string):AccuracySlot=>({start,duration_hours:.25,load_w:1600,pv_w:200,device_loads_w:{heater:400},
  battery_charge_w:600,battery_discharge_w:200,battery_soc:.6,room_temperature_c:{room:21}});
function record(id:number,at:string,slots:AccuracySlot[]):ForecastRecord {
  return {plan_id:`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`,published_at:at,
    forecast:{timezone:'Europe/Stockholm',battery:true,model_version:`synthetic-${id%2}`,
      devices:[{key:'heater',name:'Synthetic heater'}],rooms:[{key:'room',name:'Synthetic room'}],slots}};
}
async function insert(db:PGlite,records:ForecastRecord[],home=HOME) {
  await db.query(`INSERT INTO energy_forecast_records SELECT $1,r.plan_id::uuid,r.published_at::timestamptz,
    '2026-10-28'::timestamptz,r.forecast FROM jsonb_to_recordset($2) r(plan_id text,published_at text,forecast jsonb)`,[home,JSON.stringify(records)]);
}
async function evidence(db:PGlite) {
  return (await db.query<{e:AccuracyEvidence}>('SELECT read_energy_accuracy_evidence($1,$2) e',[HOME,UNTIL])).rows[0].e;
}
function metadata() {return {scheduled_at:UNTIL,calculated_at:UNTIL,timezone:'Europe/Stockholm'};}
async function parity(db:PGlite) {
  const selected=await evidence(db);
  const forecasts=(await db.query<ForecastRecord>(`SELECT plan_id::text,published_at::text,forecast FROM energy_forecast_records
    WHERE home_id=$1 AND published_at<=$2 AND horizon_end>=$2::timestamptz-interval '7 days'
    ORDER BY published_at,plan_id`,[HOME,UNTIL])).rows;
  const input={...selected,...metadata(),forecasts};
  const reference=calculateReferenceAccuracy(input), result=calculateAccuracy(input);
  const chosen=selectReferenceEvidence(input);
  assertEquals(selected.energy,chosen.energy);
  assertEquals(selected.rooms,chosen.rooms);
  assertEquals(new Map(selected.estimates.map(e=>[e.at,e])),new Map(chosen.estimates.map(e=>[e.at,e])));
  assertEquals(selected.catalog,chosen.catalog);
  assertEquals(result.report.historical.percentage,reference.report.historical.percentage);
  assertEquals(result.report.historical.grade,reference.report.historical.grade);
  assertEquals(result.report.historical.devices.map(({key,name,percentage,grade})=>({key,name,percentage,grade})),reference.report.historical.devices);
  assertEquals(result.report.prices,reference.report.prices);
  assertEquals(result.report.room_temperature,reference.report.room_temperature);
  // The old SOC diagnostic compared an endpoint with an interval mean; its removal
  // is intentional. All energy/price/room sums and plan identities stay identical.
  const {soc_comparison,...batteryNew}=result.diagnostics.find(d=>d.key==='battery')! as typeof result.diagnostics[number] & {soc_comparison:unknown};
  assertEquals(soc_comparison,{state:'unavailable',reason:'endpoint_vs_interval_mean'});
  const {soc_percentage_points: _oldSoc,...batteryOld}=reference.diagnostics.find(d=>d.key==='battery')! as typeof reference.diagnostics[number] & {soc_percentage_points:unknown};
  assertEquals(batteryNew,batteryOld);
  assertEquals(result.diagnostics.filter(d=>d.key!=='battery'),reference.diagnostics.filter(d=>d.key!=='battery'));
  return {selected,result};
}

Deno.test('compact evidence preserves publication ties, omissions, future prices, gaps and roster changes',async()=>{
  const db=await database();
  try {
    const start='2026-10-25T01:00:00Z', next='2026-10-25T01:15:00Z',future='2026-10-26T12:00:00Z';
    const early=record(1,'2026-10-24T22:00:00Z',[slot(next),slot(start),{...slot(future),duration_hours:.5,estimated_import_sek_per_kwh:1}]);
    const tiedLaterClock=record(2,'2026-10-25T01:00:00.000900Z',[{...slot(start),load_w:5000}]);
    const tiedLargerId=record(3,'2026-10-25T01:00:00.000100Z',[{...slot(start),load_w:null,room_temperature_c:{}},
      {...slot(start),load_w:1700,room_temperature_c:{other:22,'2':21,'10':22,'01':20}}, // last duplicate wins energy; room survives independently
      {...slot(next),load_w:null,room_temperature_c:{room:'missing' as unknown as number}},
      {...slot(future),duration_hours:.5,estimated_import_sek_per_kwh:2}]);
    tiedLargerId.forecast.rooms!.push({key:'other',name:'Other synthetic room'});
    const latest=record(4,'2026-10-25T05:00:00Z',[]);
    latest.forecast.devices=[{key:'heater',name:'Renamed synthetic heater'},{key:'unused',name:'Uncompared synthetic load'}];
    latest.forecast.rooms!.push({key:'empty',name:'Uncompared synthetic room'});
    await insert(db,[early,tiedLaterClock,tiedLargerId,latest]);
    await insert(db,[record(9,'2026-10-24T22:00:00Z',[slot(start)])],OTHER);
    await db.query('INSERT INTO energy_optimisation_devices VALUES($1,$1,\'heater\')',[HOME]);
    for (const at of [start,next]) {
      await db.query('INSERT INTO energy_optimisation_actual_slots VALUES($1,$2,.5,.05,.15,.05,.55)',[HOME,at]);
      await db.query('INSERT INTO energy_optimisation_device_slots VALUES($1,$2,$1,.1)',[HOME,at]);
    }
    await db.query('INSERT INTO energy_optimisation_price_slots VALUES($1,$2,2.5)',[HOME,future]);
    for (const [at,key,c] of [[next,'room',21],[next,'other',22],[next,'2',21],[next,'10',22],[next,'01',20],['2026-10-25T01:30Z','room',21]])
      await db.query('INSERT INTO energy_optimisation_thermal_slots VALUES($1,$2,$3,$4)',[HOME,at,key,c]);
    const {result}=await parity(db);
    assertEquals(result.report.historical.devices.find(d=>d.key==='baseline')!.gaps,1);
    assertEquals(result.report.prices.percentage,80);
    assertEquals(result.report.historical.devices.find(d=>d.key==='baseline')!.quarters,1);
    await db.exec('SET ROLE authenticated');
    await assertRejects(()=>db.query('SELECT read_energy_accuracy_evidence($1,$2)',[HOME,UNTIL]),Error,'permission denied');
  } finally {await db.close();}
});

Deno.test('compact evidence has bounded output with many synthetic replans and exact DST day metrics',async()=>{
  const db=await database();
  try {
    const count=120, length=288, origin=Date.parse('2026-10-23T00:00:00Z');
    const records=Array.from({length:count},(_,i)=>record(i+1,new Date(origin+i*900000+1).toISOString(),
      Array.from({length},(_,n)=>slot(new Date(origin+(i+n)*900000).toISOString()))));
    await insert(db,records);
    await db.query("INSERT INTO energy_optimisation_devices VALUES($1,$1,'heater')",[HOME]);
    await db.query(`INSERT INTO energy_optimisation_actual_slots SELECT $1,t,.4,.05,.15,.05,.6
      FROM generate_series($2::timestamptz,$3::timestamptz-interval '15 minutes',interval '15 minutes') t`,[HOME,new Date(origin).toISOString(),UNTIL]);
    await db.query(`INSERT INTO energy_optimisation_device_slots SELECT $1,start_ts,$1,.1
      FROM energy_optimisation_actual_slots WHERE home_id=$1`,[HOME]);
    const selected=await evidence(db),referenceBytes=JSON.stringify(records).length,selectedBytes=JSON.stringify(selected).length;
    assert(selected.energy.length<=672);
    assert(selectedBytes<referenceBytes/20,`${selectedBytes} evidence bytes versus ${referenceBytes} archive bytes`);
    const {result}=await parity(db);
    assertEquals(result.report.historical.devices.find(d=>d.key==='baseline')!.daily.map(d=>[d.key,d.quarters]),
      [['2026-10-23',87],['2026-10-24',96],['2026-10-25',32]]);
    console.info('[SYNTHETIC ACCURACY]',JSON.stringify({forecast_slots:count*length,selected_slots:selected.energy.length,archive_bytes:referenceBytes,evidence_bytes:selectedBytes}));
  } finally {await db.close();}
});

Deno.test('empty history and old report versions stay reporting-only absences',async()=>{
  const db=await database();
  try {
    const selected=await evidence(db);
    assertEquals(calculateAccuracy({...selected,...metadata()}).report.historical.percentage,null);
    await db.query(`INSERT INTO energy_forecast_accuracy_reports VALUES($1,$2,'{"version":2}','[]')`,[HOME,UNTIL]);
    assertEquals((await db.query<{r:unknown}>('SELECT get_energy_forecast_accuracy($1) r',[HOME])).rows[0].r,null);
  } finally {await db.close();}
});
