/** Independently generated synthetic evidence. No household forecasts or measured prices. */
import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { priceCorrectionDb, priceExperimentDb } from './helpers/price-experiment-db.ts';

const HOME='11111111-1111-4111-8111-111111111111';
const BASE='21111111-1111-4111-8111-111111111111';
const NEXT_BASE='31111111-1111-4111-8111-111111111111';
const V1='se3-price-residual-v1', V2='se3-price-residual-v2';
const START=Math.ceil(Date.now()/3_600_000)*3_600_000+5*86_400_000;
const iso=(at:number)=>new Date(at).toISOString();
type DB=Awaited<ReturnType<typeof priceCorrectionDb>>;
interface Sample {runId:string;start:string;baseline:number;features:number[];actual:number;truthSequence:number}
interface Reservation {id:string;algorithm:string;status:string;context:{truthCutoff:number;training:Sample[];baseline:{id:string}}}
interface Summary {id:string;algorithm:string;status:string}
interface Report {algorithm:string;pair_count:number;pairs:Summary[];scores:{algorithm:string;full_mae:number}[]}
interface Comparison {algorithm:string;selected:Summary|null;report:Report;targets:unknown[]}
async function baseline(db:DB,id=BASE) {
  await db.query('INSERT INTO energy_price_forecast_generations(id,home_id,generated_at,inputs,outlook) VALUES($1,$2,clock_timestamp(),$3,$4)',
    [id,HOME,{slot_starts:[iso(START),iso(START+900_000)],published_import_sek_per_kwh:[null,null]},
      {shadowImportSekPerKwh:[2,3]}]);
}
async function enable(db:DB) {
  await db.query('SELECT private.enable_test_price_experiment($1)',[HOME]);
  await db.exec('SELECT private.enable_test_price_correction()');
}
async function begin(db:DB,algorithm=V1) {
  return (await db.query<{value:Reservation|null}>('SELECT begin_test_price_correction($1) value',[algorithm])).rows[0].value;
}
async function defaultBegin(db:DB) {
  return (await db.query<{value:Reservation|null}>('SELECT begin_test_price_correction() value')).rows[0].value;
}
function forecast(algorithm:string,corrected:number[]|null=null,featureValue=1) {
  return {algorithm,status:corrected?'paired':'unavailable',reason:corrected?null:'Collecting prospective residual outcomes.',
    fit:corrected?{training:{quarters:1}}:null,
    targets:[2,3].map((value,index)=>({start:iso(START+index*900_000),baseline:value,features:Array(13).fill(featureValue),
      corrected:corrected?.[index]??null,reason:corrected?null:'Collecting prospective residual outcomes.'}))};
}
async function complete(db:DB,id:string,value:ReturnType<typeof forecast>) {
  return db.query('SELECT complete_test_price_correction($1,$2)',[id,value]);
}
async function price(db:DB,at:number,value:number) {
  await db.query('INSERT INTO energy_optimisation_price_slots(home_id,start_ts,import_price_sek_per_kwh) VALUES($1,$2,$3) ON CONFLICT(home_id,start_ts) DO UPDATE SET import_price_sek_per_kwh=excluded.import_price_sek_per_kwh',[HOME,iso(at),value]);
}
async function report(db:DB,algorithm=V1) {
  return (await db.query<{value:Report}>('SELECT read_test_price_correction_report($1) value',[algorithm])).rows[0].value;
}
async function comparison(db:DB,algorithm:string,id:string|null=null) {
  return (await db.query<{value:Comparison}>('SELECT get_test_price_correction_comparison($1,$2) value',[id,algorithm])).rows[0].value;
}

