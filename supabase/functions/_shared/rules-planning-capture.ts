import type { EnergyPlanningInput } from "./planner/planning-contracts.ts";
import type { ReadyRulePolicy } from "./planner-wasm/rule-policy.ts";
import type { PublishedCommandReference } from "./rules-planner.ts";
import { RULES_MODEL_VERSION } from "./rules-planner-identity.ts";

export type RulesPlanningSource = Omit<EnergyPlanningInput, "price_archive"> & {
  price_archive?: EnergyPlanningInput["price_archive"];
};
/** Detached, unsolved domain input. No room schedules or native search state. */
export type CapturedRulesInput = RulesPlanningSource & {
  reference: PublishedCommandReference | null;
  independent_references?: {battery: PublishedCommandReference | null};
  approved_policy: ReadyRulePolicy;
  model_version: string;
};

/** Capture only: the worker owns validation, commitment compilation and all search. */
export function captureRulesPlanningInput(input: RulesPlanningSource,
  reference: PublishedCommandReference | null, approved: ReadyRulePolicy,
  independent?: {battery: PublishedCommandReference | null}): CapturedRulesInput {
  return structuredClone({ ...input, execution_replan: input.execution_replan ?? null,
    reference, ...(independent ? {independent_references: independent} : {}), approved_policy: approved, model_version: RULES_MODEL_VERSION });
}
