// Quarter-by-quarter scoring of a plan, and the run score built from it.
//
// The score is about comfort: did the plan keep the pool and the car where the
// owner wants them. Money is not scored here; every plan's cost at real prices
// is reported beside it (referee.ts), and a point system cannot improve on kr.
//
// Each quarter loses a point for each comfort rule that fires, measured from
// the owner's target: the pool more than 1 °C below it, and again when more
// than 2 °C below; the pool more than 2 °C above it; the car more than 50 km
// short, and again when more than 100 km short. A rule cannot fire until its
// level was reachable: where full power from the first quarter would have got
// the store there, plus a day to choose the hours. So a case that starts cold
// is not held against the planner for what no planner could do.
//
// A case's points are its quarter sum divided by CASE_SCALE, clamped to
// -10..0: -10 is a point lost in every quarter. The run score maps the mean
// case score onto 100-1000 (1000 + 90 x mean), so 1000 is no comfort miss.
// Scoring reads only the stored plan series, so a rule change rescoring every
// run needs no planner re-run.
//
// Bump SCORER_VERSION whenever a rule or default changes, so stored scores
// are recognised as stale and recomputed.

import type { BenchSeries, CriteriaOverrides, Verdict } from './types';

export const SCORER_VERSION = 2;
export const QUARTER_MIN = -4;
export const QUARTER_MAX = 0;
export const CASE_MIN = -10;
export const CASE_MAX = 0;
/** Quarter points per case point: a point lost in every one of 288 quarters is -10. */
export const CASE_SCALE = 28.8;
export const RUN_MIN = 100;
export const RUN_MAX = 1000;
/** Pool, battery charging and car together above this count as a flexible purchase. */
export const FLEXIBLE_W = 500;
/** Quarters a planner gets to choose its hours once a comfort level is reachable. */
export const GRACE_QUARTERS = 96;

/** What a rule can see about one quarter. */
export interface QuarterView {
  s: BenchSeries;
  i: number;
  /** Share of the plan's quarters priced strictly below this one, 0-1. */
  priceRank: number;
  /** Whether a level was reachable long enough ago for missing it to count. */
  due: (reachable: readonly number[] | undefined, start: number, level: number) => boolean;
}

export interface QuarterRule {
  key: string;
  label: string;
  describe: (threshold: number) => string;
  threshold: number;
  /** Signed points added when the rule fires; 0 marks a quarter without scoring it. */
  points: number;
  /** A case in which this rule fires anywhere is shown as failed. */
  required?: boolean;
  fires: (q: QuarterView, threshold: number) => boolean;
}

const poolBelow = (q: QuarterView, t: number) => {
  const c = q.s.comfort, now = q.s.poolC[q.i];
  return !!c && now !== null && now < c.pool_target_c - t && q.due(c.poolReachableC, c.pool_start_c, c.pool_target_c - t);
};
const carBelow = (q: QuarterView, t: number) => {
  const c = q.s.comfort, km = q.s.carKm;
  return !!c && !!km && km[q.i] < c.ev_target_km - t && q.due(c.carReachableKm, c.ev_start_km, c.ev_target_km - t);
};

export const DEFAULT_RULES: QuarterRule[] = [
  {
    key: 'pool_low', label: 'Pool below target', describe: t => `more than ${t} °C below`, threshold: 1, points: -1,
    fires: poolBelow,
  },
  {
    key: 'pool_cold', label: 'Pool far below target', describe: t => `more than ${t} °C below`, threshold: 2, points: -1, required: true,
    fires: poolBelow,
  },
  {
    key: 'pool_hot', label: 'Pool above target', describe: t => `more than ${t} °C above`, threshold: 2, points: -1,
    fires: (q, t) => !!q.s.comfort && q.s.poolC[q.i] !== null && q.s.poolC[q.i]! > q.s.comfort.pool_target_c + t,
  },
  {
    key: 'ev_low', label: 'Car short of target range', describe: t => `more than ${t} km short`, threshold: 50, points: -1,
    fires: carBelow,
  },
  {
    key: 'ev_short', label: 'Car far short of target range', describe: t => `more than ${t} km short`, threshold: 100, points: -1, required: true,
    fires: carBelow,
  },
  // Marked on the score strip, not scored: cost at real prices already says what these cost.
  {
    key: 'solar_spill', label: 'Solar exported while the home battery has room', describe: t => `battery below ${t} %`, threshold: 95, points: 0,
    fires: (q, t) => Math.min(q.s.solarW[q.i], q.s.gridExportW[q.i]) >= FLEXIBLE_W && q.s.homeSoc[q.i] !== null && q.s.homeSoc[q.i]! < t,
  },
  {
    key: 'idle_battery', label: 'Very dear import while the battery sits idle', describe: t => `battery above ${t} %, dearest 10 %`, threshold: 20, points: 0,
    fires: (q, t) => q.s.gridImportW[q.i] >= FLEXIBLE_W && q.priceRank >= 0.9 && q.s.homeSoc[q.i] !== null && q.s.homeSoc[q.i]! > t
      && q.s.batteryDischargeW[q.i] < 100,
  },
];