Deno.test('forward v2 migration retains completed and pending v1 evidence and creates no retrospective v2 forecasts',async()=>{
  const db=await priceExperimentDb(HOME);
  try {
    await db.exec(await Deno.readTextFile('supabase/migrations/20261026100000_test_price_residual_correction.sql'));
    await enable(db);await baseline(db);
    const first=(await defaultBegin(db))!;await complete(db,first.id,forecast(V1,[1.5,2.5]));
    await price(db,START,1);await baseline(db,NEXT_BASE);
    const pending=(await defaultBegin(db))!;
    const evidence=()=>db.query(`SELECT jsonb_build_object(
      'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM energy_test_price_corrections r),
      'targets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM energy_test_price_correction_targets t),
      'scores',(SELECT jsonb_agg(to_jsonb(s) ORDER BY lead_day) FROM energy_test_price_correction_scores s),
      'cron',(SELECT jsonb_agg(to_jsonb(j) ORDER BY name) FROM cron.jobs j)) saved`);
    const before=await evidence();
    await db.exec(await Deno.readTextFile('supabase/migrations/20261101110000_test_price_residual_v2.sql'));
    assertEquals(await evidence(),before);
    assertEquals(await defaultBegin(db),{...pending,algorithm:V1});
    assertEquals((await report(db,V1)).pair_count,2);assertEquals((await report(db,V2)).pair_count,0);
    await complete(db,pending.id,forecast(V1,[1.5,2.5]));
    const completed=(await begin(db,V1))!;
    assertEquals(completed.status,'paired');assertEquals(completed.algorithm,V1);
  } finally {await db.close();}
});

