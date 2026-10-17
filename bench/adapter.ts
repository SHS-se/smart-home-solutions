/** Run only a requested commit's native rules planner. */
import type { BenchCase } from "../src/lib/planner-bench/case.ts";
import type { Household } from "../src/lib/planner-bench/household.ts";
import type { CriteriaOverrides, PlanRecord } from "../src/lib/planner-bench/types.ts";
import { diskTree } from "../scripts/module-graph.ts";
import { usesRulePlanner } from "./planner-version.ts";
import { plannerCriteriaFingerprint, plannerInputsFingerprint } from "../src/lib/planner-bench/score.ts";
export const ADAPTER_VERSION = 10;
export interface LoadedPlanner {
  generation: "ready-wasm-v2" | "ready-wasm-v3" | "ready-wasm-v4" | "ready-wasm-v5" | "ready-wasm-v6" | "ready-wasm-v7" | "ready-wasm-v8" | "ready-wasm-v9";
  /** `scale` multiplies what the planner's value curves are worth (lanes.ts); 1 is the planner as it runs live. */
  plan(c: BenchCase, household: Household, scale?: number, criteria?: CriteriaOverrides): { record: PlanRecord; cpuMs: number };
}

export async function loadPlanner(root: string): Promise<LoadedPlanner> {
  if (usesRulePlanner(diskTree(root))) {
    // Load both forecast preparation and frozen Wasm from the requested commit,
    // never the harness's current engine or a substitute on failure.
    const candidate: typeof import("./wasm-planner.ts") = await import(
      `file://${root}/bench/wasm-planner.ts`
    );
    const planner = await candidate.loadWasmCandidate(root);
    return {
      // Historical bench engines carry and load their own committed wire codec.
      generation: planner.version.startsWith("wasm-v9:") ? "ready-wasm-v9" : planner.version.startsWith("wasm-v8:") ? "ready-wasm-v8" : planner.version.startsWith("wasm-v7:") ? "ready-wasm-v7" : planner.version.startsWith("wasm-v6:") ? "ready-wasm-v6" : planner.version.startsWith("wasm-v5:") ? "ready-wasm-v5" : planner.version.startsWith("wasm-v4:") ? "ready-wasm-v4" : planner.version.startsWith("wasm-v3:") ? "ready-wasm-v3" : "ready-wasm-v2",
      plan(c, household, scale = 1, criteria = {}) {
        const p = candidate.readyProblem(c, household, criteria);
        // Planners from before hot water was planned take no second argument and leave the heater as the house ran it.
        const result = planner.plan(p, candidate.hotWaterContext?.(c, household) ?? null);
        return {
          record: {
            ...result.record,
            planner_rules: plannerInputsFingerprint(p.rules, p.service_guard),
            planner_criteria: plannerCriteriaFingerprint(criteria),
            valuation: { scale, pool: "none", ev: "none", battery: "none" },
          },
          cpuMs: result.elapsed_ms,
        };
      },
    };
  }
  throw new Error("This commit has no supported native rules planner artifact.");
}
