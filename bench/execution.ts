import { canonicalJson, sha256, type BenchCase } from "../src/lib/planner-bench/case.ts";
import { caseHousehold, type Household } from "../src/lib/planner-bench/household.ts";
import { laneParts, type LaneId } from "../src/lib/planner-bench/lanes.ts";
import { plannerCriteriaFingerprint, plannerInputsFingerprint } from "../src/lib/planner-bench/score.ts";
import type { CriteriaOverrides, PlanRecord } from "../src/lib/planner-bench/types.ts";

export const ADAPTER_VERSION = 10;
type Generation = `ready-wasm-v${2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
export interface LoadedPlanner {
  generation: Generation;
  plan(c: BenchCase, household: Household, scale?: number, criteria?: CriteriaOverrides): { record: PlanRecord; cpuMs: number };
}

export function adaptPlanner(candidate: typeof import("./wasm-planner.ts"),
  planner: Awaited<ReturnType<typeof candidate.loadWasmCandidate>>): LoadedPlanner {
  const version = /^wasm-v(10|[2-9]):/.exec(planner.version);
  if (!version) throw new Error("Unsupported native planner generation");
  return {
    generation: `ready-wasm-v${version[1]}` as Generation,
    plan(c, household, scale = 1, criteria = {}) {
      const problem = candidate.readyProblem(c, household, criteria);
      const result = planner.plan(problem, candidate.hotWaterContext?.(c, household) ?? null);
      return {
        record: {
          ...result.record,
          planner_rules: plannerInputsFingerprint(problem.rules, "service_guard" in problem ? problem.service_guard : undefined),
          planner_criteria: plannerCriteriaFingerprint(criteria),
          valuation: { scale, pool: "none", ev: "none", battery: "none" },
        },
        cpuMs: result.elapsed_ms,
      };
    },
  };
}

export function benchInputHash(c: BenchCase, generation: Generation, lane: LaneId, rules: CriteriaOverrides): Promise<string> {
  const { origin: _origin, recorded: { recorded_at: _at, ...recorded }, ...dataset } = c;
  return sha256(canonicalJson({ dataset, recorded, household: caseHousehold(c), adapter: ADAPTER_VERSION,
    generation, lane: laneParts(lane), planner_rules: rules }));
}
