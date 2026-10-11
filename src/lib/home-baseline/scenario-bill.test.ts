import { assertAlmostEquals, assertThrows } from '@std/assert';
import { scenarioBill } from './scenario-bill';
import { testTariff } from './fixture';
import { emptyElectricityLedger } from './ledger';
Deno.test('full modeled costs add Tibber and grid fixed fees once, preserving signed export income', () => {
 const start='2026-08-31T22:00:00Z', end='2026-09-30T22:00:00Z';
 const ledger={...emptyElectricityLedger(),costSek:-20,exportRevenueSek:20};
 const b=scenarioBill(ledger,start,end,'Europe/Stockholm',Array(2880).fill(0),testTariff());
 assertAlmostEquals(b.supplierFixedSek,49); assertAlmostEquals(b.gridFixedSek,740); assertAlmostEquals(b.totalSek,769);
 assertThrows(()=>scenarioBill(ledger,start,end,'Europe/Stockholm',[0],testTariff()));
});
Deno.test('peak billing uses top three distinct local days and weighted night peaks, like HA', () => {
 const tariff=testTariff(); const plan=tariff.profiles[0].versions[0].definition.plans.three_phase;
 plan.demand={top_n:3,distinct_local_days:true,night_start_hour:22,night_end_hour:6,night_factor:.5,rate_sek_per_kw_ex_vat:65};
 const watts=Array(2880).fill(0);
 const set=(day:number,hour:number,kw:number)=>{for(let q=0;q<4;q++)watts[day*96+hour*4+q]=kw*1000;};
 set(0,12,12);set(0,13,11);set(1,12,10);set(2,12,8);set(3,0,14);
 const b=scenarioBill(emptyElectricityLedger(),'2026-08-31T22:00:00Z','2026-09-30T22:00:00Z','Europe/Stockholm',watts,tariff);
 assertAlmostEquals(b.peakKw,10);assertAlmostEquals(b.gridPeakSek,812.5);
});
Deno.test('frames crossing calendar months prorate each fixed fee using its own month length',()=>{
 const b=scenarioBill(emptyElectricityLedger(),'2026-08-30T22:00:00Z','2026-09-02T22:00:00Z','Europe/Stockholm',Array(288).fill(0),testTariff());
 assertAlmostEquals(b.supplierFixedSek,49*(1/31+2/30));assertAlmostEquals(b.gridFixedSek,740*(1/31+2/30));
});
