// Quarter-by-quarter scoring of a plan, and the run score built from it.
//
// Every 15-minute quarter scores an integer from -2 to +2: the rules that fire
// for the quarter add their points, and the sum is clamped. A quarter where
// nothing notable happens scores 0, so the score is a count of good and bad
// decisions rather than an average that ordinary quarters dilute.
//
// A case's points are its quarter sum divided by CASE_SCALE, clamped to
// -10..+10. The run score maps the mean case score onto 100–1000
// (550 + 45 × mean). Scoring reads only the stored plan series, so a rule
// change rescoring every run needs no planner re-run.
//
// Bump SCORER_VERSION whenever a rule or default changes, so stored scores
// are recognised as stale and recomputed.

import type { BenchSeries, CriteriaOverrides, Verdict } from './types';

export const SCORER_VERSION = 1;
export const QUARTER_MIN = -2;
export const QUARTER_MAX = 2;
export const CASE_MIN = -10;
export const CASE_MAX = 10;
/** Quarter points per case point: 10 quarter-points ≈ one case point. */
export const CASE_SCALE = 10;
export const RUN_MIN = 100;
export const RUN_MAX = 1000;
/** Pool, battery charging and car together above this count as a flexible purchase. */
export const FLEXIBLE_W = 500;

/** What a rule can see about one quarter. */
export interface QuarterView {
  s: BenchSeries;
  i: number;
  /** Share of the plan's quarters priced strictly below this one, 0–1. */
  priceRank: number;
  /** Published 25th-percentile import price, or null without published prices. */
  publishedP25: number | null;
  /** Pool + battery charging + car, W. */
  flexibleW: number;
}

export interface QuarterRule {
  key: string;
  label: string;
  describe: (threshold: number) => string;
  threshold: number;
  /** Signed points added when the rule fires. */
  points: number;
  /** A case in which this rule fires anywhere is shown as failed. */
  required?: boolean;
  fires: (q: QuarterView, threshold: number) => boolean;
}

const pct = (t: number) => `${Math.round(t * 100)} %`;
const buying = (q: QuarterView) => q.flexibleW >= FLEXIBLE_W;

export const DEFAULT_RULES: QuarterRule[] = [
  {
    key: 'pool_cold', label: 'Pool below minimum', describe: t => `< ${t} °C`, threshold: 28, points: -2, required: true,
    fires: (q, t) => q.s.poolC[q.i] !== null && q.s.poolC[q.i]! < t,
  },
  {
    key: 'pool_low', label: 'Pool below comfort band', describe: t => `< ${t} °C`, threshold: 29, points: -1,
    fires: (q, t) => q.s.poolC[q.i] !== null && q.s.poolC[q.i]! < t,
  },
  {
    key: 'pool_hot', label: 'Pool above maximum', describe: t => `> ${t} °C`, threshold: 32.5, points: -1,
    fires: (q, t) => q.s.poolC[q.i] !== null && q.s.poolC[q.i]! > t,
  },
  {
    key: 'cheap_buy', label: 'Flexible load in a cheap quarter', describe: t => `price in cheapest ${pct(t)}`, threshold: 0.25, points: 1,
    fires: (q, t) => buying(q) && q.priceRank < t,
  },
  {
    key: 'cheapest_buy', label: 'Flexible load in a very cheap quarter', describe: t => `price in cheapest ${pct(t)}`, threshold: 0.1, points: 1,
    fires: (q, t) => buying(q) && q.priceRank < t,
  },
  {
    key: 'dear_buy', label: 'Flexible load in a dear quarter', describe: t => `price in dearest ${pct(1 - t)}`, threshold: 0.75, points: -1,
    fires: (q, t) => buying(q) && q.priceRank >= t,
  },
  {
    key: 'dearest_buy', label: 'Flexible load in a very dear quarter', describe: t => `price in dearest ${pct(1 - t)}`, threshold: 0.9, points: -1,
    fires: (q, t) => buying(q) && q.priceRank >= t,
  },
  {
    key: 'estimated_buy', label: 'Flexible load at an estimated price above cheap published ones',
    describe: t => `estimated price > ${t}× published 25th percentile`, threshold: 1, points: -1,
    fires: (q, t) => buying(q) && !q.s.published[q.i] && q.publishedP25 !== null && q.s.importPrice[q.i] > q.publishedP25 * t,
  },
  {
    key: 'unplugged_charge', label: 'Car charging planned while unplugged', describe: t => `> ${t} W`, threshold: 50, points: -2, required: true,
    fires: (q, t) => q.s.carW[q.i] > t && !q.s.carConnected[q.i],
  },
  {
    key: 'solar_spill', label: 'Solar exported while the home battery has room', describe: t => `battery below ${t} %`, threshold: 95, points: -1,
    fires: (q, t) => Math.min(q.s.solarW[q.i], q.s.gridExportW[q.i]) >= FLEXIBLE_W && q.s.homeSoc[q.i] !== null && q.s.homeSoc[q.i]! < t,
  },
  {
    key: 'idle_battery', label: 'Very dear import while the battery sits idle', describe: t => `battery above ${t} %, dearest 10 %`, threshold: 20, points: -1,
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
  /** How many quarters scored each value, -2..+2. */
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
  const published = s.importPrice.filter((_, i) => s.published[i]).sort((a, b) => a - b);
  const publishedP25 = published.length ? published[Math.max(0, Math.ceil(published.length * 0.25) - 1)] : null;

  const counts: Record<string, number> = {};
  const histogram: Record<string, number> = { '-2': 0, '-1': 0, '0': 0, '1': 0, '2': 0 };
  const quarters: QuarterScore[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const q: QuarterView = {
      s, i, priceRank: n ? below(s.importPrice[i]) / n : 0, publishedP25,
      flexibleW: s.poolW[i] + s.batteryChargeW[i] + s.carW[i],
    };
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
    passed: verdict ? verdict === 'pass' : requiredFired.length === 0 && points >= 0,
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
  verdict ? verdict === 'pass' : score.required_fired.length === 0 && score.points >= 0;

/** 100–1000; null until at least one case has a result. */
export function runScore(casePoints: readonly number[]): number | null {
  if (!casePoints.length) return null;
  const mean = casePoints.reduce((a, b) => a + b, 0) / casePoints.length;
  return Math.round(Math.min(RUN_MAX, Math.max(RUN_MIN, 550 + 45 * mean)));
}
