import { loadCase, type BenchRecorded, type BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import { caseHousehold } from "../src/lib/planner-bench/household.ts";
import { LANES, laneParts, toldCase, type LaneId } from "../src/lib/planner-bench/lanes.ts";
import type { CriteriaOverrides } from "../src/lib/planner-bench/types.ts";
import { benchInputHash, type LoadedPlanner } from "./execution.ts";

export const BENCH_PROJECT = "vxqpgbzseckgceopitpm";
export const BENCH_URL = `https://${BENCH_PROJECT}.supabase.co`;
export const BENCH_TOKEN_HEADER = "x-planner-bench-token";

export function benchWorkerToken() {
  return Deno.env.get("PLANNER_BENCH_EDGE_TOKEN");
}

export interface VersionIdentity {
  sha: string;
  planner_version: string;
  generation: LoadedPlanner["generation"];
}

export interface VersionInput {
  dataset: BenchScenarioData;
  recorded: BenchRecorded;
  rules: CriteriaOverrides;
  lane: LaneId;
}

export function serveBenchVersion(identity: VersionIdentity, load: () => Promise<LoadedPlanner>) {
  let loaded: Promise<LoadedPlanner> | undefined;
  Deno.serve(async request => {
    if (Deno.env.get("SUPABASE_URL") !== BENCH_URL) return Response.json({ error: "test_only" }, { status: 403 });
    const token = benchWorkerToken();
    if (!token || request.headers.get(BENCH_TOKEN_HEADER) !== token) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    try {
      const { dataset, recorded, rules, lane } = await request.json() as VersionInput;
      if (!LANES.includes(lane)) return Response.json({ error: "invalid_lane" }, { status: 400 });
      const c = loadCase(dataset, recorded);
      const planner = await (loaded ??= load());
      if (planner.generation !== identity.generation) throw new Error("Packaged planner generation differs from manifest");
      const input_hash = await benchInputHash(c, identity.generation, lane, rules);
      const { record, cpuMs } = planner.plan(toldCase(c, lane), caseHousehold(c), laneParts(lane).scale, rules);
      return Response.json({ ...identity, input_hash, record, cpu_ms: Math.round(cpuMs) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
    }
  });
}
