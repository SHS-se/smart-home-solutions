// Everything the bench derives from a plan's decisions, in one step: the
// referee's account, the opportunity audit, the totals and the score. Stored
// beside the decisions and recomputed from them whenever the referee or the
// scorer changes.

import { caseTargets, type BenchCase } from './case';
import { HOUSEHOLD } from './household';
import { BASE_LANE, type LaneId } from './lanes';
import { auditOpportunities } from './opportunities';
import { referee, REFEREE_VERSION, type Outcome } from './referee';
import { serviceGuard, storedScore, type StoredScore } from './score';
import { planStats } from './stats';
import type { BenchSeries, BenchStats, CriteriaOverrides, PlanRecord } from './types';

export interface Evaluation {
  series: BenchSeries;
  stats: BenchStats;
  outcome: Omit<Outcome, 'series'>;
  score: StoredScore;
  referee_version: number;
}

/**
 * @param lane the lane the plan was made under. It decides which prices the
 *   planner could have known, and so which findings count against it.
 */
export function evaluate(c: BenchCase, record: PlanRecord, criteria: CriteriaOverrides, lane: LaneId = BASE_LANE): Evaluation {
  const believed = record.beliefs.import_sek_per_kwh.map(v => v ?? Number.NaN);
  const targets = caseTargets(c);
  // Checked first, so a case with unusable criteria is not replayed at all.
  const guard = serviceGuard(criteria);
  const { series, ...outcome } = referee(c, HOUSEHOLD, targets, record.decisions, believed);
  series.audit = auditOpportunities(c, HOUSEHOLD, targets, record.decisions, lane, guard);
  return { series, stats: planStats(series), outcome, score: storedScore(series, criteria), referee_version: REFEREE_VERSION };
}
