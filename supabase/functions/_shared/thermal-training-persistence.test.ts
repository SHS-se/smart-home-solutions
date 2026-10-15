import { assertEquals } from "@std/assert";
import { storeZoneModelRows } from "./thermal-training.ts";
Deno.test("a failed room refit updates diagnostics without erasing the last usable parameters",async()=>{
 const rows=new Map<string,Record<string,unknown>>([["room",{home_id:"home",room_key:"room",trained:true,gain_c_per_wh:.001,
 fitted_at:"previous-fit",last_fit_attempt:{status:"fitted",issues:[]}}]]);
 const db={from(){return {async upsert(incoming:Record<string,unknown>[],options:{ignoreDuplicates:boolean}){
   for(const row of incoming){const key=String(row.room_key);if(!options.ignoreDuplicates||!rows.has(key))rows.set(key,structuredClone(row));}
   return {error:null};},update(patch:Record<string,unknown>){return {eq(_column:string,key:string){return {async eq(_roomColumn:string,room:string){
     if(key==="home"&&rows.has(room))rows.set(room,{...rows.get(room),...patch});return {error:null};}};}};}};}};
 await storeZoneModelRows(db,[{home_id:"home",room_key:"room",trained:false,gain_c_per_wh:null,fitted_at:"failed-fit",
  last_attempted_at:"attempt",last_fit_attempt:{status:"unidentified",issues:["singular"]}}]);
 assertEquals(rows.get("room")!.gain_c_per_wh,.001);assertEquals(rows.get("room")!.trained,true);
 assertEquals(rows.get("room")!.fitted_at,"previous-fit");
 assertEquals(rows.get("room")!.last_fit_attempt,{status:"unidentified",issues:["singular"]});
});
