import {assertEquals} from 'jsr:@std/assert@1';
import type {SupabaseClient} from 'https://esm.sh/@supabase/supabase-js@2.57.2';
import {recordPlanningActivity} from './planning-log.ts';
Deno.test('planning log excludes routine learning and empty exchanges; actionable problems keep receipt identity',async()=>{
  const calls:unknown[]=[];
  const db={rpc:(_name:string,body:unknown)=>{calls.push(body);return Promise.resolve({error:null});}} as unknown as SupabaseClient;
  const warning={code:'profile_estimated',scope:'ev',severity:'warning' as const,message:'Learning',consequence:'Estimate'};
  await recordPlanningActivity(db,'home','customer',{receipt_id:'poll',source:'planner',warnings:[warning]});
  await recordPlanningActivity(db,'home','customer',{receipt_id:'empty',source:'home_assistant',counts:{actuals:0}});
  assertEquals(calls,[]);
  await recordPlanningActivity(db,'home','customer',{receipt_id:'batch',source:'home_assistant',counts:{actuals:96},
    warnings:[warning,{...warning,code:'source_missing',message:'Required source missing'}]});
  assertEquals(calls,[{p_home_id:'home',p_customer_id:'customer',p_activity:{receipt_id:'batch',source:'home_assistant',counts:{actuals:96},
    warnings:[{...warning,code:'source_missing',message:'Required source missing'}]}}]);
});
