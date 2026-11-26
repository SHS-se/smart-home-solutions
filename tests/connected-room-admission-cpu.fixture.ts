/** Independently synthetic accepted calibration, never copied from a household.
 * Thirteen receiving nodes, three directed peers each, four inference replicas
 * of256 distinct particles: no duplicate compression hides validation work. */
import { assert, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { cpuConnectedRoomPlanningSource } from "./planner-handler-cpu.fixture.ts";
import { captureDeviceModels } from "../supabase/functions/_shared/device-model-store.ts";
import { prepareRoomModels, captureRoomPlanningState, type RoomDeviceMapping } from "../supabase/functions/_shared/room-model-capture.ts";
import { captureRulesPlanningInput, type CapturedRulesInput, type RulesPlanningSource } from "../supabase/functions/_shared/rules-planning-capture.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import { PlanningJobs } from "../supabase/functions/_shared/energy-planning-jobs.ts";
import type { ConnectedRoomResponse, ExchangeDynamics } from "../supabase/functions/_shared/planner/models/room/connected-exchange.ts";

const HOME="11111111-1111-4111-8111-111111111111";
export interface ConnectedAdmissionCpuFixture {
  source: RulesPlanningSource;
  mappings: RoomDeviceMapping[];
  /** These raw database response bodies are parsed inside the timed operation. */
  bundle_json: string;
  latest_json: string;
  schedules_json: string;
  history_json: string;
}
export function connectedAdmissionCpuInput():Uint8Array<ArrayBuffer> {
  const source=cpuConnectedRoomPlanningSource(false,true),snapshot=source.snapshot;
  const nodes=snapshot.room_network!.nodes.slice(0,13), at=Date.parse(snapshot.captured_at);
  const keys=nodes.map(node=>node.key),graphHash="a".repeat(64);
  const rooms:Record<string,unknown>[]=[],heating:Record<string,unknown>={},observed:Record<string,unknown>={};
  const mappings:RoomDeviceMapping[]=snapshot.thermal_zones!.map(zone=>({key:zone.device_keys[0],control_type_override:"setpoint",room:{key:zone.key,name:zone.name}}));
  const connections=new Map<string,[string,string]>();
  for(const [i,node] of nodes.entries()) {
    const peers=[keys[(i+1)%13],keys[(i+12)%13],keys[(i+4)%13]];
    for(const peer of peers){const pair=[node.key,peer].sort() as [string,string];connections.set(JSON.stringify(pair),pair);}
    const incoming:ExchangeDynamics[]=peers.map((from,j)=>({kind:"log_ou",from,mean_log_per_h:-3+j*.2,reversion_per_h:.03+j*.04,stationary_variance:.1+j*.05}));
    const posterior={...node.posterior,through_ms:at,log_rates:[-3,-2.8,-2.6],log_centers:[-3,-2.8,-2.6],
      covariance:Array.from({length:8},(_,r)=>Array.from({length:8},(_,c)=>r===c?.02:.001))};
    const model:ConnectedRoomResponse={...node.model,incoming,reference_state:posterior,
      basis:{...node.model.basis,graph_owner:null,graph_revision:null,topology_hash:graphHash,source_policy:"b".repeat(64)},
      process_belief:{revision:"connected_process_regimes_v2",initial_incoming:incoming,initial_hazard:{shape:.5,rate_h:.25},
        reset_priors:incoming.map(edge=>({from:edge.from,center_mean:-3,center_variance:.3,log_reversion_mean:-3,
          log_reversion_sd:1,stationary_variance_scale:1,constant_probability:.5})),
        replicas:Array.from({length:4},(_,replica)=>({rng_state:replica+1,particles:256,log_evidence:-100-replica*.1})),
        hypotheses:Array.from({length:1024},(_,h)=>({replica:Math.floor(h/256),multiplicity:1,log_weight:-Math.log(256),
          incoming:incoming.map(edge=>edge.kind==='constant'?edge:{...edge,reversion_per_h:.01+(h%16)*.005,stationary_variance:.05+Math.floor(h/16)%16*.01}),
          posterior:{...posterior,temperature_c:20+(h%256)*.001},thermal_state_identified:true,
          hazards:incoming.map(()=>({shape:.5+(h%7),rate_h:9600}))}))}};
    const zone=snapshot.thermal_zones!.find(zone=>zone.key===node.key),binding=`synthetic-admission-${i}`;
    rooms.push({room_key:node.key,model_revision:i+1,trained:true,...zone?.model,
      heating_bands:{binding,since:new Date(at-400*86400000).toISOString(),reference_revision:`synthetic-${i}`,
        reference:{model:zone?.model??null,connected_exchange:model,scope:{kind:'shared'}},attempted:{},active:[],candidates:[]}});
    (zone?heating:observed)[node.key]={binding,observed_since:new Date(at-400*86400000).toISOString(),room_name:node.key};
  }
  const starts=Array.from({length:96},(_,i)=>at-(96-i)*900000);
  const latest=nodes.map((node,i)=>({room_key:node.key,start_ts:new Date(at-900000).toISOString(),room_temperature_c:20+i*.1}));
  const history=snapshot.thermal_zones!.map(zone=>({room_key:zone.key,temperature_starts:starts,
    heater_quarters:starts.map(start=>[start,400]),outdoor_quarters:starts.map(start=>[start,5])}));
  snapshot.room_network=undefined;snapshot.thermal_zones=[];
  return new TextEncoder().encode(JSON.stringify({source,mappings,bundle_json:JSON.stringify({rooms,pool:null,devices:[],
    room_heating:heating,room_observed:observed,room_graph:{owner:null,revision:null,topology_hash:graphHash,connections:[...connections.values()].sort()}}),
    schedules_json:JSON.stringify(mappings.map(mapping=>({room_key:mapping.room!.key,weekday_modes:Array(96).fill("high-temp"),weekend_modes:Array(96).fill("high-temp"),off_temperature_c:16,low_temperature_c:19,high_temperature_c:21}))),
    latest_json:JSON.stringify(latest),history_json:JSON.stringify(history)} satisfies ConnectedAdmissionCpuFixture));
}
export async function runConnectedAdmissionCpu(fixture:ConnectedAdmissionCpuFixture) {
  let serialized="";
  const db=createClient("https://synthetic-admission.test","synthetic-service",{auth:{persistSession:false},global:{fetch:(url,init)=>{
    const name=String(url).split('/').at(-1)!;
    if(name==='capture_energy_device_models')return Promise.resolve(new Response(fixture.bundle_json,{headers:{'content-type':'application/json'}}));
    if(name==='get_energy_latest_room_temperatures')return Promise.resolve(new Response(fixture.latest_json,{headers:{'content-type':'application/json'}}));
    if(name==='get_energy_room_planning_history')return Promise.resolve(new Response(fixture.history_json,{headers:{'content-type':'application/json'}}));
    if(String(url).includes('/energy_optimisation_comfort_schedules?'))return Promise.resolve(new Response(fixture.schedules_json,{headers:{'content-type':'application/json'}}));
    if(name==='accept_energy_planning_job') {
      serialized=String(init?.body);
      return Promise.resolve(Response.json({job_id:HOME,snapshot_id:fixture.source.snapshot.snapshot_id,state:'pending',pending:true,retry_after_ms:100}));
    }
    throw new Error(`Unexpected synthetic admission read ${String(url)}`);
  }}});
  const bundle=await captureDeviceModels(db,HOME);
  const prepared=prepareRoomModels(fixture.source.snapshot,fixture.mappings,bundle);
  const snapshot=await captureRoomPlanningState(db,HOME,HOME,prepared.snapshot,prepared.rooms);
  const capture=captureRulesPlanningInput({...fixture.source,snapshot},null,resolveRulePolicy());
  await new PlanningJobs(db).accept({homeId:HOME,customerId:HOME,snapshotId:snapshot.snapshot_id,sourceHash:'c'.repeat(64),input:capture,
    context:{request_id:'synthetic-admission',integration_version:'synthetic',reference_plan_id:null,fixed_revision:0,
      observed_replan_request_id:null,replan_request_id:null,completion_basis:'publication',exchange:{}}});
  return {serialized,rooms:prepared.rooms.length,bundle_bytes:new TextEncoder().encode(fixture.bundle_json).length,
    admission_bytes:new TextEncoder().encode(serialized).length};
}
export function checkConnectedAdmissionCpu(result:Awaited<ReturnType<typeof runConnectedAdmissionCpu>>) {
  assertEquals(result.rooms,13);
  const input=(JSON.parse(result.serialized) as {input:CapturedRulesInput}).input;
  const rooms=input.snapshot.room_network_capture!.rooms;
  assertEquals(rooms.length,13);assertEquals(input.snapshot.room_network,undefined);
  assertEquals(input.snapshot.thermal_zones?.length,8);
  assert(input.snapshot.thermal_zones!.every(zone=>zone.model!==null),'all identified heated services remain modeled');
  let particles=0,hypotheses=0;
  for(const room of rooms) {
    const belief=room.connected_exchange!.process_belief!;
    assert(belief,'every accepted process belief survives the real reader');
    assertEquals(belief.replicas.length,4);assertEquals(belief.hypotheses.length,1024);
    particles+=belief.replicas.reduce((sum,r)=>sum+r.particles,0);hypotheses+=belief.hypotheses.length;
  }
  assertEquals(particles,13*4*256);assertEquals(hypotheses,particles);
  assertEquals(rooms.filter(room=>room.model!==null).length,8,'valid identified heaters are not silently discarded');
  return {bundle_bytes:result.bundle_bytes,admission_bytes:result.admission_bytes,receivers:rooms.length,conceptual_particles:particles,distinct_hypotheses:hypotheses};
}
