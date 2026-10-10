// A point is a krona: comfort deductions minus the net bill. Economic audit
// findings prove feasible savings; they are not additional costs or points.
import { OPPORTUNITY_AUDIT_VERSION, summariseAudit, type OpportunityAudit, type OpportunityAuditSummary } from './opportunities';
import { dueFrom, evExposure, poolExposure, storeNotWorse, type ServiceGuard } from './service';
import type { BenchSeries, Bill, CriteriaOverrides, Verdict } from './types';
import { canonicalJson } from './case';
import { criteriaErrors, CriteriaError, ruleDefaults } from '../../../supabase/functions/_shared/planner-wasm/rule-policy';
export { criteriaErrors, CriteriaError, RULE_POINTS_MIN, RULE_POINTS_MAX } from '../../../supabase/functions/_shared/planner-wasm/rule-policy';

export { GRACE_QUARTERS } from './service';

export const SCORER_VERSION = 32;
/** A plan day: the pool's warmth is judged against the 24 hours after the 24 it is in. */
export const DAY_QUARTERS = 96;
/** How much dearer, or how much less sunny, the next day must be to be worth storing heat for. */
export const AHEAD_MARGIN = 0.1;
/** What a rule can see about one quarter. */
export interface QuarterView {
  s: BenchSeries;
  i: number;
  /** The plan's next day against this one; null in the last day, which has none to compare with. */
  ahead: { dearer: boolean; lessSun: boolean } | null;
  /** Whether a level was reachable long enough ago for missing it to count. */
  due: (reachable: readonly number[] | undefined, start: number, level: number) => boolean;
}

export interface QuarterRule {
  key: string;
  label: string;
  describe: (threshold: number) => string;
  threshold: number;
  /** Signed comfort deduction in kronor. */
  points: number;
  /** What the rule measures, for explaining it; nothing in the scoring depends on it. */
  about: 'pool' | 'car';
  /** A case in which this rule fires anywhere is shown as failed. */
  required?: boolean;
  fires: (q: QuarterView, threshold: number) => boolean;
  /** The first quarter in which the rule could fire; Infinity when it never can. */
  eligibleFrom: (s: BenchSeries, threshold: number) => number;
}

const poolBelow = (q: QuarterView, t: number) => {
  const c = q.s.comfort, now = q.s.poolC[q.i];
  return !!c && now !== null && now < c.pool_target_c - t && q.due(c.poolReachableC, c.pool_start_c, c.pool_target_c - t);
};
const carBelow = (q: QuarterView, t: number) => {
  const c = q.s.comfort, km = q.s.carKm;
  return !!c && !!km && km[q.i] < c.ev_target_km - t && q.due(c.carReachableKm, c.ev_start_km, c.ev_target_km - t);
};
const poolAbove = (q: QuarterView, t: number) =>
  !!q.s.comfort && q.s.poolC[q.i] !== null && q.s.poolC[q.i]! > q.s.comfort.pool_target_c + t;
const poolAny = (s: BenchSeries) => s.comfort && s.poolC.some(v => v !== null) ? 0 : Infinity;
const poolFrom = (s: BenchSeries, t: number) =>
  s.comfort && s.poolC.some(v => v !== null) ? dueFrom(s.comfort.poolReachableC, s.comfort.pool_start_c, s.comfort.pool_target_c - t) : Infinity;
const carFrom = (s: BenchSeries, t: number) =>
  s.comfort && s.carKm ? dueFrom(s.comfort.carReachableKm, s.comfort.ev_start_km, s.comfort.ev_target_km - t) : Infinity;

const poolBeforeC = (s: BenchSeries, i: number): number | null =>
  s.comfort ? i === 0 ? Math.round(s.comfort.pool_start_c * 1000) / 1000 : s.poolC[i - 1] : null;
