import { assert, assertEquals, assertRejects } from "@std/assert";
import { DbStore, LocalStore, type EvaluatedResult } from "../bench/store.ts";

const immediate = { now: () => 0, wait: () => Promise.resolve() };

Deno.test("deployment marks remain independent and follow identical planners when runs fold", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bench-deployments-" });
  try {
    const store = new LocalStore(dir, `${dir}/results.json`);
    for (const sha of ["older", "main", "dev"]) {
      await store.saveRun({ sha, short_sha: sha, committed_at: "2026-10-07T00:00:00Z", subject: sha, branch: null, status: "done" });
    }
    await store.markDeployed("main", "production");
    await store.markDeployed("dev", "test");
    await store.mergeRun("main", "older");
    await store.mergeRun("dev", "older");
    assertEquals((await store.runs()).map(run => [run.sha, run.is_current, run.is_test]), [["older", true, true]]);
    await assertRejects(() => store.markDeployed("missing", "production"), Error, "Unknown deployed planner");
    assertEquals((await store.runs()).map(run => [run.is_current, run.is_test]), [[true, true]]);
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("database deployment identity uses one atomic service-role RPC", async () => {
  const original = globalThis.fetch;
  const writes: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    assertEquals(new URL(String(input)).pathname, "/rest/v1/rpc/bench_set_deployed");
    assertEquals(init?.method, "POST");
    writes.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  };
  try {
    const store = new DbStore("https://bench.invalid", "test-key", immediate);
    await store.markDeployed("main-sha", "production");
    await store.markDeployed("dev-sha", "test");
    assertEquals(writes, [{ p_sha: "main-sha", p_environment: "production" }, { p_sha: "dev-sha", p_environment: "test" }]);
  } finally { globalThis.fetch = original; }
});

Deno.test("database rescore reads every result beyond 1000, with stable ordering and server-capped pages", async () => {
  const original = globalThis.fetch;
  const rows: EvaluatedResult[] = Array.from({ length: 1203 }, (_, i) => ({
    sha: String(i).padStart(5, "0"), scenario_id: "case", lane: "told/nominal",
    status: i % 11 ? "ok" : "error", error: i % 11 ? null : "planner failed", score: null, referee_version: null,
    case_revision: null, input_hash: "input", created_at: "2026-10-06T00:00:00Z", has_record: true, has_evaluation: false,
  }));
  const offsets: number[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assertEquals(url.pathname, "/rest/v1/bench_result_summaries");
    assertEquals(url.searchParams.get("order"), "sha,scenario_id,lane");
    assertEquals(url.searchParams.get("status"), null, "prior planner failures remain visible");
    assert(!url.searchParams.get("select")!.split(",").some(field => ["record", "series"].includes(field)));
    assertEquals(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    // Simulate an installation with a lower row cap than the requested limit.
    return Response.json(rows.slice(offset, offset + 137));
  };
  try {
    assertEquals(await new DbStore("https://bench.invalid", "test-key", immediate).evaluatedResults(), rows);
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
    const store = new DbStore("https://bench.invalid", "test-key", immediate);
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

Deno.test("database requests are serial and leave idle time after slow and failed requests", async () => {
  const original = globalThis.fetch;
  let now = 0, calls = 0, active = 0, maxActive = 0;
  const waits: number[] = [];
  globalThis.fetch = async () => {
    maxActive = Math.max(maxActive, ++active);
    await Promise.resolve();
    now += ++calls === 1 ? 800 : 100;
    active--;
    return calls === 2 ? new Response('failed', { status: 500 }) : Response.json([{ criteria: {} }]);
  };
  try {
    const store = new DbStore('https://bench.invalid', 'test-key', {
      now: () => now, wait: ms => { waits.push(ms); now += ms; return Promise.resolve(); },
    });
    const results = await Promise.allSettled([store.rules(), store.rules(), store.rules()]);
    assertEquals(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
    assertEquals(maxActive, 1);
    assertEquals(waits, [800, 250]);
  } finally { globalThis.fetch = original; }
});

Deno.test("source identity filters preserve literal hashes and timestamp offsets without JSON quoting", async () => {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = async input => { urls.push(new URL(String(input))); return Response.json([{ record: { status: 'ready' } }]); };
  try {
    const store = new DbStore('https://bench.invalid', 'test-key', immediate);
    const observed: EvaluatedResult = { sha: 'test', scenario_id: 'case', lane: 'told/nominal',
      status: 'ok', error: null, score: null, referee_version: 1, case_revision: 'case-revision', input_hash: 'hash&literal',
      created_at: '2026-10-06T12:00:00.123456+00:00', has_record: true, has_evaluation: true };
    await store.planRecord(observed);
    assertEquals(urls[0].searchParams.get('input_hash'), 'eq.hash&literal');
    assertEquals(urls[0].searchParams.get('created_at'), 'eq.2026-10-06T12:00:00.123456+00:00');
    await store.planRecord({ ...observed, input_hash: null, created_at: null });
    assertEquals(urls[1].searchParams.get('input_hash'), 'is.null');
    assertEquals(urls[1].searchParams.get('created_at'), 'is.null');
  } finally { globalThis.fetch = original; }
});

Deno.test('pending completion explicitly clears recorded observations in database and local stores', async () => {
  const original = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (_input, init) => { body = JSON.parse(String(init?.body)); return Promise.resolve(new Response(null, { status: 204 })); };
  const dir = await Deno.makeTempDir();
  try {
    await new DbStore('https://bench.invalid', 'test-key', immediate).saveRecorded('case', null, 'measurements incomplete');
    assertEquals(body, { recorded: null, pending_reason: 'measurements incomplete' });
    await Deno.writeTextFile(`${dir}/case.json`, JSON.stringify({ dataset: null, recorded: { stale: true } }));
    await new LocalStore(dir, `${dir}/output`).saveRecorded('case', null, 'measurements incomplete');
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/case.json`)), { dataset: null, recorded: null, pending_reason: 'measurements incomplete' });
  } finally { globalThis.fetch = original; await Deno.remove(dir, { recursive: true }); }
});
