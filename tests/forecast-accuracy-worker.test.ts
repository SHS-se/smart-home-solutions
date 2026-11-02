import {assertEquals} from '@std/assert';
import {handleForecastAccuracy} from '../supabase/functions/_shared/forecast-accuracy-store.ts';
import type {AccuracyEvidence} from '../supabase/functions/_shared/forecast-accuracy.ts';

type Db=Parameters<typeof handleForecastAccuracy>[1];
const HOME='11111111-1111-4111-8111-111111111111', AT='2026-10-25T06:00:00Z';
// Synthetic empty evidence tests worker failures without any planner or executor I/O.
const empty:AccuracyEvidence={energy:[],rooms:[],estimates:[],catalog:{names:[],room_names:[],latest_keys:[],latest_rooms:[]},
  actuals:[],device_actuals:[],prices:[],room_actuals:[]};
for (const failing of ['read_energy_accuracy_evidence','complete_energy_accuracy_job',null]) {
  Deno.test(`accuracy worker isolates ${failing ?? 'successful compact read'} from planning`,async()=>{
    const calls:{name:string;args:Record<string,unknown>}[]=[];
    const db={rpc:(name:string,args:Record<string,unknown>)=>{
      calls.push({name,args});
      if (name===failing) return {data:null,error:{message:'Synthetic reporting outage'}};
      switch(name) {
        case 'verify_energy_accuracy_token':return {data:true,error:null};
        case 'claim_energy_accuracy_job':return {data:{home_id:HOME,scheduled_at:AT,timezone:'Europe/Stockholm',fence:7},error:null};
        case 'read_energy_accuracy_evidence':return {data:empty,error:null};
        case 'complete_energy_accuracy_job':return {data:true,error:null};
        case 'fail_energy_accuracy_job':return {data:null,error:null};
        default:throw Error('Unexpected control/database operation: '+name);
      }
    }} as unknown as Db;
    const response=await handleForecastAccuracy(new Request('https://synthetic.invalid',{method:'POST',body:JSON.stringify({home_id:HOME,scheduled_at:AT})}),db);
    assertEquals(response.status,failing ? 500 : 200);
    const read=calls.find(c=>c.name==='read_energy_accuracy_evidence')!;
    assertEquals(read.args,{p_home_id:HOME,p_scheduled_at:AT});
    assertEquals(calls.at(-1)!.name,failing ? 'fail_energy_accuracy_job' : 'complete_energy_accuracy_job');
    if (failing) assertEquals(calls.at(-1)!.args.p_fence,7);
    else assertEquals((calls.at(-1)!.args.p_report as {version:number}).version,3);
  });
}