Deno.test('versioned correction migration is dormant, has unambiguous signatures and protects both versions',async()=>{
  const db=await priceCorrectionDb(HOME);
  try {
    await baseline(db);
    assertEquals(await defaultBegin(db),null);assertEquals(await begin(db,V2),null);
    assertEquals((await db.query('SELECT * FROM cron.jobs')).rows,[]);
    assertEquals((await db.query(`SELECT count(*)::integer functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('begin_test_price_correction','read_test_price_correction_report','get_test_price_correction_comparison')`)).rows,[{functions:3}]);
    assertEquals((await db.query(`SELECT has_function_privilege('anon','begin_test_price_correction(text)','EXECUTE') anonymous,
      has_function_privilege('service_role','begin_test_price_correction(text)','EXECUTE') worker,
      has_function_privilege('authenticated','get_test_price_correction_comparison(uuid,text)','EXECUTE') staff,
      has_table_privilege('authenticated','energy_test_price_correction_v2_scores','SELECT') raw_read,
      has_table_privilege('service_role','energy_test_price_corrections','INSERT') raw_write`)).rows,
    [{anonymous:false,worker:true,staff:true,raw_read:false,raw_write:false}]);
    for (const algorithm of ['se3-price-residual-v3','',null]) {
      await assertRejects(()=>db.query('SELECT begin_test_price_correction($1)',[algorithm]),Error,'Unknown TEST correction algorithm');
      await assertRejects(()=>db.query('SELECT read_test_price_correction_report($1)',[algorithm]),Error,'Unknown TEST correction algorithm');
    }
    await assertRejects(()=>comparison(db,V2),Error,'staff-only');
    await db.exec("SET request.jwt.claim.sub='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
    await assertRejects(()=>comparison(db,'other'),Error,'Unknown TEST correction algorithm');
    assertEquals((await comparison(db,V2)).algorithm,V2);
    assertEquals((await report(db,V2)).pair_count,0);
  } finally {await db.close();}
});

Deno.test('pending work, deduplication, retries and comparison selections stay separate by correction version',async()=>{
  const db=await priceCorrectionDb(HOME);
  try {
    await enable(db);await baseline(db);
    const v1=(await defaultBegin(db))!,v2=(await begin(db,V2))!;
    assertNotEquals(v1.id,v2.id);assertEquals(v1.algorithm,V1);assertEquals(v2.algorithm,V2);
    assertEquals(await begin(db,V1),v1);assertEquals(await begin(db,V2),v2);
    await baseline(db,NEXT_BASE);
    assertEquals(await begin(db,V1),v1);assertEquals(await begin(db,V2),v2);
    const v2Forecast=forecast(V2,[2,2.75]);
    await assertRejects(()=>complete(db,v1.id,v2Forecast),Error,'Invalid TEST correction forecast');
    await complete(db,v2.id,v2Forecast);await complete(db,v2.id,v2Forecast);
    await assertRejects(()=>complete(db,v2.id,forecast(V2,[99,99])),Error,'Conflicting completed');
    const v1Forecast=forecast(V1,[1.5,2.5]);await complete(db,v1.id,v1Forecast);
    assertEquals((await report(db,V1)).pairs.map(row=>[row.id,row.algorithm]),[[v1.id,V1]]);
    assertEquals((await report(db,V2)).pairs.map(row=>[row.id,row.algorithm]),[[v2.id,V2]]);
    await db.exec("SET request.jwt.claim.sub='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
    assertEquals((await comparison(db,V1)).selected!.id,v1.id);assertEquals((await comparison(db,V2)).selected!.id,v2.id);
    await assertRejects(()=>comparison(db,V1,v2.id),Error,'Unknown TEST correction');
    await assertRejects(()=>comparison(db,V2,v1.id),Error,'Unknown TEST correction');
    const defaultProjection=(await db.query<{value:Comparison}>('SELECT get_test_price_correction_comparison() value')).rows[0].value;
    assertEquals(defaultProjection.selected!.id,v1.id);assertEquals(defaultProjection.algorithm,V1);
    const nextV1=(await begin(db,V1))!,nextV2=(await begin(db,V2))!;
    assertEquals(nextV1.context.baseline.id,NEXT_BASE);assertEquals(nextV2.context.baseline.id,NEXT_BASE);assertNotEquals(nextV1.id,nextV2.id);
    await price(db,START,1);await price(db,START+900_000,2);
    assertEquals((await db.query('SELECT full_mae::float8 FROM energy_test_price_correction_scores')).rows,[{full_mae:.5}]);
    assertEquals((await db.query('SELECT full_mae::float8 FROM energy_test_price_correction_v2_scores')).rows,[{full_mae:.875}]);
    assertEquals((await report(db,V1)).scores.map(row=>row.algorithm),[V1]);assertEquals((await report(db,V2)).scores.map(row=>row.algorithm),[V2]);
    assertEquals((await db.query('SELECT forecast FROM energy_test_price_corrections WHERE id=$1',[v1.id])).rows,[{forecast:v1Forecast}]);
    await assertRejects(()=>db.exec('UPDATE energy_test_price_corrections SET algorithm=\'se3-price-residual-v2\' WHERE algorithm=\'se3-price-residual-v1\''),Error,'immutable');
  } finally {await db.close();}
});

Deno.test('v2 bootstraps from prospective v1 residual examples and its own later examples; v1 never learns v2 predictions',async()=>{
  const db=await priceCorrectionDb(HOME);
  try {
    await enable(db);await baseline(db);
    const v1=(await begin(db,V1))!;await complete(db,v1.id,forecast(V1,[9999,9999],1));
    await price(db,START,1.5);
    const v2=(await begin(db,V2))!;
    assertEquals(v2.context.training.length,1);
    assertEquals(v2.context.training[0].runId,v1.id);assertEquals(v2.context.training[0].baseline,2);
    assertEquals(v2.context.training[0].actual,1.5);assertEquals(v2.context.training[0].features,Array(13).fill(1));
    await complete(db,v2.id,forecast(V2,[-9999,-9999],7));
    assertEquals(await begin(db,V2),{...v2,status:'paired'});
    await price(db,START+900_000,2.5);await baseline(db,NEXT_BASE);
    const nextV1=(await begin(db,V1))!,nextV2=(await begin(db,V2))!;
    assertEquals(nextV1.context.training.map(row=>row.runId),[v1.id,v1.id]);
    assertEquals(nextV2.context.training.map(row=>row.runId),[v1.id,v2.id]);
    assertEquals(nextV2.context.training.map(row=>row.features[0]),[1,7]);
    assertEquals(nextV2.context.training.map(row=>row.actual-row.baseline),[-.5,-.5]);
    assertEquals(nextV2.context.training.every(row=>row.truthSequence<=nextV2.context.truthCutoff),true);
    const frozenV1=structuredClone(nextV1),frozenV2=structuredClone(nextV2);
    await price(db,START+900_000,100);
    assertEquals(await begin(db,V1),frozenV1);assertEquals(await begin(db,V2),frozenV2);
    assertEquals((await db.query('SELECT training_eligible,eligible FROM energy_test_price_correction_targets WHERE run_id=$1 ORDER BY start_ts',[v2.id])).rows,
      [{training_eligible:false,eligible:false},{training_eligible:true,eligible:true}]);
  } finally {await db.close();}
});
