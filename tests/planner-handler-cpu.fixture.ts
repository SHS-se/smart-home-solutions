import fixture from "./planner-handler-cpu.fixture.json" with { type: "json" };
import type { OptimisationSnapshot } from "../supabase/functions/_shared/planner/planning-contracts.ts";
import { prepareRulesPlanningInput } from "../supabase/functions/_shared/rules-planner.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";

/** Full household and service-window complexity; no customer or entity identifiers. */
export function cpuPlanningInput() {
  const snapshot = structuredClone(fixture.snapshot) as OptimisationSnapshot;
  return prepareRulesPlanningInput({ snapshot, now: fixture.now,
    resolved_price_outlook: fixture.resolved_price_outlook }, null, resolveRulePolicy());
}
