import { assert, assertEquals, assertRejects } from "@std/assert";
import { DbStore, LocalStore, type EvaluatedResult } from "../bench/store.ts";

Deno.test("database rescore reads every result beyond 1000, with stable ordering and server-capped pages", async () => {
  const original = globalThis.fetch;
  const rows: EvaluatedResult[] = Array.from({ length: 1203 }, (_, i) => ({
    sha: String(i).padStart(5, "0"), scenario_id: "case", lane: "told/nominal",
    status: i % 11 ? "ok" : "error", error: i % 11 ? null : "planner failed", score: null, referee_version: null,
  }));
  const offsets: number[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assertEquals(url.pathname, "/rest/v1/bench_result_summaries");
    assertEquals(url.searchParams.get("order"), "sha,scenario_id,lane");
    assertEquals(url.searchParams.get("status"), null, "prior planner failures remain visible");
    assertEquals(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    // Simulate an installation with a lower row cap than the requested limit.
    return Response.json(rows.slice(offset, offset + 137));
  };
  try {
    assertEquals(await new DbStore("https://bench.invalid", "test-key").evaluatedResults(), rows);
    assertEquals(offsets, [0, 137, 274, 411, 548, 685, 822, 959, 1096, 1203]);
  } finally { globalThis.fetch = original; }
});

Deno.test("rescore scenario reads can distinguish archived cases without changing ordinary runner filtering", async () => {
  const original = globalThis.fetch;
  const queries: URL[] = [];
  globalThis.fetch = async input => {
    queries.push(new URL(String(input)));
    return Response.json([]);
  };
  try {
    const store = new DbStore("https://bench.invalid", "test-key");
    await store.scenarios();
    await store.scenarios("a case", true);
    assertEquals(queries[0].searchParams.get("archived"), "eq.false");
    assertEquals(queries[1].searchParams.get("archived"), null);
    assertEquals(queries[1].searchParams.get("id"), "eq.a case");
    assert(queries.every(query => query.searchParams.get("select")?.includes("archived")));
  } finally { globalThis.fetch = original; }
});

Deno.test("a malformed local result file fails instead of appearing to be an empty bench", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bench-corrupt-store-" });
  try {
    const out = `${dir}/results.json`;
    await Deno.writeTextFile(out, "{not json");
    await assertRejects(() => new LocalStore(dir, out).evaluatedResults(), SyntaxError);
  } finally { await Deno.remove(dir, { recursive: true }); }
});
