import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { homeComfortTargets } from "../bench/comfort.ts";
import { readyProblem } from "../bench/wasm-planner.ts";
import { canonicalJson, caseTargets, CaseFormatError, sha256 } from "../src/lib/planner-bench/case.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { world, plan, quarters } from "../src/lib/planner-bench/world.fixture.ts";
import type { PlanRecord } from "../src/lib/planner-bench/types.ts";

const source = { url: "https://bench.invalid", key: "test-key", homeId: "history-home" };

Deno.test("bench reads the history home's current preferences on each planning run", async () => {
  const original = globalThis.fetch;
  let pool = 30;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assertEquals(url.pathname, "/rest/v1/energy_optimisation_comfort_targets");
    assertEquals(url.searchParams.get("home_id"), "eq.history-home");
    assertEquals(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    return Response.json([{ pool_target_c: pool, ev_target_km: 350, ev_floor_soc: 30 }]);
  };
  try {
    const before = { ...world(), comfort: await homeComfortTargets(source) };
    pool = 30.5;
    const after = { ...before, comfort: await homeComfortTargets(source) };
    assertEquals(caseTargets(after), { pool_c: 30.5, ev_km: 350, ev_floor_soc: .3 });
    // The dataset is part of the runner's input hash: changed targets require replanning.
    assertNotEquals(await sha256(canonicalJson(before)), await sha256(canonicalJson(after)));
    assertEquals(after.start_state, before.start_state, "a preference is separate from measured starting state");
    const prepared=readyProblem(after,HOUSEHOLD,{});
    assertEquals(prepared.targets.pool_c,30.5);
    const record: PlanRecord = {
      status: "ready", generation: "test", valuation: { scale: 1, pool: "none", ev: "none", battery: "none" },
      decisions: plan(), beliefs: { import_sek_per_kwh: quarters(() => 1), grid_cost_sek: null }, curves: [],
    };
    const evaluated = evaluate(after, record, {});
    assertEquals(evaluated.series.comfort!.pool_target_c, 30.5);
  } finally { globalThis.fetch = original; }
});

Deno.test("missing comfort settings and failed reads never silently use bench defaults", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json([]);
    await assertRejects(() => homeComfortTargets(source), Error, "Expected saved comfort preferences");
    globalThis.fetch = async () => Response.json([{ pool_target_c: null, ev_target_km: 300 }]);
    await assertRejects(() => homeComfortTargets(source), CaseFormatError, "Comfort targets are missing");
    globalThis.fetch = async () => new Response("denied", { status: 403 });
    await assertRejects(() => homeComfortTargets(source), Error, "403 denied");
    assertThrows(() => readyProblem({ ...world(), comfort: null },HOUSEHOLD,{}), CaseFormatError);
    assertThrows(() => caseTargets({ comfort: { pool_c: 30.5 } }), CaseFormatError);
  } finally { globalThis.fetch = original; }
});