export type ResolvedRule = QuarterRule & { enabled: boolean };

/** A case's rules: the defaults with its `enabled`, `threshold` and `points` overrides applied. */
export function resolveRules(overrides: CriteriaOverrides = {}): ResolvedRule[] {
  return DEFAULT_RULES.map(rule => {
    const o = overrides[rule.key] ?? {};
    return { ...rule, enabled: o.enabled ?? true, threshold: o.threshold ?? rule.threshold, points: o.points ?? rule.points };
  });
}

export interface QuarterScore {
  score: number;
  /** Rule keys that fired, in rule order. */
  fired: string[];
}

export interface CaseScore {
  points: number;
  /** Sum of every quarter's score, before scaling. */
  sum: number;
  quarters: QuarterScore[];
  /** How often each rule fired. */
  counts: Record<string, number>;
  /** How many quarters scored each value, QUARTER_MIN..0. */
  histogram: Record<string, number>;
  requiredFired: string[];
  /** Your verdict when there is one, otherwise the automatic reading. */
  passed: boolean;
  verdict: Verdict | null;
}

export function scoreQuarters(s: BenchSeries, overrides: CriteriaOverrides = {}, verdict: Verdict | null = null): CaseScore {
  const rules = resolveRules(overrides).filter(r => r.enabled);
  const n = s.start.length;
  const sorted = [...s.importPrice].sort((a, b) => a - b);
  const below = (price: number) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < price) lo = mid + 1; else hi = mid; }
    return lo;
  };
  // The first quarter by which each level was reachable, found once per level.
  const reachedAt = new Map<string, number>();
  const due = (i: number): QuarterView['due'] => (reachable, start, level) => {
    if (!reachable) return false;
    if (typeof start === 'number' && start >= level) return true;
    const id = `${reachable === s.comfort?.poolReachableC ? 'pool' : 'car'}:${level}`;
    if (!reachedAt.has(id)) reachedAt.set(id, reachable.findIndex(v => v >= level));
    const at = reachedAt.get(id)!;
    return at >= 0 && i >= at + GRACE_QUARTERS;
  };

  const counts: Record<string, number> = {};
  const histogram: Record<string, number> = Object.fromEntries(
    Array.from({ length: QUARTER_MAX - QUARTER_MIN + 1 }, (_, k) => [String(QUARTER_MIN + k), 0]));
  const quarters: QuarterScore[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const q: QuarterView = { s, i, priceRank: n ? below(s.importPrice[i]) / n : 0, due: due(i) };
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
  const points = Math.max(CASE_MIN, Math.min(CASE_MAX, sum / CASE_SCALE));
  return {
    points, sum, quarters, counts, histogram, requiredFired, verdict,
    passed: verdict ? verdict === 'pass' : requiredFired.length === 0,
  };
}

/** What the bench stores per result, so run lists need no plan series. */
export interface StoredScore {
  version: number;
  /** Fingerprint of the case's overrides the score was computed with. */
  criteria: string;
  points: number;
  sum: number;
  histogram: Record<string, number>;
  counts: Record<string, number>;
  required_fired: string[];
}

export const criteriaFingerprint = (overrides: CriteriaOverrides = {}) =>
  JSON.stringify(Object.keys(overrides).sort().map(k => [k, overrides[k]]));

export function storedScore(s: BenchSeries, overrides: CriteriaOverrides = {}): StoredScore {
  const c = scoreQuarters(s, overrides);
  return {
    version: SCORER_VERSION, criteria: criteriaFingerprint(overrides), points: c.points, sum: c.sum,
    histogram: c.histogram, counts: c.counts, required_fired: c.requiredFired,
  };
}

export const isStale = (score: StoredScore | null | undefined, overrides: CriteriaOverrides = {}) =>
  !score || score.version !== SCORER_VERSION || score.criteria !== criteriaFingerprint(overrides);

/** Pass/fail from a stored score and your verdict. */
export const storedPassed = (score: StoredScore, verdict: Verdict | null) =>
  verdict ? verdict === 'pass' : score.required_fired.length === 0;

/** 100–1000; null until at least one case has a result. */
export function runScore(casePoints: readonly number[]): number | null {
  if (!casePoints.length) return null;
  const mean = casePoints.reduce((a, b) => a + b, 0) / casePoints.length;
  return Math.round(Math.min(RUN_MAX, Math.max(RUN_MIN, 1000 + 90 * mean)));
}
