// Scoring a plan, and the run score built from it.
//
// Every point is worth the same and they all add up: a case's points are the
// sum of what its rules gave and took, a run's points the sum of its cases.
//
//   Quarter rules. Each quarter gains or loses the points of every rule that
//     fires in it. Comfort is measured from the owner's target: the pool more
//     than 1 °C below it, and again when more than 2 °C below; the car more
//     than 50 km short, and again when more than 100 km short. Such a rule
//     cannot fire until its level was reachable: where full power from the
//     first quarter would have got the store there, plus a day to choose the
//     hours. A pool more than 2 °C above its target is judged by the day
//     that follows (the plan's next 24 hours against the 24 it is in): heat
//     held for dearer prices or less sun gains a point as a thermal buffer,
//     heat held for neither loses one as overheating. A quarter in
//     which the pool, battery charging and car together draw FLEXIBLE_W or
//     more gains a point when its real price is among the cheapest quarter of
//     the plan's, or two when among the cheapest tenth. Where FLEXIBLE_W or
//     more of that load is bought from the grid, the quarter loses a point
//     when the price is among the dearest quarter of the plan's, or two when
//     among the dearest tenth. Load the sun or the battery carries loses nothing.
//
//   Energy timing. The money the plan could have saved by moving energy
//     in time with the same comfort and the same stores at the end, as proven
//     by the opportunity audit (opportunities.ts). Only what was knowable from
//     published prices counts; what took hindsight is shown beside it. Each
//     distinct changed quarter loses one point under its primary rule.
//
// Apart from points, a plan that asks for what the household cannot do
// (referee.ts) fails the case, whatever its points; a plan whose audit could
// not be made is failed the same way, not given invented points.
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

export const SCORER_VERSION = 10;
/** The most a rule may take from a quarter, and the most it may give. */
export const RULE_POINTS_MIN = -2;
export const RULE_POINTS_MAX = 2;
/** A plan day: the pool's warmth is judged against the 24 hours after the 24 it is in. */
export const DAY_QUARTERS = 96;
/** How much dearer, or how much less sunny, the next day must be to be worth storing heat for. */
export const AHEAD_MARGIN = 0.1;
/** Pool, battery charging and car together at or above this count as a flexible purchase. */
export const FLEXIBLE_W = 500;

