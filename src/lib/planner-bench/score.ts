// Scoring a plan, and the run score built from it.
//
// A case is scored on three things, kept apart:
//
//   Can it be done.  A plan that asks for what the household cannot do
//     (referee.ts) fails the case, whatever its points and whatever the rules
//     below are set to.
//
//   Comfort, 70 %.  Each quarter loses a point for each comfort rule that
//     fires, measured from the owner's target: the pool more than 1 °C below
//     it, and again when more than 2 °C below; the car more than 50 km short,
//     and again when more than 100 km short. A rule cannot fire until its level
//     was reachable: where full power from the first quarter would have got the
//     store there, plus a day to choose the hours. A pool above its target is
//     marked and loses nothing: warm water is a store, and heating it ahead on
//     cheap energy is allowed. Comfort points are the quarter sum divided by
//     CASE_SCALE, clamped to -10..0.
//
//   Energy timing, 30 %.  The money the plan could have saved by moving energy
//     in time with the same comfort and the same stores at the end, as proven
//     by the opportunity audit (opportunities.ts). Only what was knowable from
//     published prices counts; what took hindsight is shown beside it. It is
//     measured against the household's cash exposure with no store acting, the
//     same for every planner: avoidable money worth ECONOMIC_FULL_LOSS_SHARE of
//     that exposure scores -10. A plan whose audit could not be made (it failed
//     the first test) gets no credit: -10.
//
// Case points are 0.7 x comfort + 0.3 x energy timing, -10..0. The run score
// maps the mean case score onto 100-1000 (1000 + 90 x mean).
//
// Scoring reads only the stored plan series, audit included, so the page can
// preview a rule change without replaying anything. A stored score is never
// made without its audit.
//
// Bump SCORER_VERSION whenever a rule or default changes, so stored scores
// are recognised as stale and recomputed.

import { OPPORTUNITY_AUDIT_VERSION, summariseAudit, type OpportunityAudit, type OpportunityAuditSummary } from './opportunities';
import { dueFrom, evExposure, poolExposure, storeNotWorse, type ServiceGuard } from './service';
import type { BenchSeries, CriteriaOverrides, Verdict } from './types';

export { GRACE_QUARTERS } from './service';

export const SCORER_VERSION = 3;
export const QUARTER_MIN = -4;
export const QUARTER_MAX = 0;
export const CASE_MIN = -10;
export const CASE_MAX = 0;
/** Quarter points per comfort point: a point lost in every one of 288 quarters is -10. */
export const CASE_SCALE = 28.8;
export const RUN_MIN = 100;
export const RUN_MAX = 1000;
export const COMFORT_WEIGHT = 0.7;
export const ECONOMIC_WEIGHT = 0.3;
/** Known avoidable money worth this share of the household's passive cash exposure scores -10. */
export const ECONOMIC_FULL_LOSS_SHARE = 0.25;
/** The most a rule may take from a quarter. */
export const RULE_POINTS_MIN = -2;

/** What a rule can see about one quarter. */
export interface QuarterView {
  s: BenchSeries;
  i: number;
  /** Whether a level was reachable long enough ago for missing it to count. */
  due: (reachable: readonly number[] | undefined, start: number, level: number) => boolean;
}

