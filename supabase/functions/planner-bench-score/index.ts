import { loadCase } from "../../../src/lib/planner-bench/case.ts";
import { evaluate } from "../../../src/lib/planner-bench/evaluate.ts";
import { LANES } from "../../../src/lib/planner-bench/lanes.ts";
import { BENCH_TOKEN_HEADER, BENCH_URL, benchWorkerToken, type VersionInput } from "../../../bench/edge-version.ts";
import type { PlanRecord } from "../../../src/lib/planner-bench/types.ts";

Deno.serve(async request => {
  if (Deno.env.get("SUPABASE_URL") !== BENCH_URL) return Response.json({ error: "test_only" }, { status: 403 });
  const token = benchWorkerToken();
  if (!token || request.headers.get(BENCH_TOKEN_HEADER) !== token) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  try {
    const { dataset, recorded, rules, lane, record } = await request.json() as VersionInput & { record: PlanRecord };
    if (!LANES.includes(lane)) return Response.json({ error: "invalid_lane" }, { status: 400 });
    return Response.json(evaluate(loadCase(dataset, recorded), record, rules, lane));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
});
