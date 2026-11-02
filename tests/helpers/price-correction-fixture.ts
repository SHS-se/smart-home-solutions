/** Independently generated synthetic research forecasts; no household capture. */
import type { PriceCorrectionInput } from '../../supabase/functions/_shared/price-correction.ts';
import { PRICE_PAIR_GENERATION_MODELS } from '../../supabase/functions/_shared/price-pair.ts';
import type { GenerationMixForecast, GenerationModels } from '../../supabase/functions/_shared/generation-mix.ts';
import type { EntsoeInterval } from '../../supabase/functions/_shared/entsoe-market-data.ts';
export const CORRECTION_ORIGIN='2026-10-24T12:00:00Z', HOUR=3_600_000, QUARTER=900_000;
export function correctionInput(): PriceCorrectionInput {
 const start=Date.parse(CORRECTION_ORIGIN);
 const generation: GenerationMixForecast={algorithm:'se3-generation-analog-v2',zone:'SE3',origin:CORRECTION_ORIGIN,
  hours:Array.from({length:72},(_,i)=>({start:new Date(start+i*HOUR).toISOString(),byPsr:Object.fromEntries(PRICE_PAIR_GENERATION_MODELS.map(({psrType,model},index)=>{
   const models=Object.fromEntries(['calendar','weather','hydro_state','nuclear_ratio','nuclear_delta','published','persistence'].map(name=>[name,{status:'unavailable',reason:'unused'}])) as GenerationModels;
   models[model]={status:'predicted',mw:100+index*10+i,trainingSamples:10,latestTrainingEnd:CORRECTION_ORIGIN};return [psrType,models];
  }))})),training:{},diagnostics:{actuals:{completeHours:0,productionIntervals:0,reason:null},weather:{status:'available',reason:null,issueTime:null},published:{completeHours:0,productionIntervals:0,reason:null}}};
 const intervals:EntsoeInterval[]=['A60','A61'].map((businessType,i)=>({startMs:Date.parse('2026-10-24T22:00Z'),endMs:Date.parse('2026-10-25T23:00Z'),value:8000+i*4000,businessType,resolution:'P1D',unit:'MAW',psrType:null,seriesId:businessType,flow:'consumption'}));
 return {knownAt:CORRECTION_ORIGIN,truthCutoff:20,generationRunId:'synthetic-mix',generation,load:{id:'synthetic-load',intervals},training:[],
  baseline:{id:'synthetic-baseline',generatedAt:'2026-10-24T11:55:00Z',slots:Array.from({length:100},(_,i)=>({start:new Date(Date.parse('2026-10-24T22:00Z')+i*QUARTER).toISOString(),price:2+Math.sin(i/10)*.2,published:false}))}};
}