export interface QuarterRule {
  key: string;
  label: string;
  describe: (threshold: number) => string;
  threshold: number;
  /** Signed points added when the rule fires, never above 0; 0 marks a quarter without scoring it. */
  points: number;
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
const poolFrom = (s: BenchSeries, t: number) =>
  s.comfort && s.poolC.some(v => v !== null) ? dueFrom(s.comfort.poolReachableC, s.comfort.pool_start_c, s.comfort.pool_target_c - t) : Infinity;
const carFrom = (s: BenchSeries, t: number) =>
  s.comfort && s.carKm ? dueFrom(s.comfort.carReachableKm, s.comfort.ev_start_km, s.comfort.ev_target_km - t) : Infinity;

export const DEFAULT_RULES: QuarterRule[] = [
  {
    key: 'pool_low', label: 'Pool below target', describe: t => `more than ${t} °C below`, threshold: 1, points: -1,
    fires: poolBelow, eligibleFrom: poolFrom,
  },
  {
    key: 'pool_cold', label: 'Pool far below target', describe: t => `more than ${t} °C below`, threshold: 2, points: -1, required: true,
    fires: poolBelow, eligibleFrom: poolFrom,
  },
  // Marked, not scored: warm water is a thermal buffer, and heating ahead on cheap energy is allowed.
  {
    key: 'pool_hot', label: 'Warm thermal buffer', describe: t => `more than ${t} °C above target`, threshold: 2, points: 0,
    fires: (q, t) => !!q.s.comfort && q.s.poolC[q.i] !== null && q.s.poolC[q.i]! > q.s.comfort.pool_target_c + t,
    eligibleFrom: s => s.comfort && s.poolC.some(v => v !== null) ? 0 : Infinity,
  },
  {
    key: 'ev_low', label: 'Car short of target range', describe: t => `more than ${t} km short`, threshold: 50, points: -1,
    fires: carBelow, eligibleFrom: carFrom,
  },
  {
    key: 'ev_short', label: 'Car far short of target range', describe: t => `more than ${t} km short`, threshold: 100, points: -1, required: true,
    fires: carBelow, eligibleFrom: carFrom,
  },
];

/**
 * Rules of earlier scorers that judged money one quarter at a time. The
 * opportunity audit replaced them; an override stored under one of these names
 * is ignored by name, not applied to anything.
 */
export const REMOVED_RULE_KEYS: readonly string[] = ['solar_spill', 'idle_battery', 'cheap_buy', 'cheapest_buy', 'dear_buy', 'dearest_buy', 'estimated_buy', 'unplugged_charge'];

export class CriteriaError extends Error {}

/** What is wrong with a case's overrides; empty when they can be scored with. */
export function criteriaErrors(overrides: CriteriaOverrides = {}): string[] {
  const errors: string[] = [];
  const known = new Set(DEFAULT_RULES.map(r => r.key));
  for (const [key, o] of Object.entries(overrides ?? {})) {
    if (REMOVED_RULE_KEYS.includes(key)) continue;
    if (!known.has(key)) { errors.push(`Unknown rule "${key}".`); continue; }
    if (typeof o !== 'object' || o === null) { errors.push(`${key}: not an override.`); continue; }
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') errors.push(`${key}: enabled must be true or false.`);
    if (o.threshold !== undefined && !(Number.isFinite(o.threshold) && o.threshold >= 0)) errors.push(`${key}: the threshold must be a number, 0 or more.`);
    if (key !== 'pool_hot' && o.points !== undefined && !(Number.isFinite(o.points) && o.points <= 0 && o.points >= RULE_POINTS_MIN)) {
      errors.push(`${key}: points must be between ${RULE_POINTS_MIN} and 0.`);
    }
  }
  return errors;
}

export type ResolvedRule = QuarterRule & { enabled: boolean };

/** A case's rules: the defaults with its `enabled`, `threshold` and `points` overrides applied. */
export function resolveRules(overrides: CriteriaOverrides = {}): ResolvedRule[] {
  const errors = criteriaErrors(overrides);
  if (errors.length) throw new CriteriaError(errors.join(' '));
  return DEFAULT_RULES.map(rule => {
    const o = overrides[rule.key] ?? {};
    return { ...rule, enabled: o.enabled ?? true, threshold: o.threshold ?? rule.threshold, points: rule.key === 'pool_hot' ? 0 : o.points ?? rule.points };
  });
}

/** The comfort thresholds an alternative plan is held to: the case's own, whether or not a rule is switched on. */
export function serviceGuard(overrides: CriteriaOverrides = {}): ServiceGuard {
  const t = Object.fromEntries(resolveRules(overrides).map(r => [r.key, r.threshold]));
  return { pool: [t.pool_low, t.pool_cold], ev: [t.ev_low, t.ev_short] };
}

/** -10..0 from known avoidable money against the household's passive cash exposure. */
export const economicPoints = (knownSek: number, scaleSek: number) =>
  CASE_MIN * Math.min(1, Math.max(0, knownSek) / (ECONOMIC_FULL_LOSS_SHARE * Math.max(1, scaleSek)));

export interface QuarterScore {
  score: number;
  /** Rule keys that fired, in rule order. */
  fired: string[];
}

export interface ServiceApplicability {
  applicable: boolean;
  reason: string;
  /** Quarters in which the rule could fire. */
  eligibleQuarters: number;
}

export interface CaseScore {
  /** 0.7 x comfortPoints + 0.3 x economicPoints. While economicPoints is null, the comfort share alone. */
  points: number;
  comfortPoints: number;
  /** Null without an audit, or while the audit awaits recomputing under these thresholds. */
  economicPoints: number | null;
  /** Whether `points` holds both parts. */
  complete: boolean;
  /** Null, explicitly, when the series carries none: a result from before the audit, awaiting rescoring. */
  audit: OpportunityAudit | null;
  /** The audit's witnesses do not hold under these thresholds, or it is of another version: recompute before reading it. */
  auditPending: boolean;
  /** The plan asked for what the household cannot do. */
  physicalFailed: boolean;
  /** Sum of every quarter's comfort score, before scaling. */
  sum: number;
  quarters: QuarterScore[];
  /** How often each comfort rule fired. */
  counts: Record<string, number>;
  /** How many quarters scored each value, QUARTER_MIN..0. */
  histogram: Record<string, number>;
  requiredFired: string[];
  /** Per comfort rule: whether it could fire in this case at all, and in how many quarters. */
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
  const resolved = resolveRules(overrides);
  const rules = resolved.filter(r => r.enabled);
  const n = s.start.length;
  // The first quarter from which each level counts, found once per level.
  const dueAt = new Map<string, number>();
  const due = (i: number): QuarterView['due'] => (reachable, start, level) => {
    const id = `${reachable === s.comfort?.poolReachableC ? 'pool' : 'car'}:${level}`;
    if (!dueAt.has(id)) dueAt.set(id, dueFrom(reachable, start, level));
    return i >= dueAt.get(id)!;
  };

