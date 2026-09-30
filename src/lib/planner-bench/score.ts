// Points for one plan, and the run score built from them.
//
// Each test case scores between -10 and +10. A criterion that is met adds its
// `pass` points, one that is missed adds its (negative) `fail` points, and one
// that does not apply to the case (no pool, car always plugged in) adds
// nothing. Phil's own verdict on the case counts as a criterion too, and
// outweighs any single automatic one.
//
// The run score maps the average case score onto 100–1000: 550 + 45 × mean.
// A run where every case scores -10 lands on 100, one where every case scores
// +10 on 1000. Scoring reads only stored totals, so changing a threshold
// rescores every run instantly; the planners are re-run only for new cases or
// new commits.

import type { BenchStats, CriteriaOverrides, Verdict } from './types';

export const CASE_MIN = -10;
export const CASE_MAX = 10;
export const RUN_MIN = 100;
export const RUN_MAX = 1000;

type Metric = (s: BenchStats) => number | null;

export interface CriterionDefinition {
  key: string;
  label: string;
  /** How the threshold reads, e.g. "≥ 28 °C". */
  describe: (threshold: number) => string;
  metric: Metric;
  /** `min`: value ≥ threshold passes. `max`: value ≤ threshold passes. */
  direction: 'min' | 'max';
  threshold: number;
  pass: number;
  fail: number;
  /** A case with a missed required criterion shows as failed even when its points add up. */
  required?: boolean;
  /** `linear` criteria scale from `pass` at the threshold to `fail` at `failAt`. */
  failAt?: number;
  format: (value: number) => string;
}

const c = (value: number, digits = 2) => `${value.toFixed(digits)}`;
const poolShare = (part: (s: BenchStats) => number): Metric =>
  s => s.pool_kwh >= 1 ? part(s) / s.pool_kwh : null;

export const DEFAULT_CRITERIA: CriterionDefinition[] = [
  {
    key: 'pool_min', label: 'Pool never below', describe: t => `≥ ${c(t, 1)} °C`,
    metric: s => s.pool_min_c, direction: 'min', threshold: 28, pass: 1, fail: -4, required: true,
    format: v => `${c(v)} °C`,
  },
  {
    key: 'pool_end', label: 'Pool at the end of the plan', describe: t => `≥ ${c(t, 1)} °C`,
    metric: s => s.pool_end_c, direction: 'min', threshold: 29, pass: 1, fail: -2,
    format: v => `${c(v)} °C`,
  },
  {
    key: 'pool_max', label: 'Pool never above', describe: t => `≤ ${c(t, 1)} °C`,
    metric: s => s.pool_max_c, direction: 'max', threshold: 32.5, pass: 1, fail: -2,
    format: v => `${c(v)} °C`,
  },
  {
    key: 'pool_cheap', label: 'Pool heat bought in the cheapest published hours', describe: t => `≥ ${Math.round(t * 100)} %`,
    metric: poolShare(s => s.pool_cheap_kwh), direction: 'min', threshold: 0.3, pass: 3, fail: -4,
    format: v => `${Math.round(v * 100)} %`,
  },
  {
    key: 'pool_estimated', label: 'Pool heat bought at estimated prices', describe: t => `≤ ${Math.round(t * 100)} %`,
    metric: poolShare(s => s.pool_estimated_kwh), direction: 'max', threshold: 0.5, pass: 2, fail: -4,
    format: v => `${Math.round(v * 100)} %`,
  },
  {
    key: 'price_paid', label: 'Import price paid vs average price', describe: t => `≤ ${Math.round(t * 100)} % (full penalty at 90 %)`,
    metric: s => s.import_price_paid !== null && s.grid_import_kwh >= 1 && s.import_price_mean > 0
      ? s.import_price_paid / s.import_price_mean : null,
    direction: 'max', threshold: 0.7, failAt: 0.9, pass: 3, fail: -3,
    format: v => `${Math.round(v * 100)} %`,
  },
  {
    key: 'ev_unplugged', label: 'Car charging planned while unplugged', describe: t => `≤ ${c(t, 1)} kWh`,
    metric: s => s.ev_unplugged_quarters > 0 ? s.ev_unplugged_kwh : null,
    direction: 'max', threshold: 0.1, pass: 1, fail: -4,
    format: v => `${c(v, 1)} kWh`,
  },
];

export const VERDICT_POINTS: Record<Verdict, number> = { pass: 2, fail: -4 };

export interface CriterionScore {
  key: string;
  label: string;
  target: string;
  value: string | null;
  points: number;
  met: boolean | null;
  required: boolean;
}

export interface CaseScore {
  points: number;
  /** Before clamping to ±10, so a reader can see how far past the limit it was. */
  raw: number;
  criteria: CriterionScore[];
  /** Phil's verdict when there is one, otherwise the automatic reading. */
  passed: boolean;
  verdict: Verdict | null;
}

export function resolveCriteria(overrides: CriteriaOverrides = {}): (CriterionDefinition & { enabled: boolean })[] {
  return DEFAULT_CRITERIA.map(definition => {
    const o = overrides[definition.key] ?? {};
    return {
      ...definition,
      enabled: o.enabled ?? true,
      threshold: o.threshold ?? definition.threshold,
      pass: o.pass ?? definition.pass,
      fail: o.fail ?? definition.fail,
    };
  });
}

export function scoreCase(stats: BenchStats, overrides: CriteriaOverrides = {}, verdict: Verdict | null = null): CaseScore {
  const criteria: CriterionScore[] = [];
  let raw = 0;
  let requiredMissed = false;
  for (const def of resolveCriteria(overrides)) {
    if (!def.enabled) continue;
    const value = def.metric(stats);
    let points = 0, met: boolean | null = null;
    if (value !== null && Number.isFinite(value)) {
      met = def.direction === 'min' ? value >= def.threshold : value <= def.threshold;
      if (def.failAt !== undefined) {
        const span = def.failAt - def.threshold;
        const along = Math.min(1, Math.max(0, (value - def.threshold) / span));
        points = def.pass + (def.fail - def.pass) * along;
      } else {
        points = met ? def.pass : def.fail;
      }
      if (!met && def.required) requiredMissed = true;
    }
    raw += points;
    criteria.push({
      key: def.key, label: def.label, target: def.describe(def.threshold),
      value: value === null ? null : def.format(value), points, met, required: !!def.required,
    });
  }
  if (verdict) {
    raw += VERDICT_POINTS[verdict];
    criteria.push({
      key: 'verdict', label: 'Your verdict', target: 'pass', value: verdict,
      points: VERDICT_POINTS[verdict], met: verdict === 'pass', required: false,
    });
  }
  const points = Math.min(CASE_MAX, Math.max(CASE_MIN, raw));
  return { points, raw, criteria, verdict, passed: verdict ? verdict === 'pass' : !requiredMissed && points >= 0 };
}

/** 100–1000; null until at least one case has a result. */
export function runScore(casePoints: readonly number[]): number | null {
  if (!casePoints.length) return null;
  const mean = casePoints.reduce((a, b) => a + b, 0) / casePoints.length;
  return Math.round(Math.min(RUN_MAX, Math.max(RUN_MIN, 550 + 45 * mean)));
}
