/** Independently generated synthetic forecasts; no household captures. */
import { assertEquals, assertRejects } from '@std/assert';
import { priceExperimentDb } from './helpers/price-experiment-db.ts';
const HOME='11111111-1111-4111-8111-111111111111', BASE='21111111-1111-4111-8111-111111111111';
const START=Math.ceil(Date.now()/3_600_000)*3_600_000+5*86_400_000;
const iso=(at: number)=>new Date(at).toISOString();
async function setup() {
  const db=await priceExperimentDb(HOME);
  await db.exec(await Deno.readTextFile('supabase/migrations/20261026100000_test_price_residual_correction.sql'));
  return db;
}
type DB=Awaited<ReturnType<typeof setup>>;
async function baseline(db: DB, id=BASE) {
  await db.query(`INSERT INTO energy_price_forecast_generations(id,home_id,generated_at,inputs,outlook) VALUES($1,$2,clock_timestamp(),$3,$4)`,[id,HOME,
    {slot_starts:[iso(START),iso(START+900_000)],published_import_sek_per_kwh:[null,null]},
    {shadowImportSekPerKwh:[2,3]}]);
}
async function enable(db: DB) { await db.query('SELECT private.enable_test_price_experiment($1)',[HOME]);await db.exec('SELECT private.enable_test_price_correction()'); }
interface Run {id: string;status: string;context:{truthCutoff:number;training:unknown[];baseline:{id:string}}}
async function begin(db: DB) {return (await db.query<{r:Run|null}>('SELECT begin_test_price_correction() r')).rows[0].r;}
const forecast=(corrected: boolean)=>({algorithm:'se3-price-residual-v1',status:corrected?'paired':'unavailable',reason:corrected?null:'Collecting prospective residual outcomes.',fit:corrected?{training:{quarters:1}}:null,
  targets:[2,3].map((baseline,index)=>({start:iso(START+index*900_000),baseline,features:Array(13).fill(1),corrected:corrected?baseline-.5:null,reason:corrected?null:'Collecting prospective residual outcomes.'}))});
async function complete(db: DB,id: string,value=forecast(false)) {return db.query('SELECT complete_test_price_correction($1,$2)',[id,value]);}
async function price(db: DB,at: number,value: number) {await db.query('INSERT INTO energy_optimisation_price_slots(home_id,start_ts,import_price_sek_per_kwh) VALUES($1,$2,$3) ON CONFLICT(home_id,start_ts) DO UPDATE SET import_price_sek_per_kwh=excluded.import_price_sek_per_kwh',[HOME,iso(at),value]);}

Deno.test('correction schema is dormant and service RPC-only; reservations freeze actual household prices and permit missing sources',async()=>{
 const db=await setup();try{
  await baseline(db);assertEquals(await begin(db),null);await enable(db);
  const r=(await begin(db))!;assertEquals(r.context.baseline.id,BASE);assertEquals(r.context.training,[]);
  assertEquals(await begin(db),r);await complete(db,r.id);await complete(db,r.id);
  assertEquals((await begin(db))!.status,'unavailable');
  assertEquals((await db.query('SELECT training_eligible,eligible FROM energy_test_price_correction_targets ORDER BY start_ts')).rows,[{training_eligible:true,eligible:false},{training_eligible:true,eligible:false}]);
  await assertRejects(()=>complete(db,r.id,forecast(true)),Error,'Conflicting completed');
  await assertRejects(()=>db.exec('UPDATE energy_test_price_correction_targets SET baseline=99'),Error,'immutable');
  assertEquals((await db.query("SELECT has_table_privilege('service_role','energy_test_price_corrections','INSERT') writable,has_function_privilege('anon','begin_test_price_correction()','EXECUTE') executable")).rows,[{writable:false,executable:false}]);
 }finally{await db.close();}
});
Deno.test('first unavailable correction seeds later fits from newly published future prices, with immutable truth cutoffs',async()=>{
 const db=await setup();try{
  await enable(db);await baseline(db);const first=(await begin(db))!;await complete(db,first.id);
  await price(db,START,1.5);await baseline(db,'31111111-1111-4111-8111-111111111111');
  const next=(await begin(db))!;assertEquals(next.context.training.length,1);
  const frozen=structuredClone(next);await price(db,START,9);assertEquals(await begin(db),frozen);
  await complete(db,next.id,forecast(true));
  assertEquals((await db.query('SELECT eligible,eligibility_reason FROM energy_test_price_correction_targets WHERE run_id=$1 ORDER BY start_ts',[next.id])).rows,[{eligible:false,eligibility_reason:'already_known'},{eligible:true,eligibility_reason:'eligible'}]);
  await price(db,START+900_000,2);let scores=(await db.query<{full_mae:number}>('SELECT full_mae::float8 FROM energy_test_price_correction_scores')).rows;
  assertEquals(scores[0].full_mae,.5);await price(db,START+900_000,2.5);scores=(await db.query<{full_mae:number}>('SELECT full_mae::float8 FROM energy_test_price_correction_scores')).rows;assertEquals(scores[0].full_mae,0);
  assertEquals((await db.query('SELECT * FROM energy_test_price_pair_scores')).rows,[]);
  await assertRejects(()=>db.exec('SELECT get_test_price_correction_comparison()'),Error,'staff-only');
  await db.exec("SET request.jwt.claim.sub='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
  const projection=(await db.query<{r:{targets:unknown[];selected:Record<string,unknown>}}>('SELECT get_test_price_correction_comparison() r')).rows[0].r;
  assertEquals(projection.targets.length,1);assertEquals('context' in projection.selected,false);assertEquals('forecast' in projection.selected,false);
 }finally{await db.close();}
});
Deno.test('price arrival during correction fitting excludes both training and scoring; baseline and grid are immutable',async()=>{
 const db=await setup();try{
  await enable(db);await baseline(db);const r=(await begin(db))!;
  const changed=forecast(true);changed.targets[0].baseline=4;await assertRejects(()=>complete(db,r.id,changed),Error,'baseline');
  const duplicate=forecast(true);duplicate.targets[1].start=duplicate.targets[0].start;await assertRejects(()=>complete(db,r.id,duplicate),Error,'grid');
  const badFeatures=forecast(true);badFeatures.targets[0].features=[1];await assertRejects(()=>complete(db,r.id,badFeatures),Error,'features');
  await price(db,START,1.5);await complete(db,r.id,forecast(true));
  assertEquals((await db.query('SELECT training_eligible,eligible FROM energy_test_price_correction_targets WHERE run_id=$1 ORDER BY start_ts',[r.id])).rows,[{training_eligible:false,eligible:false},{training_eligible:true,eligible:true}]);
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ');await assertRejects(()=>begin(db),Error,'READ COMMITTED');await db.exec('ROLLBACK');
 }finally{await db.close();}
});
