import { assertEquals } from "@std/assert";
import { fuseLimitKw, fuseLimitW, gridImportLimitW, mainFuseA, readHomeGridImportLimitW } from "./home-grid-limit.ts";

Deno.test("a fuse's limit is three phases at 230 V, shown without rounding above the fuse", () => {
  assertEquals(fuseLimitW(25), 17_250);
  assertEquals([16, 20, 25, 35, 50, 63].map(fuseLimitKw), [11, 13.8, 17.2, 24.1, 34.5, 43.4]);
});

Deno.test("only a fuse the questionnaire offers is a fuse", () => {
  assertEquals(mainFuseA("25"), 25);
  assertEquals(mainFuseA(25), 25);
  for (const answer of ["", null, undefined, "40", "__other:32", true, 0]) assertEquals(mainFuseA(answer), null);
});

Deno.test("the owner can lower the fuse's limit and never raise it", () => {
  assertEquals(gridImportLimitW(25, 15), 15_000);
  assertEquals(gridImportLimitW(25, "15.5"), 15_500);
  assertEquals(gridImportLimitW(25, 17.2), 17_200);
  assertEquals(gridImportLimitW(25, 30), 17_250);
  for (const unset of [null, undefined, "", " ", 0, -4, "many", Number.NaN]) assertEquals(gridImportLimitW(25, unset), 17_250);
});

function store(answers: Record<string, unknown>) {
  const questions = [{ id: "q-fuse", semantic_key: "main_fuse_a" }, { id: "q-limit", semantic_key: "grid_import_limit_kw" }];
  const rows = questions.filter((q) => q.semantic_key in answers)
    .map((q) => ({ question_id: q.id, answer_value: answers[q.semantic_key], answer_text: null }));
  return { from: (table: string) => ({ select: () => ({
    in: () => Promise.resolve({ data: questions, error: null }),
    eq: (_column: string, home: string) => ({ in: () => Promise.resolve({ data: home === "home" && table === "home_answers" ? rows : [], error: null }) }),
  }) }) };
}

Deno.test("the planner's limit is read from the home profile, and is absent until the fuse is answered", async () => {
  assertEquals(await readHomeGridImportLimitW(store({ main_fuse_a: "25", grid_import_limit_kw: 15 }), "home"), 15_000);
  assertEquals(await readHomeGridImportLimitW(store({ main_fuse_a: "25" }), "home"), 17_250);
  assertEquals(await readHomeGridImportLimitW(store({ grid_import_limit_kw: 15 }), "home"), null);
  assertEquals(await readHomeGridImportLimitW(store({ main_fuse_a: "25" }), "other-home"), null);
});
