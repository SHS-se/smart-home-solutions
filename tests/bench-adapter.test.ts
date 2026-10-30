import { assert, assertEquals } from "@std/assert";
import { loadPlanner } from "../bench/adapter.ts";
import { HOUSEHOLD, caseHousehold } from "../src/lib/planner-bench/household.ts";
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

Deno.test("native bench planning respects the captured 15 kW limit with competing synthetic loads", async () => {
  const planner = await loadPlanner(new URL("..", import.meta.url).pathname);
  const c = causalCase();
  c.grid_import_limit_w = 15_000;
  c.base_load_forecast_w.fill(1350);
  c.recorded.actual!.base_load_w.fill(1350);
  // Below its floor from the start, so the car wants the grid beside the pool.
  c.start_state.ev.soc = .1;
  const { record } = planner.plan(c, caseHousehold(c));
  assertEquals(record.status, "planned");
  const { series } = evaluate(c, record, {});
  assert(series.carW.some(w => w > 0));
  assert(series.poolW.some(w => w > 0));
  assert(Math.max(...series.gridImportW) <= 15_000 + 0.1);
});
