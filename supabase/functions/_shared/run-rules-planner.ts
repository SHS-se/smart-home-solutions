/** Browser, replay, fixture and benchmark adapter for the production planner. */
import { buildPriceOutlook } from "./planner/energy-price-shape.ts";
import type { EnergyPlanningInput, OptimisationResult } from "./planner/planning-contracts.ts";
import { resolveRulePolicy, type CriteriaOverrides } from "./planner-wasm/rule-policy.ts";
import type { PublishedCommandReference } from "./rules-planner.ts";
import { captureRulesPlanningInput } from "./rules-planning-capture.ts";
import { executeRulesPlanning } from "./rules-planning-execution.ts";

export function runRulesPlanner(input: EnergyPlanningInput, reference: PublishedCommandReference | null = null,
  criteria?: CriteriaOverrides): OptimisationResult {
  let outlook = input.resolved_price_outlook;
  if (!outlook) {
    const resolved = buildPriceOutlook(input.snapshot.slots, input.price_archive, {
      timeZone: input.snapshot.timezone, asOf: Date.parse(input.snapshot.captured_at), wind: input.snapshot.wind_outlook?.days,
    });
    outlook = { shaped: resolved.shaped, observed_days: resolved.observedDays, effective_days: resolved.effectiveDays,
      level_sek_per_kwh: resolved.levelSekPerKwh, shadow_import_sek_per_kwh: resolved.shadowImportSekPerKwh,
      ...(resolved.levelBasis ? { level_basis: resolved.levelBasis } : {}) };
  }
  return executeRulesPlanning(captureRulesPlanningInput({ ...input, resolved_price_outlook: outlook }, reference, resolveRulePolicy(criteria)));
}
