import { assert, assertEquals } from "@std/assert";
import { loadPlanner } from "../bench/adapter.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { causalCase } from "./planner-wasm.fixture.ts";
Deno.test("native benchmark commands replay against the independent household",async()=>{
  const planner=await loadPlanner(new URL("..",import.meta.url).pathname);
  const c=causalCase();const {record}=planner.plan(c,HOUSEHOLD);
  assertEquals(record.status,"planned");assertEquals(record.curves,[]);
  const {series}=evaluate(c,record,{});
  assert(series.poolC.every(c=>c===null||Number.isFinite(c)));
  assert(record.planner_rules);assert(record.planner_criteria);
});