/** What a rule can see about one quarter. */
export interface QuarterView {
  s: BenchSeries;
  i: number;
  /** Share of the plan's quarters priced strictly below this one, 0-1. */
  priceRank: number;
  /** Share of the plan's quarters priced strictly above this one, 0-1. */
  dearRank: number;
  /** Pool + battery charging + car, W. */
  flexibleW: number;
  /** The part of it bought from the grid: the flexible load, up to what the quarter imported, W. */
  flexibleGridW: number;
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
  /** Signed points added when the rule fires; never 0, since a rule that scores nothing says nothing. */
  points: number;
  /** What the rule measures, for explaining it; nothing in the scoring depends on it. */
  about: 'pool' | 'car' | 'price';
  /** Does not fire in a quarter where this other rule fired, so the two never stack. */
  unless?: string;
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

const pct = (t: number) => `${Math.round(t * 100)} %`;
const cheapBuy = (q: QuarterView, t: number) => q.flexibleW >= FLEXIBLE_W && q.priceRank < t;
const dearBuy = (q: QuarterView, t: number) => q.flexibleGridW >= FLEXIBLE_W && q.dearRank < t;

export const DEFAULT_RULES: QuarterRule[] = [
  {
    key: 'pool_low', about: 'pool', label: 'Pool below target', describe: t => `more than ${t} °C below`, threshold: 1, points: -1,
    fires: poolBelow, eligibleFrom: poolFrom,
  },
  {
    key: 'pool_cold', about: 'pool', label: 'Pool far below target', describe: t => `more than ${t} °C below`, threshold: 2, points: -1, required: true,
    fires: poolBelow, eligibleFrom: poolFrom,
  },
  // Warm water is a store. Above the target it is one or the other: heat kept for a dearer or duller day, or waste.
  {
    key: 'pool_hot', about: 'pool', label: 'Pool overheated', describe: t => `more than ${t} °C above target, the next day neither dearer nor less sunny`, threshold: 2, points: -1,
    fires: (q, t) => poolAbove(q, t) && !!q.ahead && !q.ahead.dearer && !q.ahead.lessSun, eligibleFrom: poolAny,
  },
  {
    key: 'pool_buffer', about: 'pool', label: 'Warm thermal buffer', describe: t => `more than ${t} °C above target, the next day dearer or less sunny`, threshold: 2, points: 1,
    fires: (q, t) => poolAbove(q, t) && !!q.ahead && (q.ahead.dearer || q.ahead.lessSun), eligibleFrom: poolAny,
  },
  {
    key: 'ev_low', about: 'car', label: 'Car short of target range', describe: t => `more than ${t} km short`, threshold: 50, points: -1,
    fires: carBelow, eligibleFrom: carFrom,
  },
  {
    key: 'ev_short', about: 'car', label: 'Car far short of target range', describe: t => `more than ${t} km short`, threshold: 100, points: -1, required: true,
    fires: carBelow, eligibleFrom: carFrom,
  },
  {
    key: 'cheap_buy', about: 'price', label: 'Flexible load in a cheap quarter', describe: t => `price in cheapest ${pct(t)}`, threshold: 0.25, points: 1,
    unless: 'cheapest_buy', fires: cheapBuy, eligibleFrom: () => 0,
  },
  {
    key: 'cheapest_buy', about: 'price', label: 'Flexible load in a very cheap quarter', describe: t => `price in cheapest ${pct(t)}`, threshold: 0.1, points: 2,
    fires: cheapBuy, eligibleFrom: () => 0,
  },
  {
    key: 'dear_load', about: 'price', label: 'Flexible load bought in a dear quarter', describe: t => `price in dearest ${pct(t)}`, threshold: 0.25, points: -1,
    unless: 'dearest_load', fires: dearBuy, eligibleFrom: () => 0,
  },
  {
    key: 'dearest_load', about: 'price', label: 'Flexible load bought in a very dear quarter', describe: t => `price in dearest ${pct(t)}`, threshold: 0.1, points: -2,
    fires: dearBuy, eligibleFrom: () => 0,
  },
];

/** The price rules that count from the dear end of the plan's prices. */
export const DEAR_RULE_KEYS: readonly string[] = ['dear_load', 'dearest_load'];

/**
 * Rules of earlier scorers that judged money one quarter at a time. The
 * opportunity audit replaced them; an override stored under one of these names
 * is ignored by name, not applied to anything.
 */
export const REMOVED_RULE_KEYS: readonly string[] = ['solar_spill', 'idle_battery', 'dear_buy', 'dearest_buy', 'estimated_buy', 'unplugged_charge'];

export class CriteriaError extends Error {}

/** What is wrong with the saved overrides; empty when they can be scored with. */
export function criteriaErrors(overrides: CriteriaOverrides = {}): string[] {
  const errors: string[] = [];
  const known = new Set(DEFAULT_RULES.map(r => r.key));
  for (const [key, o] of Object.entries(overrides ?? {})) {
    if (REMOVED_RULE_KEYS.includes(key)) continue;
    if (!known.has(key)) { errors.push(`Unknown rule "${key}".`); continue; }
    if (typeof o !== 'object' || o === null) { errors.push(`${key}: not an override.`); continue; }
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') errors.push(`${key}: enabled must be true or false.`);
    if (o.threshold !== undefined && !(Number.isFinite(o.threshold) && o.threshold >= 0)) errors.push(`${key}: the threshold must be a number, 0 or more.`);
    if (o.points !== undefined && !(Number.isInteger(o.points) && o.points !== 0 && o.points >= RULE_POINTS_MIN && o.points <= RULE_POINTS_MAX)) {
      errors.push(`${key}: points must be between ${RULE_POINTS_MIN} and ${RULE_POINTS_MAX}, and not 0.`);
    }
  }
  return errors;
}

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

/** One point per changed quarter under a primary rule; explanatory tags add no points. */
export const economicPoints = (audit: OpportunityAudit) =>
  -Object.values(audit.rules).reduce((sum, rule) => sum + rule.knownQuarters.length, 0);

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
  /** The quarter rules' points plus the energy-timing ones. While the audit is pending, the quarter rules' alone. */
  points: number;
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
  /** Sum of every quarter's score: what the quarter rules gave and took. */
  sum: number;
  quarters: QuarterScore[];
  /** How often each quarter rule fired. */
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

