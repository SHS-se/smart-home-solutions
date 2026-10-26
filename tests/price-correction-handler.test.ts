import { assertEquals } from '@std/assert';
import { createPriceCorrectionHandler, type CorrectionStore } from '../supabase/functions/energy-price-correction-experiment/index.ts';
const TEST='https://vxqpgbzseckgceopitpm.supabase.co';
Deno.test('correction worker rejects production and unauthorized requests before reading evidence',async()=>{
 let reads=0;const store:CorrectionStore={async verifyToken(token){return token==='test';},async begin(){reads++;return null;},async complete(){throw new Error('unexpected');}};
 const request=()=>new Request('http://localhost',{method:'POST',headers:{'x-energy-market-archive-token':'test'}});
 assertEquals((await createPriceCorrectionHandler('https://production.example',store)(request())).status,403);
 assertEquals((await createPriceCorrectionHandler(TEST,store)(new Request('http://localhost'))).status,405);
 assertEquals((await createPriceCorrectionHandler(TEST,store)(new Request('http://localhost',{method:'POST'}))).status,401);
 assertEquals(reads,0);assertEquals(await (await createPriceCorrectionHandler(TEST,store)(request())).json(),{status:'no_household_forecast'});assertEquals(reads,1);
});
Deno.test('correction worker does not expose database exception details',async()=>{
 const store:CorrectionStore={async verifyToken(){throw new Error('credential-bearing error');},async begin(){return null;},async complete(){}};
 const response=await createPriceCorrectionHandler(TEST,store)(new Request('http://localhost',{method:'POST',headers:{'x-energy-market-archive-token':'test'}}));
 assertEquals(response.status,500);assertEquals(await response.json(),{error:'test_price_correction_failed'});
});
