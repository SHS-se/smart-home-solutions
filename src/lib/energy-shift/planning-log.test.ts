import {assertEquals,assertStringIncludes} from 'jsr:@std/assert@1';
import {planningLogText,type PlanningLogEntry} from './planning-log.ts';
const en=(_sv:string,s:string)=>s;
const entry=(patch:Partial<PlanningLogEntry>):PlanningLogEntry=>({id:'x',sequence:1,home_id:'home',customer_id:'customer',
  event_key:'x',occurred_at:'2026-10-24T10:00:00Z',last_seen_at:'2026-10-24T10:00:00Z',kind:'planning',severity:'info',
  state:'accepted',reason:{reason:'manual_replan_button'},details:{},occurrences:1,...patch});
Deno.test('log shows concise batches, warnings and large calculations while retaining full details',()=>{
  const batch=planningLogText(entry({kind:'exchange',occurrences:4,details:{counts:{actuals:48,thermal:384}}}),en);
  assertEquals(batch.text,'4 batches · 432 data rows');
  const warning='Pool sensor unavailable. '.repeat(40);
  const text=planningLogText(entry({kind:'warning',severity:'error',reason:{message:warning},occurrences:9}),en);
  assertEquals(text.title,'Error');
  assertEquals(text.text.length<=160,true);
  assertStringIncludes(text.detail,warning);
  assertStringIncludes(text.detail,'9 times');
  const plan=planningLogText(entry({details:{calculation_ms:42000}}),en);
  assertStringIncludes(plan.text,'Calculation: 42 s.');
  assertEquals(planningLogText(entry({reason:{code:'new_published_prices'}}),en).text,'New electricity prices.');
});
