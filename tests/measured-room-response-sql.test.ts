// Independent synthetic models and runs: no household observations are used.
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import { chronologicalRoomDatabase } from "./helpers/chronological-room-sql.ts";
import { claim, handBack, home, other, release, revision } from "./helpers/room-fit-sql.ts";
import type { MeasuredRoomAssessment, MeasuredRoomCalibration } from "../supabase/functions/_shared/planner/models/room/measured-evidence.ts";

const migration = "supabase/migrations/20261123160000_measured_room_response.sql";
const stateMigration = "supabase/migrations/20261123170000_state_carrying_room_forecasts.sql";
const flagMigration = "supabase/migrations/20261124100000_separate_measured_run_flags.sql";
const policy = "measured_room_runs_v1", method = "native_mean_onset_peak_v1";
const archive = "chronological_native_evidence_v1", previousImplementation = `${archive}:${policy}:${method}`;
const implementation = `${previousImplementation}:state_carrying_forecast_v1`;
const binding = "synthetic-binding", from = "2001-01-01T00:00:00Z", to = "2001-01-02T00:00:00Z";
async function database() {
  const db = await chronologicalRoomDatabase();
  await db.exec(await Deno.readTextFile(migration));
  await db.exec(await Deno.readTextFile(stateMigration));
  await db.exec(await Deno.readTextFile(flagMigration));
  await db.exec("UPDATE private.energy_learning_jobs SET wake_after=now()");
  return db;
}
const run = (i: number): MeasuredRoomAssessment => ({
  id: `synthetic-${i}`, from_ms: i, on_ms: i, off_ms: i + 1, to_ms: i + 2, energy_kwh: .2,
  heating: { on_ms:i,peak_ms:i+1,peak_end_ms:i+2,energy_kwh:.2,hours:1,rise_c:.4,c_per_kwh:2,
    room_start_c:19,room_peak_c:19.4,room_mean_c:19.2,outdoor_c:i,house_c:null,native_seconds:[300,900] },
  cooling: null, reasons: [], reference_heating_c_per_kwh:2,reference_cooling_c_per_h:null,
  heating_residual:0,cooling_residual:null,heating_status:"consistent",cooling_status:null,
});
function summary(runs: MeasuredRoomAssessment[]): MeasuredRoomCalibration {
  return {policy,measurement_method:method,fitted_observations:100,residual_degrees_of_freedom:90,
    observed_runs:runs.length,heating_runs:runs.filter(r=>r.heating).length,cooling_runs:runs.filter(r=>r.cooling).length,
    heating_flagged_runs:runs.filter(r=>r.heating_status==="above_line" || r.heating_status==="below_line").length,
    cooling_flagged_runs:runs.filter(r=>r.cooling_status==="above_line" || r.cooling_status==="below_line").length,
    unmeasured_runs:runs.filter(r=>!r.heating && !r.cooling).length,reference:{room_c:20,house_c:20},
    lines:{heating:null,cooling:null,reference_heating:null,reference_cooling:null},
    validation:{training_to:null,observations:0,trajectory_mae_c:null,trajectory_bias_c:null}};
}
async function stage(db: PGlite, runs: MeasuredRoomAssessment[] = [], responseRevision = "synthetic-accepted") {
  let j = await claim(db); const rev = await revision(db);
  const w = (await db.query<{w:{source_revision:number;policy_fingerprint:string}}>(
    "SELECT get_energy_room_evidence_work($1,$1,'room',$2,$3,$4,$5) AS w",[home,binding,from,to,archive])).rows[0].w;
  await db.query(`INSERT INTO private.energy_room_evidence_blocks(home_id,customer_id,room_key,binding,implementation,
    from_at,to_at,source_revision,capture,sha256,row_count) VALUES($1,$1,'room',$2,$3,$4,$5,$6,'synthetic',repeat('a',64),0)
    ON CONFLICT(home_id,room_key,binding,implementation,from_at) DO NOTHING`,[home,binding,archive,from,to,w.source_revision]);
  const evidence={sourceRevision:w.source_revision,fromAt:from,toAt:to,implementation:archive};
  const capture={homeId:home,customerId:home,roomKey:"room",binding,baseRevision:rev,implementation,evidence};
  assert((await db.query<{ok:boolean}>("SELECT checkpoint_energy_room_fit($1,$2,$3,$4,-1,$5,$6,null) AS ok",
    [j.id,j.generation,j.fence,rev,JSON.stringify({version:5,capture,policy_fingerprint:w.policy_fingerprint}),btoa("synthetic")])).rows[0].ok);
  await release(db,j); j=await claim(db);
  assert((await db.query<{ok:boolean}>("SELECT checkpoint_energy_room_fit_cells($1,$2,$3,$4,0,null,$5,null) AS ok",
    [j.id,j.generation,j.fence,rev,JSON.stringify(Array.from({length:108},(_,index)=>({index})))])).rows[0].ok);
  await release(db,j); j=await claim(db);
  const learning={measured_runs:summary(runs)};
  const model={home_id:home,customer_id:home,room_key:"room",sample_count:100,last_attempted_at:new Date().toISOString(),
    last_fit_attempt:{learning},heating_bands:{binding,calibration_policy:policy,reference_revision:responseRevision,
      reference:{scope:{kind:"shared"},model:{response_family:"finite",sample_count:100,gain_reference_outdoor_c:10,gain_outdoor_slope_per_c:0.1},learning_evidence:learning},
      active:[],shared_attempt:{status:"fitted",implementation,evidence}}};
  const ledger={policy,assessed_against:responseRevision,observed_runs:runs.length,runs};
  const complete=async (patch:unknown=model, runLedger:unknown=ledger, fence=j.fence)=>(await db.query<{ok:boolean}>(
    "SELECT complete_energy_room_fit($1,$2,$3,$4,108,$5,$6) AS ok",
    [j.id,j.generation,fence,rev,JSON.stringify(patch),JSON.stringify(runLedger)])).rows[0].ok;
  return {j,rev,model,ledger,complete};
}
const request=async(db:PGlite)=>(await db.query<{n:number}>("SELECT request_energy_device_learning($1,$1,$2) AS n",
  [home,JSON.stringify([{kind:"room",key:"room",input:{}}])])).rows[0].n;