const poolHeatingPast = (q: QuarterView, threshold: number) => {
  const before = poolBeforeC(q.s, q.i);
  return !!q.s.comfort && before !== null && before >= q.s.comfort.pool_target_c + threshold
    && (q.s.poolW[q.i] > 0 || !!q.s.poolStart?.[q.i]);
};
const QUARTER_RULES: Omit<QuarterRule, "threshold" | "points" | "required">[] = [
  {
    key: 'pool_low', about: 'pool', label: 'Pool below target', describe: t => `more than ${t} °C below`, fires: poolBelow, eligibleFrom: poolFrom,
  },
  {
    key: 'pool_cold', about: 'pool', label: 'Pool far below target', describe: t => `more than ${t} °C below`, fires: poolBelow, eligibleFrom: poolFrom,
  },
  // Warm water is a store. Above the target it is one or the other: heat kept for a dearer or duller day, or waste.
  {
    key: 'pool_hot', about: 'pool', label: 'Pool overheated', describe: t => `heating after reaching target +${t} °C, or warmer than that with the next day neither dearer nor less sunny`,
    fires: (q, t) => poolHeatingPast(q, t) || poolAbove(q, t) && !!q.ahead && !q.ahead.dearer && !q.ahead.lessSun, eligibleFrom: poolAny,
  },
  {
    key: 'ev_low', about: 'car', label: 'Car short of target range', describe: t => `more than ${t} km short`, fires: carBelow, eligibleFrom: carFrom,
  },
  {
    key: 'ev_short', about: 'car', label: 'Car far short of target range', describe: t => `more than ${t} km short`, fires: carBelow, eligibleFrom: carFrom,
  },
];

export const DEFAULT_RULES: QuarterRule[] = QUARTER_RULES.map(rule => ({...rule, ...ruleDefaults(rule.key)}));

export type ResolvedRule = QuarterRule & { enabled: boolean };

/** The bench's rules: the defaults with the saved `enabled`, `threshold` and `points` overrides applied. */
export function resolveRules(overrides: CriteriaOverrides = {}): ResolvedRule[] {
  const errors = criteriaErrors(overrides);
  if (errors.length) throw new CriteriaError(errors.join(' '));
  return DEFAULT_RULES.map(rule => {
    const o = overrides[rule.key] ?? {};
    return { ...rule, enabled: o.enabled ?? true, threshold: o.threshold ?? rule.threshold, points: o.points ?? rule.points };
  });
}

/** The comfort thresholds an alternative plan is held to: the bench's own, whether or not a rule is switched on. */
export function serviceGuard(overrides: CriteriaOverrides = {}): ServiceGuard {
  const t = Object.fromEntries(resolveRules(overrides).map(r => [r.key, r.threshold]));
  return { pool: [t.pool_low, t.pool_cold], ev: [t.ev_low, t.ev_short] };
}

export interface QuarterScore {
  /** What the quarter's deductions took, in points (kronor); never above 0 with the default rules. */
  score: number;
  /** Deduction rules that fired, in rule order. */
  fired: string[];
}

export interface ServiceApplicability {
  applicable: boolean;
  reason: string;
  /** Quarters in which the rule could fire. */
  eligibleQuarters: number;
}

export interface CaseScore {
  /** The case score: deductions less the net bill. While the bill or the audit is missing or pending, the deductions alone. */
  points: number;
  /** Whether `points` holds both parts. */
  complete: boolean;
  /** Null on a series from before the bill, awaiting recomputing. */
  bill: Bill | null;
  /** Null, explicitly, when the series carries none: a result from before the audit, awaiting rescoring. */
  audit: OpportunityAudit | null;
  /** The audit's witnesses do not hold under these thresholds, or it is of another version: recompute before reading it. */
  auditPending: boolean;
  /** The plan asked for what the household cannot do. */
  physicalFailed: boolean;
  /** Sum of every quarter's score: what the deductions took. */
  sum: number;
  quarters: QuarterScore[];
  /** How often each deduction was charged. */
  counts: Record<string, number>;
  /** How many quarters scored each value. */
  histogram: Record<string, number>;
  requiredFired: string[];
  /** Per quarter rule: whether it could fire in this case at all, and in how many quarters. */
  applicability: Record<string, ServiceApplicability>;
  /** Your verdict when there is one, otherwise the automatic reading; never passed when physicalFailed. */
  passed: boolean;
  verdict: Verdict | null;
}

const sameGuard = (a: ServiceGuard, b: ServiceGuard) =>
  a.pool[0] === b.pool[0] && a.pool[1] === b.pool[1] && a.ev[0] === b.ev[0] && a.ev[1] === b.ev[1];

/** Whether every stored witness still holds under other comfort thresholds, from its stored traces. */
function witnessesHold(s: BenchSeries, audit: OpportunityAudit, guard: ServiceGuard): boolean {
  if (sameGuard(audit.guard, guard)) return true;
  const comfort = s.comfort;
  if (!comfort) return false;
  // A finding moves only its own device's store; the battery has no comfort level.
  return audit.findings.every(f =>
    f.device === 'pool' ? storeNotWorse(poolExposure(comfort, f.before.poolC, guard), poolExposure(comfort, f.after.poolC, guard))
      : f.device === 'ev' ? storeNotWorse(evExposure(comfort, f.before.carKm, guard), evExposure(comfort, f.after.carKm, guard))
        : true);
}

