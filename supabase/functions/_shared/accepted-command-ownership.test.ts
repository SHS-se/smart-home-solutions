import {applyBatteryChoice} from './home-planning.ts';
import {validateAcceptedBatteryCapture} from './execution-replan.ts';
import {assert,assertEquals,assertThrows} from '@std/assert';
import {dispatchedEvSnapshot,mixedModeSnapshot,rulesFixtureInput} from '../../../scripts/generate-ha-plan-fixture.ts';
import {compileCommitments} from './rules-commitments.ts';
import {captureRulesPlanningInput} from './rules-planning-capture.ts';
import {prepareCapturedRulesInput} from './rules-planning-execution.ts';
import {generateRulesPlan,prepareRulesPlanningInput} from './rules-planner.ts';
import {resolveRulePolicy} from './planner-wasm/rule-policy.ts';

// Independently generated synthetic schedules; no household replay inputs.
function ownership() {
  const snapshot=dispatchedEvSnapshot();snapshot.slots=snapshot.slots.slice(0,8);
  const input={snapshot,now:snapshot.captured_at,resolved_price_outlook:rulesFixtureInput(snapshot).price_outlook};
  const policy=resolveRulePolicy();
  const plan=generateRulesPlan(prepareRulesPlanningInput(input,null,policy)).plan;
  return {snapshot,input,policy,household:{plan_id:'synthetic-Q',slots:plan.plans.priority.slots},
    battery:{plan_id:'synthetic-B',slots:plan.plans.priority.slots.map(s=>({...s,battery_command:{schema_version:3 as const,
      operation:'grid_charge' as const,charge_limit_w:321,discharge_limit_w:0,allow_grid_charge:true,allow_battery_export:false}}))}};
}
Deno.test('independent accepted sources retain Q and B absolute intervals without inherited OFF holds',()=>{
  const {snapshot,household,battery}=ownership();
  snapshot.battery=mixedModeSnapshot().battery;snapshot.capabilities.battery=true;
  household.slots=household.slots.slice(0,1);
  battery.slots=battery.slots.slice(1,4);
  const c=compileCommitments(snapshot,household,null,{battery});
  assertEquals(c.original.length,4);
  assertEquals(c.released[0],{pool:false,ev:false,battery:true});
  assertEquals(c.original[0].battery_command,undefined);
  assertEquals(c.released[1],{pool:true,ev:true,battery:false});
  assertEquals(c.original[1].ev_target_current_a,undefined);
  assertEquals(c.retained[3].battery_command?.charge_limit_w,321);
  assertEquals(c.retained[1].start,snapshot.slots[1].start);
  assertEquals(c.owners_by_slot,[[],[],[],[]]); // missing holds are not a claimed scoped release.
});
Deno.test('live capture explicitly has no accepted battery while pure single-reference callers retain all owners',()=>{
  const {snapshot,input,policy,household}=ownership();
  const old=compileCommitments(snapshot,household,null);
  assert(old.released.every(m=>!m.battery));
  const live=captureRulesPlanningInput(input,household,policy,{battery:null});
  const prepared=prepareCapturedRulesInput(live);
  assert(prepared.problem.released!.every(m=>m.battery));
  assert(prepared.held_reference.every(s=>s.battery_command===undefined));
  const noOwners=prepareCapturedRulesInput(captureRulesPlanningInput(input,null,policy,{battery:null}));
  assert(noOwners.problem.released!.every(m=>m.ev&&m.pool&&m.battery));
});

Deno.test('restored empty local battery account bootstraps while cloud B commands remain held',()=>{
  const prepared=rulesFixtureInput(mixedModeSnapshot());
  const initial=generateRulesPlan(prepared).plan;
  const reference={plan_id:initial.plan_id,slots:initial.plans.priority.slots,
    battery_contract:{id:initial.battery_execution!.id,scope_revision:initial.battery_execution!.scope_revision,generation:1}};
  const source={snapshot:structuredClone(prepared.snapshot),now:prepared.now,resolved_price_outlook:prepared.price_outlook};
  source.snapshot.battery_execution_feedback!.previous_contract_id=null;
  validateAcceptedBatteryCapture(source.snapshot,reference);
  const fresh=prepareCapturedRulesInput(captureRulesPlanningInput(source,reference,resolveRulePolicy(),{battery:reference}));
  assert(fresh.problem.released!.every(m=>!m.battery));
  const replacement=generateRulesPlan(fresh).plan;
  assertEquals(replacement.battery_execution!.previous_contract_id,null);
  assertEquals(replacement.status,'ready');
  assertEquals(replacement.plans.priority.slots.slice(0,4).map(s=>s.battery_instruction),initial.plans.priority.slots.slice(0,4).map(s=>s.battery_instruction));
  source.snapshot.battery_execution_feedback!.previous_contract_id='newly-accepted-contract';
  assertThrows(()=>validateAcceptedBatteryCapture(source.snapshot,reference));
  validateAcceptedBatteryCapture(source.snapshot,{...reference,battery_contract:{...reference.battery_contract,id:'newly-accepted-contract'}});
});

Deno.test('battery exclusion and unusable SOC omit B planning holds without mutating accepted provenance',()=>{
  const prepared=rulesFixtureInput(mixedModeSnapshot());
  const initial=generateRulesPlan(prepared).plan;
  const reference={plan_id:initial.plan_id,slots:initial.plans.priority.slots};
  const before=structuredClone(reference);
  for(const captured of [applyBatteryChoice(structuredClone(prepared.snapshot),false),
    {...structuredClone(prepared.snapshot),battery:{...prepared.snapshot.battery!,soc:2}}]) {
    const source={snapshot:captured,now:prepared.now,resolved_price_outlook:prepared.price_outlook};
    const compiled=prepareCapturedRulesInput(captureRulesPlanningInput(source,reference,resolveRulePolicy(),{battery:reference}));
    assert(compiled.problem.released!.every(m=>m.battery));
    assert(compiled.held_reference.every(s=>s.battery_command===undefined&&s.battery_instruction===undefined));
    const replacement=generateRulesPlan(compiled).plan;
    assertEquals(replacement.status,'ready');assertEquals(replacement.battery,null);
  }
  assertEquals(reference,before);
});
