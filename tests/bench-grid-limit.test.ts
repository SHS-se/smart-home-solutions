// Independently generated synthetic configuration and demand; no household replay data.
import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { homeImportLimitW } from "../bench/grid-limit.ts";
import { readyProblem } from "../bench/wasm-planner.ts";
import { canonicalJson, CaseFormatError, loadCase, sha256 } from "../src/lib/planner-bench/case.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { caseHousehold, HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { plan, quarters, world } from "../src/lib/planner-bench/world.fixture.ts";
import type { PlanRecord } from "../src/lib/planner-bench/types.ts";

const source = { url: "https://bench.invalid", key: "test-key", homeId: "synthetic-home" };
const questions = [{ id: "q-fuse", semantic_key: "main_fuse_a" }, { id: "q-limit", semantic_key: "grid_import_limit_kw" }];

Deno.test("bench captures the saved import limit below the fuse and changes case identity when it changes", async () => {
  const original = globalThis.fetch;
  let chosenKw: unknown = 15;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assertEquals(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    if (url.pathname === "/rest/v1/home_questions") {
      assertEquals(url.searchParams.get("semantic_key"), "in.(main_fuse_a,grid_import_limit_kw)");
      return Response.json(questions);
    }
    assertEquals(url.pathname, "/rest/v1/home_answers");
    assertEquals(url.searchParams.get("home_id"), "eq.synthetic-home");
    assertEquals(url.searchParams.get("question_id"), "in.(q-fuse,q-limit)");
    return Response.json([
      { question_id: "q-fuse", answer_value: "25", answer_text: null },
      { question_id: "q-limit", answer_value: chosenKw, answer_text: null },
    ]);
  };
  try {
    const before = { ...world(), grid_import_limit_w: await homeImportLimitW(source) };
    assertEquals(before.grid_import_limit_w, 15_000);
    chosenKw = 14;
    const after = { ...before, grid_import_limit_w: await homeImportLimitW(source) };
    assertEquals(after.grid_import_limit_w, 14_000);
    assertNotEquals(await sha256(canonicalJson(before)), await sha256(canonicalJson(after)));
    const captured = loadCase(JSON.parse(JSON.stringify(before)), before.recorded);
    assertEquals(readyProblem(captured, caseHousehold(captured), {}).limits.import_w, 15_000);
    assertEquals(HOUSEHOLD.site.import_limit_w, 17_200, "capture must not mutate the shared equipment basis");
    chosenKw = 30;
    assertEquals(await homeImportLimitW(source), 17_250, "the fuse still caps an owner's higher choice");
    chosenKw = null;
    assertEquals(await homeImportLimitW(source), 17_250, "an unset optional reduction follows the live profile semantics");
  } finally { globalThis.fetch = original; }
});

Deno.test("missing home configuration and failed reads never select the fixed bench limit", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json([]);
    await assertRejects(() => homeImportLimitW(source), Error, "no configured main fuse");
    for (const failAt of ["home_questions", "home_answers"]) {
      globalThis.fetch = async input => String(input).includes(`/rest/v1/${failAt}?`)
        ? new Response("denied", { status: 403 }) : Response.json(questions);
      await assertRejects(() => homeImportLimitW(source), Error, "403 denied");
    }
    for (const limit of [null, undefined, 0, -1, Number.NaN]) {
      assertThrows(() => caseHousehold({ grid_import_limit_w: limit }), CaseFormatError, "Grid import limit");
    }
  } finally { globalThis.fetch = original; }
});

Deno.test("evaluation rejects synthetic scheduled draw above the captured limit even below the bench's former limit", () => {
  const c = { ...world({ load: () => 2000, start: { ev: { soc: 0.3 } } }), grid_import_limit_w: 15_000 };
  const record: PlanRecord = {
    status: "planned", generation: "test", valuation: { scale: 1, pool: "none", ev: "none", battery: "none" },
    decisions: plan({ pool: i => i === 0 ? 3764 : 0, ev: i => i === 0 ? 11040 : 0 }),
    beliefs: { import_sek_per_kwh: quarters(() => 1), grid_cost_sek: null }, curves: [],
  };
  const strict = evaluate(c, record, {});
  assert(strict.series.gridImportW[0] > 15_000 && strict.series.gridImportW[0] < 17_200);
  assert(strict.outcome.violations.some(v => v.quarter === 0 && v.kind === "grid_limit"));
  const higher = evaluate({ ...c, grid_import_limit_w: 17_200 }, record, {});
  assert(!higher.outcome.violations.some(v => v.kind === "grid_limit"));
  assertThrows(() => evaluate({ ...c, grid_import_limit_w: null }, record, {}), CaseFormatError);
});
