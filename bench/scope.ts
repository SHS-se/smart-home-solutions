import { BASE_LANE, LANES, type LaneId } from "../src/lib/planner-bench/lanes.ts";

/** Alternative solver inputs are explicit diagnostics, never routine work. */
export type BenchScope = "base" | "diagnostics";
export function requiredLanes(scope: string = "base"): readonly LaneId[] {
  if (scope === "base") return [BASE_LANE];
  if (scope === "diagnostics") return [BASE_LANE, ...LANES.filter(l => l !== BASE_LANE)];
  throw new Error(`Unknown bench scope: ${scope}`);
}

/** Environment labels do not expand an explicitly named solve set. */
export function refreshTargets(selection: string, heads: { test?: string; current?: string }, history: readonly string[]): string[] {
  const environments = [heads.test, heads.current].filter((s): s is string => Boolean(s));
  if (selection === "heads" && !environments.length) throw new Error("--shas heads needs --test or --current.");
  const requested = selection.split(",").flatMap(ref => ref === "heads" ? environments
    : ref === "all" ? [...environments, ...history] : [ref]);
  return [...new Set(requested)];
}
