import type { PlannerRuleKey, ReadyProblem } from "./ready-problem.ts";

export interface CriterionOverride { enabled?: boolean; threshold?: number; points?: number }
export type CriteriaOverrides = Record<string, CriterionOverride>;
export type ReadyRulePolicy = Pick<ReadyProblem, "rules" | "service_guard">;
type RuleDefault = { threshold: number; points: number; required?: boolean; unless?: PlannerRuleKey };
/** Shared approved policy parameters; model transitions and the independent referee own measurements. */
export const RULE_DEFAULTS: Record<PlannerRuleKey, RuleDefault> = {
  pool_low: {threshold:1,points:-1}, pool_cold:{threshold:2,points:-1,required:true},
  pool_hot:{threshold:2,points:-1}, pool_buffer:{threshold:2,points:1},
  pool_restart:{threshold:12,points:-2},
  ev_low:{threshold:50,points:-1}, ev_short:{threshold:100,points:-1,required:true},
  cheap_buy:{threshold:.25,points:1,unless:"cheapest_buy"}, cheapest_buy:{threshold:.1,points:2},
  dear_load:{threshold:.25,points:-1,unless:"dearest_load"}, dearest_load:{threshold:.1,points:-2},
  base_load_dear_import:{threshold:.25,points:-1,unless:"base_load_dearest_import"},
  base_load_dearest_import:{threshold:.1,points:-2},
  missed_cheap_quarter:{threshold:1,points:-1},
  arbitrage_no_export:{threshold:4,points:-1}, arbitrage_not_full:{threshold:4,points:-1},
  ev_from_home_battery:{threshold:0,points:-1}, large_load_overlap:{threshold:2000,points:-1},
  pool_short_gap:{threshold:.1,points:-1}, ev_short_gap:{threshold:.1,points:-1},
};
export const RULE_POINTS_MIN = -2;
export const RULE_POINTS_MAX = 2;
export const REMOVED_RULE_KEYS: readonly string[] = ["solar_spill", "idle_battery", "dear_buy", "dearest_buy", "estimated_buy", "unplugged_charge"];
export class CriteriaError extends Error {}

export function ruleDefaults(key: string): RuleDefault {
  const value = Object.entries(RULE_DEFAULTS).find(([candidate]) => candidate === key)?.[1];
  if (!value) throw new CriteriaError(`Unknown rule "${key}".`);
  return value;
}
export function criteriaErrors(overrides: CriteriaOverrides = {}): string[] {
  const errors: string[] = [];
  for (const [key, o] of Object.entries(overrides ?? {})) {
    if (REMOVED_RULE_KEYS.includes(key)) continue;
    if (!(key in RULE_DEFAULTS)) { errors.push(`Unknown rule "${key}".`); continue; }
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
  const rules = Object.entries(RULE_DEFAULTS).flatMap(([key, rule]) => {
    const o = overrides[key] ?? {};
    return (o.enabled ?? true) ? [{key: key as PlannerRuleKey, threshold:o.threshold ?? rule.threshold,
      points:o.points ?? rule.points, required:rule.required ?? false, unless:rule.unless ?? null}] : [];
  });
  const threshold = (key: PlannerRuleKey) => overrides[key]?.threshold ?? RULE_DEFAULTS[key].threshold;
  return {rules,service_guard:{pool:[threshold("pool_low"),threshold("pool_cold")],ev:[threshold("ev_low"),threshold("ev_short")]}};
}
