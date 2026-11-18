import {assertEquals, assertThrows} from '@std/assert';
import {AccuracyReportCache,readAccuracyStatus,type AccuracyReportDelta} from '../supabase/functions/_shared/forecast-accuracy-sync.ts';
import type {AccuracyReport} from '../supabase/functions/_shared/forecast-accuracy.ts';

// Synthetic report identity; no household records.
const report={version:3,scheduled_at:'2026-11-18T06:00:00Z',calculations:[{key:'synthetic',bias_kwh:1}]} as unknown as AccuracyReport;
Deno.test('accuracy cache retains unchanged diagnostics, replaces corrections and resets with home/cache loss',()=>{
  const cache=new AccuracyReportCache();
  assertEquals(cache.revision,null);
  assertEquals(cache.apply({state:'changed',revision:'a',report}),report);
  assertEquals(cache.apply({state:'unchanged',revision:'a'}),report);
  const corrected={...report,calculations:[{key:'synthetic',bias_kwh:2}]};
  assertEquals(cache.apply({state:'changed',revision:'b',report:corrected}),corrected);
  assertEquals(cache.apply({state:'missing',revision:null}),null);
  assertEquals(cache.revision,null);
  cache.apply({state:'changed',revision:'a',report});
  assertEquals(cache.clear(),null); // A failed read forces a full retry.
  assertEquals(cache.revision,null);
  assertThrows(()=>cache.apply({state:'unchanged',revision:'a'}),Error,'retained revision');
  const otherHome=new AccuracyReportCache();
  assertThrows(()=>otherHome.apply({state:'unchanged',revision:'b'}),Error,'retained revision');
});

Deno.test('status diagnostics skip notification reads and negotiate unchanged reports without affecting readiness',async()=>{
  const calls:unknown[]=[];
  let delta:AccuracyReportDelta={state:'changed',revision:'a',report},fail=false;
  const db={rpc:(_name:'read_energy_forecast_accuracy',args:{p_home_id:string;p_known_revision:string|null})=>{
    calls.push(args);return Promise.resolve({data:delta,error:fail ? {code:'synthetic_unavailable'} : null});
  }};
  assertEquals(await readAccuracyStatus(db,'home',{kind:'notification'}),{});
  assertEquals(calls,[]);
  assertEquals(await readAccuracyStatus(db,'home',{kind:'status',knownRevision:null}),{
    forecast_accuracy:report,forecast_accuracy_revision:'a',forecast_accuracy_state:'changed',forecast_accuracy_error:null,
  });
  delta={state:'unchanged',revision:'a'};
  assertEquals(await readAccuracyStatus(db,'home',{kind:'status',knownRevision:'a'}),{
    forecast_accuracy:null,forecast_accuracy_revision:'a',forecast_accuracy_state:'unchanged',forecast_accuracy_error:null,
  });
  assertEquals(calls,[{p_home_id:'home',p_known_revision:null},{p_home_id:'home',p_known_revision:'a'}]);
  fail=true;
  assertEquals(await readAccuracyStatus(db,'home',{kind:'status',knownRevision:'a'}),{
    forecast_accuracy:null,forecast_accuracy_revision:null,forecast_accuracy_state:'unavailable',forecast_accuracy_error:'Accuracy unavailable',
  });
});
