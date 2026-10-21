import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { baselineFixture } from './fixture';
import { prepareHomeBaseline, projectBaseline } from './model';
import { replayScheduler, REPLAY_PROTOCOL } from './scheduler-replay';
import { compareModels } from './model-comparison';
import { createWasmPlanner, createWasmReplayPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';
import { roiBenchmarkInput } from '../../../scripts/roi-benchmark-scenarios.ts';
import type { NativeCommand, ReadyProblem } from '../../../supabase/functions/_shared/planner-wasm/ready-problem';
const engine=createWasmPlanner(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm',import.meta.url)));
for (const operation of ['grid_charge', 'export'] as const) for (const remaining of [0, .7]) Deno.test(`midnight retains the allocated ${operation} power with ${remaining} kWh remaining`,()=>{
 const input=prepareHomeBaseline(baselineFixture({start:'2026-02-26T22:00:00Z',end:'2026-02-27T01:00:00Z'}));
 const battery=input.problem.battery!;
 input.problem.initial.battery_kwh=operation==='grid_charge'
  ? battery.max_soc*battery.capacity_kwh-3*battery.charge_max_w/4000*battery.charge_efficiency-remaining
  : battery.min_soc*battery.capacity_kwh+3*battery.discharge_max_w/4000/battery.discharge_efficiency+remaining;
 input.settings.policy!.battery_export_enabled=true;
 input.settings.policy!.battery_export_reserve_soc=battery.min_soc;
 const requests: ReadyProblem[]=[];
 let allocated=0;
 const r=replayScheduler(input,{project:engine.project,solve:p=>{
  requests.push(p);
  const result=engine.solve(p);
  if(requests.length!==1 || result.outcome.kind!=='selected') return result;
  // Pin a valid saturated candidate, independent of optimiser tie-breaking.
  const commands: NativeCommand[]=p.slots.map((_,i)=>({pool_on:false,ev_amps:0,
   battery:i>=4&&i<8?operation:'hold',
   charge_limit_w:i>=4&&i<8?operation==='grid_charge'?battery.charge_max_w:0:battery.charge_max_w,
   discharge_limit_w:i>=4&&i<8&&operation==='export'?battery.discharge_max_w:0}));
  const projected=engine.project(p,commands).outcome;
  assert(projected.kind==='projected');
  allocated=operation==='grid_charge'?projected.quarters[7].charge_w:projected.quarters[7].discharge_w;
  assertAlmostEquals(allocated,remaining*4000*(operation==='grid_charge'?1/battery.charge_efficiency:battery.discharge_efficiency),1e-7);
  assert(allocated<(operation==='grid_charge'?battery.charge_max_w:battery.discharge_max_w));
  return {...result,outcome:{...result.outcome,selection:{...result.outcome.selection,commands,quarters:projected.quarters}}};
 }});
 assertEquals(requests.length,2);
 assertEquals(requests[1].locked_through_seconds,3600);
 assertEquals(requests[1].accepted,r.commands.slice(4,8));
 const committed=requests[1].accepted![3];
 assertEquals(committed.battery,allocated===0?'idle':operation);
 assertEquals(r.commands[0].battery,'hold');
 assertEquals(r.commands[0].charge_limit_w,battery.charge_max_w);
 assertAlmostEquals(operation==='grid_charge'?committed.charge_limit_w:committed.discharge_limit_w,allocated);
 assertAlmostEquals(operation==='grid_charge'?r.series.batteryChargeW[7]:r.series.batteryDischargeW[7],allocated);
});
Deno.test('current native scheduler executes its own commands, carries state and withdraws recorded trips without charging gains',()=>{
 const rows=baselineFixture(); rows.actual.forEach(r=>r.grid_import_kwh=999);
 rows.actual.slice(40,100).forEach(r=>r.ev_soc=.75); rows.actual.slice(100).forEach(r=>r.ev_soc=.8);
 const input=prepareHomeBaseline(rows), r=replayScheduler(input,engine);
 assertEquals(r.protocol,REPLAY_PROTOCOL);assertEquals(r.series.start.length,288);assert(r.solves>=4);
 assert(r.ledger.importKwh<input.recorded.ledger.importKwh);
 assertAlmostEquals(r.ledger.costSek,r.series.costSek.reduce((n,v)=>n+v,0));
 for(let i=0;i<288;i++){
  const initial=i===0?input.problem.initial.ev_kwh!:r.series.carSoc[i-1]!/100*input.problem.car!.capacity_kwh;
  assertAlmostEquals(r.series.carSoc[i]!/100*input.problem.car!.capacity_kwh,initial-input.evDemandKwh[i]+r.series.carW[i]/4000*input.problem.car!.charge_efficiency,1e-7);
 }
});
Deno.test('cash totals exclude native wear/end-credit, and physical starting energy is preserved',()=>{
 const rows=baselineFixture({start:'2026-09-01T00:00:00Z',end:'2026-09-02T00:00:00Z'}); rows.actual[0].battery_soc=null;
 const input=prepareHomeBaseline(rows), r=compareModels(input,engine);
 assertEquals(input.problem.initial.battery_kwh,0);
 assertEquals(Object.hasOwn(r.modeled,'effects'),false);
 assertAlmostEquals(r.modeled.schedulerBill.totalSek,r.scheduler.ledger.costSek+r.modeled.schedulerBill.supplierFixedSek+r.modeled.schedulerBill.gridFixedSek+r.modeled.schedulerBill.gridPeakSek);
 const invalid={...input,settings:{...input.settings,criteria:undefined}};
 assertThrows(()=>replayScheduler(invalid,engine),Error,'settings unavailable');
});
Deno.test('a partial final midnight never fabricates a one-hour native commitment',()=>{
 const input=prepareHomeBaseline(baselineFixture({start:'2026-10-10T21:30:00Z',end:'2026-10-10T22:45:00Z'}));
 const requests: import('../../../supabase/functions/_shared/planner-wasm/ready-problem').ReadyProblem[]=[];
 const r=replayScheduler(input,{project:engine.project,solve:p=>{requests.push(p);return engine.solve(p);}});
 assertEquals(r.series.start.length,5);assertEquals(requests.length,2);
 assertEquals(requests[1].slots.length,3);assertEquals(requests[1].accepted,null);assertEquals(requests[1].locked_through_seconds,0);
});
Deno.test('EV departure masks only car availability, including midnight trips; pool/battery retain the full forecast',()=>{
 const rows=baselineFixture({start:'2026-10-10T12:00:00Z',end:'2026-10-13T12:00:00Z'});
 rows.actual.slice(41,81).forEach(r=>r.ev_soc=.75);
 rows.actual.slice(81).forEach(r=>r.ev_soc=.70);
 const input=prepareHomeBaseline(rows);
 const requests: import('../../../supabase/functions/_shared/planner-wasm/ready-problem').ReadyProblem[]=[];
 const r=replayScheduler(input,{project:engine.project,solve:p=>{requests.push(p);return engine.solve(p);}});
 const trip=input.evDemandKwh.findIndex(v=>v>0);
 assertEquals(requests[0].slots.length,288);
 assertEquals(requests[0].slots[trip-1].ev_available,true);
 assert(requests[0].slots.slice(trip).every(s=>!s.ev_available));
 assertAlmostEquals(requests[0].slots[trip+1].import_price,input.problem.slots[trip+1].import_price);
 const midnight=requests.find(p=>p.slots.length===288-trip)!;
 assert(midnight);assertAlmostEquals(midnight.initial.ev_kwh!,r.series.carSoc[trip]!/100*input.problem.car!.capacity_kwh);
 // Midnight already knows this withdrawal and the following availability.
 assertEquals(requests.some(p=>p.slots.length===288-trip-1),false);
 const second=input.evDemandKwh.findIndex((v,i)=>i>trip&&v>0);
 const homecoming=requests.find(p=>p.slots[0].ev_available && p.slots.length===288-second-1)!;
 assert(homecoming);assertAlmostEquals(homecoming.initial.ev_kwh!,r.series.carSoc[second]!/100*input.problem.car!.capacity_kwh);
 assertEquals(r.commands[trip].ev_amps,0);
 const impossible={...input,evDemandKwh:[input.problem.car!.capacity_kwh*2,...input.evDemandKwh.slice(1)]};
 assertThrows(()=>replayScheduler(impossible,engine),Error,'unserved recorded EV trip');
});
Deno.test('comparisons run only the selected physical model and retain no cross-calculation solves',()=>{
 const input=prepareHomeBaseline(baselineFixture({start:'2026-09-01T00:00:00Z',end:'2026-09-02T00:00:00Z'}));
 input.batteryInitialAssumed=true;
 input.problem.initial.battery_kwh=input.problem.battery!.capacity_kwh*input.problem.battery!.max_soc;
 let calls=0;
 const counted={project:engine.project,solve:(p: import('../../../supabase/functions/_shared/planner-wasm/ready-problem').ReadyProblem)=>{calls++;return engine.solve(p);}};
 const a=compareModels(input,counted);
 assertEquals(calls,a.scheduler.solves);
 const b=compareModels(input,counted);
 assertEquals(calls,a.scheduler.solves+b.scheduler.solves);
 assertAlmostEquals(a.modeled.schedulerBill.totalSek,b.modeled.schedulerBill.totalSek);
});

for (const midnight of [false, true]) Deno.test(`hourly EV absence preserves native conservation and ${midnight ? 'skips a return already covered by midnight' : 'replans from all withdrawals at return'}`, () => {
 const start = midnight ? '2026-10-10T20:00:00Z' : '2026-10-10T12:00:00Z';
 const end = midnight ? '2026-10-11T01:00:00Z' : '2026-10-10T17:00:00Z';
 const rows = baselineFixture({start,end}), from=Date.parse(start);
 rows.evInitial!.ev_soc=.8;
 rows.actual.forEach(row=>{
  const hours=(Date.parse(row.start_ts)-from)/3_600_000;
  row.ev_soc=hours<1?.8:hours<2?.75:.7;
 });
 rows.hourlyFields=rows.actual.map(row=>({start_ts:row.start_ts,fields:['ev_soc']}));
 const input=prepareHomeBaseline(rows), requests: ReadyProblem[]=[];
 const scheduler=replayScheduler(input,{project:engine.project,solve:p=>{requests.push(p);return engine.solve(p);}});
 const baseline=projectBaseline(input,engine,false);
 assertEquals(scheduler.solves,2);
 assertEquals(requests[1].slots.length,midnight?12:8);
 assertEquals(requests[1].locked_through_seconds,3600);
 assert(requests[0].slots.slice(4).every(s=>!s.ev_available));
 assertEquals(requests[1].slots[0].ev_available,!midnight);
 assertAlmostEquals(input.evDemandKwh[4],.05*input.problem.car!.capacity_kwh);
 assertAlmostEquals(input.evDemandKwh[8],.05*input.problem.car!.capacity_kwh);
 assertEquals(input.evDemandKwh.filter(v=>v>0).length,2);
 for(const result of [baseline,scheduler]){
  let ev=input.problem.initial.ev_kwh!;
  for(let i=0;i<input.problem.slots.length;i++){
   const s=result.series;
   ev-=input.evDemandKwh[i];
   ev+=s.carW[i]/4000*input.problem.car!.charge_efficiency;
   assertAlmostEquals(s.carSoc[i]!/100*input.problem.car!.capacity_kwh,ev,1e-8);
   assertAlmostEquals(s.gridImportW[i]-s.gridExportW[i],s.loadW[i]+s.batteryChargeW[i]-s.batteryDischargeW[i]-s.solarW[i],1e-7);
   assertEquals(s.carConnected[i],input.problem.slots[i].ev_available?1:0);
   if(!input.problem.slots[i].ev_available){
    assertEquals(result.commands[i].ev_amps,0);
    assertEquals(s.carW[i],0);
   }
  }
  assertAlmostEquals(result.ledger.costSek,result.series.costSek.reduce((a,b)=>a+b,0),1e-8);
 }
});

Deno.test('delayed-pool hourly EV benchmark solves once daily and once per inferred return, with all thirty withdrawals', () => {
 const input=roiBenchmarkInput('delayed-pool-hourly-ev');
 input.problem.slots=input.problem.slots.slice(0,288);
 input.evDemandKwh=input.evDemandKwh.slice(0,288);
 input.end=new Date(Date.parse(input.start)+288*900_000).toISOString();
 const native=createWasmReplayPlanner(Deno.readFileSync(new URL('../../../supabase/functions/_shared/planner-wasm/solver.wasm',import.meta.url)));
 let projections=0;
 const r=replayScheduler(input,{solve:native.solve,project:(p,c)=>{projections++;return native.project(p,c);}});
 assertEquals(r.solves,6);
 assertEquals(projections,288);
 assertEquals(input.evDemandKwh.filter(v=>v>0).length,30);
 assertAlmostEquals(input.evDemandKwh.reduce((a,b)=>a+b,0),.3*input.problem.car!.capacity_kwh);
});
