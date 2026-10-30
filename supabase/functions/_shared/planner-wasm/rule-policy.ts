import { PlanningError } from "../planning-errors.ts";
import type { PlannerRuleKey, ReadyProblem } from "./ready-problem.ts";
import { WATER_MINUTES_PER_DAY } from "../hot-water-opportunities.ts";
import { CAR_FLOOR_POINTS } from "./car-policy.ts";

export interface CriterionOverride { enabled?: boolean; threshold?: number; points?: number }
export type CriteriaOverrides = Record<string, CriterionOverride>;
export type ReadyRulePolicy = Pick<ReadyProblem, "rules" | "service_guard">;
type RuleDefault = { threshold: number; points: number; required?: boolean };
/** Comfort policy only. Economic opportunities belong to the bill and audit. */
export const RULE_DEFAULTS: Record<PlannerRuleKey, RuleDefault> = {
  pool_low: { threshold: 1, points: -1 },
  pool_cold: { threshold: 2, points: -1, required: true },
  pool_hot: { threshold: 2, points: -1 },
  // The floor and its grace are car-policy.ts's; this rule only names the points.
  car_floor: { threshold: 0, points: CAR_FLOOR_POINTS },
};
/**
 * Rules only the bench's referee scores. No planner is given them: the kernel
 * has no model of what they measure (the water tank is planned around it), so
 * a saved override for one never reaches a plan.
 */
export const REFEREE_RULE_DEFAULTS: Record<"water_opportunities", RuleDefault> = {
  // One deduction per missing quarter in each 24-hour benchmark sample period.
  water_opportunities: { threshold: WATER_MINUTES_PER_DAY / 15, points: -1 },
};
/** Rules that no longer exist; a saved override for one is ignored, not an error. */
const RETIRED_RULES = new Set(["ev_low", "ev_short"]);
export const RULE_POINTS_MIN = -2;
export const RULE_POINTS_MAX = 2;
export class CriteriaError extends PlanningError {
  constructor(message: string) { super(message, "planner_not_configured", 503, "terminal"); }
}

export function ruleDefaults(key: string): RuleDefault {
  const value = [...Object.entries(RULE_DEFAULTS), ...Object.entries(REFEREE_RULE_DEFAULTS)].find(([candidate]) => candidate === key)?.[1];
  if (!value) throw new CriteriaError(`Unknown rule "${key}".`);
  return value;
}
export function criteriaErrors(overrides: CriteriaOverrides = {}): string[] {
  const errors: string[] = [];
  for (const [key, o] of Object.entries(overrides ?? {})) {
    if (RETIRED_RULES.has(key)) continue;
    if (key === "car_floor" && o?.threshold !== undefined) { errors.push(`${key}: the floor is a car setting, not a threshold.`); continue; }
    if (!(key in RULE_DEFAULTS) && !(key in REFEREE_RULE_DEFAULTS)) { errors.push(`Unknown rule "${key}".`); continue; }
    if (typeof o !== "object" || o === null) { errors.push(`${key}: not an override.`); continue; }
    if (o.enabled !== undefined && typeof o.enabled !== "boolean") errors.push(`${key}: enabled must be true or false.`);
    if (o.threshold !== undefined && !(Number.isFinite(o.threshold) && o.threshold >= 0)) errors.push(`${key}: the threshold must be a number, 0 or more.`);
    if (o.points !== undefined && !(Number.isInteger(o.points) && o.points !== 0 && o.points >= RULE_POINTS_MIN && o.points <= RULE_POINTS_MAX)) {
      errors.push(`${key}: points must be between ${RULE_POINTS_MIN} and ${RULE_POINTS_MAX}, and not 0.`);
    }
  }
  return errors;
}
export function resolveRulePolicy(overrides: CriteriaOverrides = {}): ReadyRulePolicy {
  const errors = criteriaErrors(overrides);
  if (errors.length) throw new CriteriaError(errors.join(" "));
  // The planner optimises the score: only the rules that take points go to it.
  const rules = Object.entries(RULE_DEFAULTS).flatMap(([key, rule]) => {
    const o = overrides[key] ?? {};
    return (o.enabled ?? true) ? [{key: key as PlannerRuleKey, threshold:o.threshold ?? rule.threshold,
      points:o.points ?? rule.points, required:rule.required ?? false}] : [];
  });
  const threshold = (key: PlannerRuleKey) => overrides[key]?.threshold ?? RULE_DEFAULTS[key].threshold;
  return {rules,service_guard:{pool:[threshold("pool_low"),threshold("pool_cold")]}};
}