export function scoreQuarters(s: BenchSeries, overrides: CriteriaOverrides = {}, verdict: Verdict | null = null): CaseScore {
  return tally(s, overrides, verdict);
}

function tally(s: BenchSeries, overrides: CriteriaOverrides, verdict: Verdict | null): CaseScore {
  const resolved = resolveRules(overrides);
  const rules = resolved.filter(r => r.enabled);
  const n = s.start.length;
  const audit = s.audit ?? null;
  const auditPending = !!audit && (audit.version !== OPPORTUNITY_AUDIT_VERSION
    || audit.status === 'complete' && !witnessesHold(s, audit, serviceGuard(overrides)));
  // The first quarter from which each level counts, found once per level.
  const dueAt = new Map<string, number>();
  const due = (i: number): QuarterView['due'] => (reachable, start, level) => {
    const id = `${reachable === s.comfort?.poolReachableC ? 'pool' : 'car'}:${level}`;
    if (!dueAt.has(id)) dueAt.set(id, dueFrom(reachable, start, level));
    return i >= dueAt.get(id)!;
  };

  // Each plan day's mean price and solar, to judge warmth held for the day after.
  const days = Array.from({ length: Math.ceil(n / DAY_QUARTERS) }, (_, d) => {
    const of = (values: number[]) => values.slice(d * DAY_QUARTERS, (d + 1) * DAY_QUARTERS);
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    return { price: mean(of(s.importPrice)), solar: mean(of(s.solarW)), full: of(s.importPrice).length === DAY_QUARTERS };
  });
  const aheadOf = (i: number): QuarterView['ahead'] => {
    const today = days[Math.floor(i / DAY_QUARTERS)], next = days[Math.floor(i / DAY_QUARTERS) + 1];
    return next?.full ? { dearer: next.price > today.price * (1 + AHEAD_MARGIN), lessSun: next.solar < today.solar * (1 - AHEAD_MARGIN) } : null;
  };

  const counts: Record<string, number> = {};
  const histogram: Record<string, number> = {};
  const quarters: QuarterScore[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const q: QuarterView = { s, i, due: due(i), ahead: aheadOf(i) };
    const firing = rules.filter(rule => rule.fires(q, rule.threshold));
    let score = 0;
    const fired: string[] = [];
    for (const rule of firing) {
      score += rule.points;
      fired.push(rule.key);
      counts[rule.key] = (counts[rule.key] ?? 0) + 1;
    }
    histogram[String(score)] = (histogram[String(score)] ?? 0) + 1;
    sum += score;
    quarters.push({ score, fired });
  }
  const requiredFired = rules.filter(r => r.required && counts[r.key]).map(r => r.key);

  const applicability: Record<string, ServiceApplicability> = Object.fromEntries(resolved.map(rule => {
    const eligibleQuarters = Math.max(0, n - Math.min(n, rule.eligibleFrom(s, rule.threshold)));
    const reason = !rule.enabled ? 'Switched off for this case.'
      : !s.comfort ? 'The plan carries no targets.'
        : !eligibleQuarters ? 'This level was not reachable for a day within the window.'
          : `Counts in ${eligibleQuarters} of ${n} quarters.`;
    return [rule.key, { applicable: rule.enabled && eligibleQuarters > 0, reason, eligibleQuarters }];
  }));

  const physicalFailed = !!audit && audit.violations.length > 0;
  const bill = s.bill ?? null;
  const complete = !!audit && !auditPending && !!bill;
  const points = complete ? Math.round((sum - bill.net_sek) * 10_000) / 10_000 : sum;
  return {
    points, complete, bill, audit, auditPending, physicalFailed,
    sum, quarters, counts, histogram, requiredFired, applicability, verdict,
    passed: !physicalFailed && (verdict ? verdict === 'pass' : requiredFired.length === 0),
  };
}

/** What the bench stores per result, so run lists need no plan series. */
export interface StoredScore {
  version: number;
  /** Fingerprint of the rule overrides the score was computed with. */
  criteria: string;
  /** The case score, a point a krona: sum − (grid_sek + wear_sek − credit_sek). */
  points: number;
  /** What the deductions took, with its histogram and counts. */
  sum: number;
  /** The bill the score is made of (referee.ts billOf). */
  grid_sek: number;
  wear_sek: number;
  credit_sek: number;
  histogram: Record<string, number>;
  counts: Record<string, number>;
  required_fired: string[];
  /** The plan asked for what the household cannot do: the case fails whatever its points. */
  physical_failed: boolean;
  audit: OpportunityAuditSummary;
}

