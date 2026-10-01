// Everything the bench derives from a plan's decisions, in one step: the
// referee's account, the totals and the score. Stored beside the decisions and
// recomputed from them whenever the referee or the scorer changes.

import type { BenchCase } from './case';
import { HOUSEHOLD, TARGETS } from './household';
import { referee, REFEREE_VERSION, type Outcome } from './referee';
import { storedScore, type StoredScore } from './score';
import { planStats } from './stats';
import type { BenchSeries, BenchStats, CriteriaOverrides, PlanRecord } from './types';

export interface Evaluation {
  series: BenchSeries;
  stats: BenchStats;
  outcome: Omit<Outcome, 'series'>;
  score: StoredScore;
  referee_version: number;
}

export function evaluate(c: BenchCase, record: PlanRecord, criteria: CriteriaOverrides): Evaluation {
  const believed = record.beliefs.import_sek_per_kwh.map(v => v ?? Number.NaN);
  const { series, ...outcome } = referee(c, HOUSEHOLD, { ...TARGETS, ...(c.comfort ?? {}) }, record.decisions, believed);
  return { series, stats: planStats(series), outcome, score: storedScore(series, criteria), referee_version: REFEREE_VERSION };
}
