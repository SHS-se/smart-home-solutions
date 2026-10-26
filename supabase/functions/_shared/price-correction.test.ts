/** Synthetic forecasts and errors, independent of captured household data. */
import { assertAlmostEquals, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import { buildPriceCorrection, CORRECTION_FEATURE_NAMES, type PriceCorrectionInput } from './price-correction.ts';
import { PRICE_PAIR_GENERATION_MODELS } from './price-pair.ts';
import type { GenerationMixForecast, GenerationModels } from './generation-mix.ts';
import type { EntsoeInterval } from './entsoe-market-data.ts';
const ORIGIN='2026-10-24T12:00:00Z', HOUR=3_600_000, QUARTER=900_000;
function input(): PriceCorrectionInput {
 const start=Date.parse(ORIGIN);
 const generation: GenerationMixForecast={algorithm:'se3-generation-analog-v2',zone:'SE3',origin:ORIGIN,
  hours:Array.from({length:72},(_,i)=>({start:new Date(start+i*HOUR).toISOString(),byPsr:Object.fromEntries(PRICE_PAIR_GENERATION_MODELS.map(({psrType,model},index)=>{
   const models=Object.fromEntries(['calendar','weather','hydro_state','nuclear_ratio','nuclear_delta','published','persistence'].map(name=>[name,{status:'unavailable',reason:'unused'}])) as GenerationModels;
   models[model]={status:'predicted',mw:100+index*10+i,trainingSamples:10,latestTrainingEnd:ORIGIN};return [psrType,models];
  }))})),training:{},diagnostics:{actuals:{completeHours:0,productionIntervals:0,reason:null},weather:{status:'available',reason:null,issueTime:null},published:{completeHours:0,productionIntervals:0,reason:null}}};
 const intervals:EntsoeInterval[]=['A60','A61'].map((businessType,i)=>({startMs:Date.parse('2026-10-24T22:00Z'),endMs:Date.parse('2026-10-25T23:00Z'),value:8000+i*4000,businessType,resolution:'P1D',unit:'MAW',psrType:null,seriesId:businessType,flow:'consumption'}));
 return {knownAt:ORIGIN,truthCutoff:20,generationRunId:'synthetic-mix',generation,load:{id:'synthetic-load',intervals},training:[],
  baseline:{id:'synthetic-baseline',generatedAt:'2026-10-24T11:55:00Z',slots:Array.from({length:100},(_,i)=>({start:new Date(Date.parse('2026-10-24T22:00Z')+i*QUARTER).toISOString(),price:2+Math.sin(i/10)*.2,published:false}))}};
}
Deno.test('residual study stores genuine baseline and prospective features before it can fit; preserves all 100 DST quarters',()=>{
 const source=input(),before=structuredClone(source),out=buildPriceCorrection(source);
 assertEquals(out.status,'unavailable');assertEquals(out.fit,null);assertEquals(out.targets.length,100);
 assertEquals(out.targets.every(row=>row.features?.length===13&&row.corrected===null),true);
 assertEquals(out.targets.map(row=>row.baseline),source.baseline.slots.map(row=>row.price));
 assertEquals(out.targets[0].features!.slice(-2),[8000,12000]);assertEquals(source,before);assertEquals(buildPriceCorrection(source),out);
});
Deno.test('learns actual-minus-frozen-forecast residuals and adds them without replacing or clipping the baseline',()=>{
 const source=input(),features=buildPriceCorrection(source).targets[0].features!;
 source.training=[{runId:'prior',origin:'2026-10-23T12:00Z',start:'2026-10-25T01:00Z',leadDay:2,baseline:5,features,actual:1,truthSequence:19}];
 const out=buildPriceCorrection(source);assertEquals(out.status,'paired');assertEquals(out.fit!.featureNames,CORRECTION_FEATURE_NAMES);
 assertEquals(out.fit!.training.targetDays,1);assertEquals(out.targets[0].corrected,-2); // Future delivery is already published truth, not future knowledge.
 assertEquals(source.baseline.slots[0].price,2);
});
Deno.test('repeated origins do not multiply one target and lead; latest original forecast example wins deterministically',()=>{
 const source=input(),features=buildPriceCorrection(source).targets[0].features!;
 const first={runId:'a',origin:'2026-10-22T12:00Z',start:'2026-10-23T12:00Z',leadDay:1,baseline:2,features,actual:1,truthSequence:10};
 const latest={...first,runId:'b',origin:'2026-10-23T00:00Z',baseline:1.5};source.training=[first,latest];
 const result=buildPriceCorrection(source);assertEquals(result.fit!.training.quarters,1);assertAlmostEquals(result.targets[0].corrected!,1.5);
 source.training.reverse();assertEquals(buildPriceCorrection(source),result);
 source.training.push({...first,leadDay:2});assertEquals(buildPriceCorrection(source).fit!.training.quarters,2);
});
Deno.test('unavailable generation or native demand extrema stay missing, and published prices never get corrections',()=>{
 const source=input();source.load!.intervals=source.load!.intervals.filter(row=>row.businessType==='A60');
 assertEquals(buildPriceCorrection(source).targets.every(row=>row.features===null),true);
 const complete=input();complete.load!.intervals.push({...complete.load!.intervals[0],value:9999});
 assertEquals(buildPriceCorrection(complete).targets.every(row=>row.features===null),true);
 const missing=input();missing.generation=null;assertEquals(buildPriceCorrection(missing).targets.every(row=>row.features===null),true);
 const published=input();published.baseline.slots[0].published=true;assertEquals(buildPriceCorrection(published).targets[0].features,null);
 const outside=input();outside.baseline.slots[0].start='2026-11-01T00:00Z';assertEquals(buildPriceCorrection(outside).targets[0].features,null);
});
Deno.test('different prospective demand changes its features; missing and late truth cannot silently enter a fit',()=>{
 const source=input(),first=buildPriceCorrection(source);source.load!.intervals[0].value=7000;
 assertNotEquals(buildPriceCorrection(source).targets[0].features,first.targets[0].features);
 source.training=[{runId:'late',origin:'2026-10-23T12:00Z',start:'2026-10-24T12:00Z',leadDay:1,baseline:2,features:first.targets[0].features!,actual:1,truthSequence:21}];
 assertThrows(()=>buildPriceCorrection(source),Error,'training example');
 source.training[0].truthSequence=20;source.training[0].origin=ORIGIN;assertThrows(()=>buildPriceCorrection(source),Error,'training example');
});