  const sorted = [...s.importPrice].sort((a, b) => a - b);
  /** How many of the plan's prices are below this one; with `orEqual`, at or below it. */
  const below = (price: number, orEqual = false) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < price || (orEqual && sorted[mid] === price)) lo = mid + 1; else hi = mid; }
    return lo;
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
    const flexibleW = s.poolW[i] + s.batteryChargeW[i] + s.carW[i];
    const q: QuarterView = {
      s, i, due: due(i), ahead: aheadOf(i), priceRank: n ? below(s.importPrice[i]) / n : 0,
      dearRank: n ? (n - below(s.importPrice[i], true)) / n : 0,
      // Flexible load is the load there was a choice about, so what the quarter imported is counted as its first.
      flexibleW, flexibleGridW: Math.min(flexibleW, s.gridImportW[i]),
    };
    const firing = rules.filter(rule => rule.fires(q, rule.threshold));
    let score = 0;
    const fired: string[] = [];
    for (const rule of firing) {
      if (rule.unless && firing.some(other => other.key === rule.unless)) continue;
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
      : rule.about !== 'price' && !s.comfort ? 'The plan carries no targets.'
        : !eligibleQuarters ? 'This level was not reachable for a day within the window.'
          : `Counts in ${eligibleQuarters} of ${n} quarters.`;
    return [rule.key, { applicable: rule.enabled && eligibleQuarters > 0, reason, eligibleQuarters }];
  }));

  const audit = s.audit ?? null;
  const auditPending = !!audit && (audit.version !== OPPORTUNITY_AUDIT_VERSION
    || (audit.status === 'complete' && !witnessesHold(s, audit, serviceGuard(overrides))));
  const physicalFailed = !!audit && audit.violations.length > 0;
  const economic = !audit || auditPending ? null
    : audit.status === 'complete' ? economicPoints(audit) : 0;
  const points = sum + (economic ?? 0);
  return {
    points, economicPoints: economic, complete: economic !== null, audit, auditPending, physicalFailed,
    sum, quarters, counts, histogram, requiredFired, applicability, verdict,
    passed: !physicalFailed && (verdict ? verdict === 'pass' : requiredFired.length === 0),
  };
}

/** What the bench stores per result, so run lists need no plan series. */
export interface StoredScore {
  version: number;
  /** Fingerprint of the rule overrides the score was computed with. */
  criteria: string;
  /** sum + economic_points. */
  points: number;
  economic_points: number;
  /** What the quarter rules gave and took, with its histogram and counts. */
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
    points: c.points, economic_points: c.economicPoints, sum: c.sum,
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
  return casePoints.reduce((a, b) => a + b, 0);
}

/**
 * The versions worth listing, oldest first. Where consecutive versions scored the same, the changes between them
 * did not move the planner, so only the newest of them stays. A version without a score is never dropped and never
 * counts as the same as its neighbour; neither is one `keep` names.
 */
export function distinctScoreRuns<T>(runs: readonly T[], scoreOf: (run: T) => number | null, keep: (run: T) => boolean = () => false): T[] {
  return runs.filter((run, i) => {
    if (i === runs.length - 1 || keep(run)) return true;
    const score = scoreOf(run);
    return score === null || score !== scoreOf(runs[i + 1]);
  });
}
