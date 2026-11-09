import { assert, assertEquals, assertRejects } from "@std/assert";
import { EdgeBench } from "../bench/edge-runner.ts";
import { benchInputHash } from "../bench/execution.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { BASE_LANE, toldCase } from "../src/lib/planner-bench/lanes.ts";
import { caseHousehold } from "../src/lib/planner-bench/household.ts";
import { loadPlanner } from "../bench/adapter.ts";
import { causalCase } from "./planner-wasm.fixture.ts";

Deno.test("Edge verification checks a complete case against its pinned Actions result", async () => {
  const sha = "a".repeat(40), id = "00000000-0000-0000-0000-000000000000";
  const c = causalCase(), { recorded, ...dataset } = c;
  const planner = await loadPlanner(new URL("..", import.meta.url).pathname);
  const generation = planner.generation;
  const record = planner.plan(toldCase(c, BASE_LANE), caseHousehold(c)).record;
  const expected = evaluate(c, record, {});
  const hash = await benchInputHash(c, generation, BASE_LANE, {});
  let evidence = 0;
  let wrongInput = false;
  const fetcher = ((url: string, init: RequestInit) => {
    const pathname = new URL(url).pathname;
    switch (pathname) {
      case "/rest/v1/bench_edge_artifacts":
        return Response.json([{ sha, worker: `bench-${sha}`, planner_version: "pinned", generation, bundle_hash: "bundle" }]);
      case "/rest/v1/bench_scenarios": return Response.json([{ id, revision: "revision", dataset, recorded }]);
      case "/rest/v1/bench_rules": return Response.json([{ criteria: {} }]);
      case "/rest/v1/bench_results":
        assertEquals(init.method, undefined);
        return Response.json([{ ...expected, record, input_hash: hash, status: "ok", case_revision: "revision" }]);
      case `/functions/v1/bench-${sha}`:
        assertEquals(JSON.parse(String(init.body)).lane, BASE_LANE);
        return Response.json({ sha, planner_version: "pinned", generation, input_hash: wrongInput ? "stale" : hash, record });
      case "/functions/v1/planner-bench-score": return Response.json(expected);
      case "/rest/v1/rpc/bench_record_edge_parity":
        evidence++;
        return Response.json(true);
      default: throw new Error(pathname);
    }
  }) as typeof fetch;
  const runner = new EdgeBench("synthetic", "synthetic", fetcher);
  assert(Object.values((await runner.verify(sha, id)).matches).every(Boolean));
  assertEquals(evidence, 1);
  wrongInput = true;
  await assertRejects(() => runner.verify(sha, id), Error, "different executable or case input");
  assertEquals(evidence, 1);
});
