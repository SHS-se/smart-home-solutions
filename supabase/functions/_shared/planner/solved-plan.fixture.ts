import { generateOptimisationPlanWithBatteryProjection, type OptimisationResult } from "./energy-optimisation.ts";

const solved = new Map<string, OptimisationResult>();

/**
 * Tests only: `generateOptimisationPlanWithBatteryProjection`, solving each
 * distinct argument list once per test file. The planner is deterministic in
 * its arguments and a 288-quarter solve takes about a second, so reference
 * plans that several tests compare against are shared. Every caller gets its
 * own copy, so a test may mutate what it receives. A custom auction solver is
 * never cached.
 */
export function solvedPlan(
  ...args: Parameters<typeof generateOptimisationPlanWithBatteryProjection>
): OptimisationResult {
  if (args[5]) return generateOptimisationPlanWithBatteryProjection(...args);
  const key = JSON.stringify(args);
  let result = solved.get(key);
  if (!result) {
    result = generateOptimisationPlanWithBatteryProjection(...args);
    solved.set(key, result);
  }
  return structuredClone(result);
}