/** Stable over key order. Criteria are validated before evaluation. */
export const criteriaFingerprint = (overrides: CriteriaOverrides = {}) =>
  JSON.stringify(Object.keys(overrides).sort().map(k => [k, overrides[k]]));

/** The effective rule inputs, including defaults, used by the rule-driven solver: the deduction rules, which are all it is sent. */
export const plannerInputsFingerprint = (rules: readonly {
  key: string; threshold: number; points: number; required?: boolean;
}[], guard: ServiceGuard) => JSON.stringify({
  rules: rules.map(r => ({ key: r.key, threshold: r.threshold, points: r.points,
    required: r.required ?? false })), service_guard: guard,
});
export const plannerRulesFingerprint = (overrides: CriteriaOverrides = {}) =>
  plannerInputsFingerprint(resolveRules(overrides).filter(r => r.enabled), serviceGuard(overrides));

/** Full supplied inputs: historical planners may consume rules today's scorer removed. */
export const plannerCriteriaFingerprint = (overrides: CriteriaOverrides = {}) => canonicalJson(overrides);

/** Immutable planner defaults may differ; freshness concerns the supplied overrides. */
export function plannerRuleInputsCurrent(result: {
  planner_generation?: string | null; planner_rules?: string | null; planner_criteria?: string | null;
}, overrides: CriteriaOverrides): boolean {
  return !result.planner_generation?.startsWith('ready-wasm-')
    || Boolean(result.planner_rules) && result.planner_criteria === plannerCriteriaFingerprint(overrides);
}

export function storedScore(s: BenchSeries, overrides: CriteriaOverrides = {}): StoredScore {
  const c = scoreQuarters(s, overrides);
  if (!c.audit || c.auditPending) {
    throw new Error(c.audit
      ? 'The plan\'s opportunity audit needs recomputing for these rule thresholds or this audit version; evaluate the plan again (evaluate.ts).'
      : 'A score needs the plan\'s opportunity audit; evaluate the plan (evaluate.ts) rather than scoring a bare series.');
  }
  if (!c.bill) throw new Error('A score needs the plan\'s bill; evaluate the plan (evaluate.ts) rather than scoring a series from before it.');
  return {
    version: SCORER_VERSION, criteria: criteriaFingerprint(overrides),
    points: c.points, sum: c.sum, grid_sek: c.bill.grid_sek, wear_sek: c.bill.wear_sek, credit_sek: c.bill.credit.credit_sek,
    histogram: c.histogram, counts: c.counts, required_fired: c.requiredFired,
    physical_failed: c.physicalFailed, audit: summariseAudit(c.audit),
  };
}

export const isStale = (score: StoredScore | null | undefined, overrides: CriteriaOverrides = {}) =>
  !score || score.version !== SCORER_VERSION || score.audit?.version !== OPPORTUNITY_AUDIT_VERSION
  || score.criteria !== criteriaFingerprint(overrides);

/** Pass/fail from a stored score and your verdict. A plan the household cannot carry out never passes. */
export const storedPassed = (score: StoredScore, verdict: Verdict | null) =>
  !score.physical_failed && (verdict ? verdict === 'pass' : score.required_fired.length === 0);

/** Sum of the displayed case points; null until at least one case has a result. */
export function runScore(casePoints: readonly number[]): number | null {
  if (!casePoints.length) return null;
  return Math.round(casePoints.reduce((a, b) => a + b, 0) * 10_000) / 10_000;
}

/**
 * The versions worth listing, oldest first. Where consecutive versions scored the same, the changes between them
 * did not move the planner, so only the newest of them stays. A version without a score is never dropped and never
 * counts as the same as its neighbour; neither is one `keep` names.
 */
export function distinctScoreRuns<T>(runs: readonly T[], scoreOf: (run: T) => number | null, keep: (run: T) => boolean = () => false): T[] {
  return runs.filter((run, i) => {
    if (i === runs.length - 1 || keep(run)) return true;
    // Scores are kronor: two that agree to the öre are the same.
    const score = scoreOf(run), next = scoreOf(runs[i + 1]);
    return score === null || next === null || Math.round(score * 100) !== Math.round(next * 100);
  });
}