const page=async(db:PGlite,identity:string,offset=0)=>(await db.query<{runs:MeasuredRoomAssessment[]}>(
  "SELECT get_energy_room_run_assessments($1,'room',$2,$3,100) AS runs",[home,identity,offset])).rows[0].runs;

Deno.test("measured SQL publishes all runs under one reference without run-count gates; late corrections stay queued",async()=>{
  const db=await database();try {
    const runs=Array.from({length:73},(_,i)=>run(i)); const fit=await stage(db,runs);
    await db.query("INSERT INTO energy_optimisation_outdoor_slots VALUES($1,$2,$1,2,null)",[home,from]);
    assertEquals(await fit.complete(undefined,undefined,fit.j.fence+1),false);
    assert(await fit.complete()); assertEquals(await revision(db),fit.rev+1);
    assertEquals(await page(db,"synthetic-accepted"),runs.toReversed());
    assertEquals(await request(db),0,"ordinary uploads respect the accepted measured method");
    const view=(await db.query<{v:{response:{measured_runs:MeasuredRoomCalibration};ledgers:{evidence:{assessment_revision:string;runs:MeasuredRoomAssessment[]}}[]}}>(
      "SELECT get_energy_room_response_evidence($1,'room') AS v",[home])).rows[0].v;
    assertEquals(view.response.measured_runs,summary(runs)); assertEquals(view.ledgers[0].evidence.runs.length,73);
    assertEquals(view.ledgers[0].evidence.assessment_revision,"synthetic-accepted");
    await assertRejects(()=>db.query("SELECT get_energy_room_run_assessments($1,'room','synthetic-accepted',0,50)",[other]),Error,"access denied");
  } finally {await db.close();}
});
Deno.test("measured SQL retains accepted response and immutable ledger when an unidentified attempt publishes its own accounting",async()=>{
  const db=await database();try {
    let fit=await stage(db,[run(1)]); assert(await fit.complete());
    const accepted=(await db.query<{v:unknown}>("SELECT heating_bands->'reference' AS v FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows[0].v;
    await handBack(db,fit.j); fit=await stage(db,[{...run(2),heating:null,heating_status:null,reasons:["missing_native_temperature"]}]);
    const failed={...fit.model,heating_bands:{...fit.model.heating_bands,reference:accepted,
      shared_attempt:{...fit.model.heating_bands.shared_attempt,status:"unidentified"}}};
    assert(await fit.complete(failed)); assertEquals(await page(db,"synthetic-accepted"),[run(1)]);
    const ledgers=(await db.query<{scope_key:string;evidence:{assessment_revision:string;assessed_against:string}}>(
      "SELECT scope_key,evidence FROM private.energy_room_run_ledgers WHERE home_id=$1 ORDER BY scope_key",[home])).rows;
    assertEquals(ledgers.map(l=>l.scope_key),["attempt","shared"]);
    assertEquals(ledgers[0].evidence.assessed_against,"synthetic-accepted");
    assertEquals(await page(db,ledgers[0].evidence.assessment_revision),fit.ledger.runs);
    assertEquals(await request(db),0);
    await db.query("UPDATE energy_optimisation_zone_models SET last_attempted_at=now()-interval '25 hours' WHERE home_id=$1",[home]);
    assertEquals(await request(db),1);
  } finally {await db.close();}
});
Deno.test("measured SQL enforces structural support and ledger types, without invented run counts or timestamp ordering",async()=>{
  const db=await database();try {
    const fit=await stage(db,[]);
    const bad=structuredClone(fit.model);bad.last_fit_attempt.learning.measured_runs.residual_degrees_of_freedom=100;
    bad.heating_bands.reference.learning_evidence=bad.last_fit_attempt.learning;
    await assertRejects(()=>fit.complete(bad),Error,"Invalid measured room support");
    await assertRejects(()=>fit.complete(fit.model,{...fit.ledger,observed_runs:1}),Error,"population");
    assert(await fit.complete(),"physical observations need no completed run minimum");
    await handBack(db,fit.j);
    const unusual={...run(1),off_ms:-100,on_ms:9999,to_ms:-20};
    assert(await (await stage(db,[unusual],"second-accepted")).complete());
  } finally {await db.close();}
});
Deno.test("measured SQL counts heating and cooling flags separately and still accepts the earlier run-level shape",async()=>{
  const db=await database();try {
    const cooling={from_ms:3,to_ms:4,hours:1,c_per_h:.2,room_c:20,outdoor_c:3,house_c:null,energy_kwh:0};
    const runs=[{...run(0),heating_status:"below_line" as const,cooling,cooling_status:"consistent" as const},
      {...run(1),cooling,cooling_status:"above_line" as const}];
    let fit=await stage(db,runs);
    const support=fit.model.last_fit_attempt.learning.measured_runs;
    assertEquals([support.heating_flagged_runs,support.cooling_flagged_runs],[1,1]);
    await assertRejects(()=>fit.complete(fit.model,{...fit.ledger,runs:[{...runs[0],heating_status:"consistent"},runs[1]]}),Error,"population");
    await assertRejects(()=>fit.complete(fit.model,{...fit.ledger,runs:[runs[0],{...runs[1],heating_status:"unmeasured"}]}),Error,"assessment");
    await assertRejects(()=>fit.complete(fit.model,{...fit.ledger,runs:[runs[0],{...runs[1],disposition:"consistent"}]}),Error,"assessment");
    assert(await fit.complete()); assertEquals(await page(db,"synthetic-accepted"),runs.toReversed());
    await handBack(db,fit.j);
    // A ledger published before the split keeps its run-level disposition.
    fit=await stage(db,[],"legacy-accepted");
    const {heating_status:_h,cooling_status:_c,...legacyRun}=run(2);
    const {heating_flagged_runs:_hf,cooling_flagged_runs:_cf,...legacySupport}=fit.model.last_fit_attempt.learning.measured_runs;
    const learning={measured_runs:{...legacySupport,observed_runs:1,heating_runs:1,flagged_runs:0,unmeasured_runs:0}};
    const legacy={...fit.model,last_fit_attempt:{learning},heating_bands:{...fit.model.heating_bands,
      reference:{...fit.model.heating_bands.reference,learning_evidence:learning}}};
    assert(await fit.complete(legacy,{...fit.ledger,observed_runs:1,runs:[{...legacyRun,disposition:"consistent"}]}));
  } finally {await db.close();}
});
Deno.test("measured migration fences old numerical capsules while keeping accepted models and reusable source archives",async()=>{
  const db=await database();try {
    const fit=await stage(db,[run(0)]);
    await db.query("UPDATE private.energy_room_fit_progress SET metadata=jsonb_set(metadata,'{version}','4') WHERE job_id=$1",[fit.j.id]);
    const before=(await db.query("SELECT heating_bands,model_revision FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows;
    await db.query("SELECT private.resume_energy_room_fit($1)",[fit.j.id]);await release(db,fit.j);
    assert(await claim(db));
    assertEquals((await db.query("SELECT 1 FROM private.energy_room_fit_progress WHERE job_id=$1",[fit.j.id])).rows.length,0);
    assertEquals((await db.query("SELECT 1 FROM private.energy_room_evidence_blocks WHERE home_id=$1",[home])).rows.length,1);
    assertEquals((await db.query("SELECT heating_bands,model_revision FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows,before);
  } finally {await db.close();}
});
Deno.test("untrained measured attempts keep their complete accounting and hourly cadence without fabricating a response",async()=>{
  const db=await database();try {
    await db.query("UPDATE energy_optimisation_zone_models SET trained=false,rejection_reason='insufficient_samples',gain_c_per_wh=NULL,cooling_constant_per_h=NULL WHERE home_id=$1",[home]);
    const fit=await stage(db,[{...run(0),heating:null,heating_status:null,reasons:["no_measured_onset"]}]);
    const learning={measured_runs:{...fit.model.last_fit_attempt.learning.measured_runs,fitted_observations:0,residual_degrees_of_freedom:0}};
    const failed={...fit.model,sample_count:0,last_fit_attempt:{learning},heating_bands:{...fit.model.heating_bands,
      reference:undefined,reference_revision:undefined,shared_attempt:{...fit.model.heating_bands.shared_attempt,status:"unidentified"}}};
    assert(await fit.complete(failed,{...fit.ledger,assessed_against:null}));
    assertEquals(await request(db),0,"the completed measured method must not be retriggered on each upload");
    const response=(await db.query<{v:{response:unknown;ledgers:{scope_key:string;evidence:{assessment_revision:string;assessed_against:null}}[]}}>(
      "SELECT get_energy_room_response_evidence($1,'room') AS v",[home])).rows[0].v;
    assertEquals(response.response,null);assertEquals(response.ledgers.map(l=>l.scope_key),["attempt"]);
    assertEquals(response.ledgers[0].evidence.assessed_against,null);
    assertEquals(await page(db,response.ledgers[0].evidence.assessment_revision),fit.ledger.runs);
    await db.query("UPDATE energy_optimisation_zone_models SET last_attempted_at=now()-interval '61 minutes' WHERE home_id=$1",[home]);
    assertEquals(await request(db),1);
  } finally {await db.close();}
});
Deno.test("measured publication retains current policy, owner and model revision fences",async()=>{
  const db=await database();try {
    const fit=await stage(db,[run(0)]);
    await db.query(`INSERT INTO private.energy_room_operation_facts(home_id,customer_id,room_key,binding,from_at,to_at,basis)
      VALUES($1,$1,'room',$2,$3,$4,'customer_assertion')`,[home,binding,from,to]);
    assertEquals(await fit.complete(),false,"reviewed eligibility change vetoes sealed fit");
    assertEquals(await revision(db),fit.rev);
    await release(db,fit.j);
    const next=await stage(db,[run(1)]);
    await db.query("UPDATE energy_optimisation_zone_models SET gain_c_per_wh=.006 WHERE home_id=$1",[home]);
    assertEquals(await next.complete(),false,"an altered base model vetoes publication");
    assertEquals((await db.query("SELECT 1 FROM private.energy_room_run_ledgers WHERE home_id=$1",[home])).rows.length,0);
  } finally {await db.close();}
});
Deno.test("state-carrying rollout resets only numerical work and makes previous-method rooms due",async()=>{
  const db=await database();try {
    const fit=await stage(db,[run(0)]); assert(await fit.complete());
    await release(db,fit.j);
    await db.query("UPDATE energy_optimisation_zone_models SET heating_bands=jsonb_set(heating_bands,'{shared_attempt,implementation}',to_jsonb($2::text)) WHERE home_id=$1",[home,previousImplementation]);
    const accepted=(await db.query("SELECT heating_bands->'reference' AS reference FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows;
    assertEquals(await request(db),1,"previous numerical implementation is due immediately, independently of daily cadence");
    const active=await stage(db,[run(1)],"next-accepted");
    await db.query("UPDATE private.energy_room_fit_progress SET metadata=jsonb_set(metadata,'{capture,implementation}',to_jsonb($2::text)) WHERE job_id=$1",[active.j.id,previousImplementation]);
    const archived=(await db.query("SELECT * FROM private.energy_room_evidence_blocks WHERE home_id=$1",[home])).rows;
    await db.exec(await Deno.readTextFile(stateMigration));
    assertEquals((await db.query("SELECT 1 FROM private.energy_room_fit_progress WHERE job_id=$1",[active.j.id])).rows,[]);
    assertEquals((await db.query("SELECT * FROM private.energy_room_evidence_blocks WHERE home_id=$1",[home])).rows,archived);
    assertEquals((await db.query("SELECT heating_bands->'reference' AS reference FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows,accepted);
    assertEquals(await active.complete(),false,"rollout fences the old claimant without publishing its response");
  } finally {await db.close();}
});
Deno.test("state-carrying publication refuses newly fitted algebraic forecasts but retains an existing algebraic reference exactly",async()=>{
  const db=await database();try {
    const fit=await stage(db,[run(0)]);
    const algebraic=structuredClone(fit.model);
    algebraic.heating_bands.reference.model.response_family="equilibrium";
    await assertRejects(()=>fit.complete(algebraic),Error,"Invalid measured room support");
    assert(await fit.complete());
    await handBack(db,fit.j);
    await db.query("UPDATE energy_optimisation_zone_models SET heating_bands=jsonb_set(heating_bands,'{reference,model,response_family}','\"equilibrium\"') WHERE home_id=$1",[home]);
    const accepted=(await db.query<{reference:unknown}>("SELECT heating_bands->'reference' AS reference FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows[0].reference;
    const next=await stage(db,[run(1)]);
    const failed={...next.model,heating_bands:{...next.model.heating_bands,reference:accepted,
      shared_attempt:{...next.model.heating_bands.shared_attempt,status:"unidentified"}}};
    assert(await next.complete(failed));
    assertEquals((await db.query<{reference:unknown}>("SELECT heating_bands->'reference' AS reference FROM energy_optimisation_zone_models WHERE home_id=$1",[home])).rows[0].reference,accepted);
  } finally {await db.close();}
});
