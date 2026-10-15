import { assertEquals } from "@std/assert";
import { readPlannerLocation, withPlannerLocation } from "./home-planning-location.ts";
import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
function database(address:string,cache:unknown=null){const writes:unknown[]=[];return {writes,from(table:string){return {
 async single(){return {data:{address_text:address},error:null};},select(){return this;},eq(){return this;},async maybeSingle(){return {data:table==="homes"?{address_text:address}:cache,error:null};},
 async upsert(row:unknown){writes.push(row);return {error:null};}};}};}
Deno.test("the planner address controls location and invalidates the derived location after an address edit",async()=>{
 const db=database("New installation",{address_text:"Old installation",latitude:1,longitude:2});let calls=0;
 const location=await readPlannerLocation(db,"home",{fetchImpl:async()=>{calls++;return new Response(JSON.stringify({features:[{geometry:{coordinates:[18,59]}}]}));}});
 assertEquals(location.coordinates,{latitude:59,longitude:18});assertEquals(calls,1);assertEquals(db.writes.length,1);
 const source=commandSnapshot();source.location={latitude:5,longitude:6};source.sources.pv!.location={latitude:7,longitude:8};
 const snapshot=withPlannerLocation(source,location);
 assertEquals(snapshot.location,{latitude:59,longitude:18});
 assertEquals(snapshot.sources.pv!.location,{latitude:7,longitude:8},"provider evidence is not relabelled");
});
Deno.test("a cached address avoids a provider read and an unresolved address is warning-only",async()=>{
 const cached=database("Address",{address_text:"Address",latitude:59,longitude:18});
 assertEquals((await readPlannerLocation(cached,"home",{fetchImpl:()=>{throw new Error("not called");}})).coordinates,{latitude:59,longitude:18});
 const result=await readPlannerLocation(database(""),"home");
 assertEquals(result.coordinates,null);assertEquals(result.warnings.length,1);
});