  const counts: Record<string, number> = {};
  const histogram: Record<string, number> = Object.fromEntries(
    Array.from({ length: QUARTER_MAX - QUARTER_MIN + 1 }, (_, k) => [String(QUARTER_MIN + k), 0]));
  const quarters: QuarterScore[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const q: QuarterView = { s, i, due: due(i) };
    let raw = 0;
    const fired: string[] = [];
    for (const rule of rules) {
      if (!rule.fires(q, rule.threshold)) continue;
      raw += rule.points;
      fired.push(rule.key);
      counts[rule.key] = (counts[rule.key] ?? 0) + 1;
    }
    const score = Math.max(QUARTER_MIN, Math.min(QUARTER_MAX, Math.round(raw)));
    histogram[String(score)]++;
    sum += score;
    quarters.push({ score, fired });
  }
  const requiredFired = rules.filter(r => r.required && counts[r.key]).map(r => r.key);
  const comfortPoints = Math.max(CASE_MIN, Math.min(CASE_MAX, sum / CASE_SCALE));

  const applicability: Record<string, ServiceApplicability> = Object.fromEntries(resolved.map(rule => {
    const eligibleQuarters = Math.max(0, n - Math.min(n, rule.eligibleFrom(s, rule.threshold)));
    const reason = !rule.enabled ? 'Switched off for this case.'
      : !s.comfort ? 'The plan carries no targets.'
        : !eligibleQuarters ? 'This level was not reachable for a day within the window.'
          : rule.points === 0 ? 'Marked only; loses no points.'
            : `Counts in ${eligibleQuarters} of ${n} quarters.`;
    return [rule.key, { applicable: rule.enabled && eligibleQuarters > 0, reason, eligibleQuarters }];
  }));

  const audit = s.audit ?? null;
  const auditPending = !!audit && (audit.version !== OPPORTUNITY_AUDIT_VERSION
    || (audit.status === 'complete' && !witnessesHold(s, audit, serviceGuard(overrides))));
  const physicalFailed = !!audit && audit.violations.length > 0;
  const economic = !audit || auditPending ? null
    : audit.status === 'complete' ? economicPoints(audit.knownSek, audit.scaleSek) : CASE_MIN;
  const points = Math.max(CASE_MIN, Math.min(CASE_MAX, COMFORT_WEIGHT * comfortPoints + ECONOMIC_WEIGHT * (economic ?? 0)));
  return {
    points, comfortPoints, economicPoints: economic, complete: economic !== null, audit, auditPending, physicalFailed,
    sum, quarters, counts, histogram, requiredFired, applicability, verdict,
    passed: !physicalFailed && (verdict ? verdict === 'pass' : requiredFired.length === 0),
  };
}

/** What the bench stores per result, so run lists need no plan series. */
export interface StoredScore {
  version: number;
  /** Fingerprint of the case's overrides the score was computed with. */
  criteria: string;
  /** 0.7 x comfort_points + 0.3 x economic_points. */
  points: number;
  comfort_points: number;
  economic_points: number;
  /** Comfort quarter sum, histogram and counts. */
  sum: number;
  histogram: Record<string, number>;
  counts: Record<string, number>;
  required_fired: string[];
  /** The plan asked for what the household cannot do: the case fails whatever its points. */
  physical_failed: boolean;
  audit: OpportunityAuditSummary;
}

/** Stable over key order; overrides of removed rules do not count. */
export const criteriaFingerprint = (overrides: CriteriaOverrides = {}) =>
  JSON.stringify(Object.keys(overrides).filter(k => !REMOVED_RULE_KEYS.includes(k)).sort().map(k => [k, overrides[k]]));

export function storedScore(s: BenchSeries, overrides: CriteriaOverrides = {}): StoredScore {
  const c = scoreQuarters(s, overrides);
  if (!c.audit || c.economicPoints === null) {
    throw new Error(c.audit
      ? 'The plan\'s opportunity audit was made under other comfort thresholds; evaluate the plan again (evaluate.ts).'
      : 'A score needs the plan\'s opportunity audit; evaluate the plan (evaluate.ts) rather than scoring a bare series.');
  }
  return {
    version: SCORER_VERSION, criteria: criteriaFingerprint(overrides),
    points: c.points, comfort_points: c.comfortPoints, economic_points: c.economicPoints, sum: c.sum,
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

/** 100–1000; null until at least one case has a result. */
export function runScore(casePoints: readonly number[]): number | null {
  if (!casePoints.length) return null;
  const mean = casePoints.reduce((a, b) => a + b, 0) / casePoints.length;
  return Math.round(Math.min(RUN_MAX, Math.max(RUN_MIN, 1000 + 90 * mean)));
}
