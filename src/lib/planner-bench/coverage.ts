// One definition of which saved results can enter a measured comparison.
import { REFEREE_VERSION } from './referee.ts';
import { isStale, plannerRuleInputsCurrent, runScore, storedPassed } from './score.ts';
import { statsCurrent } from './stats.ts';
import type { BenchResultSummary, BenchScenario, CriteriaOverrides } from './types.ts';

type CaseHead = Pick<BenchScenario, 'id' | 'revision' | 'dataset' | 'recorded_at'>;
export type ResultState = 'waiting' | 'missing' | 'inputs-changed' | 'needs-rescore' | 'error' | 'scored';

export function resultState(c: CaseHead, result: BenchResultSummary | undefined, rules: CriteriaOverrides): ResultState {
  if (!c.dataset || !c.recorded_at) return 'waiting';
  if (!result) return 'missing';
  if (result.case_revision !== c.revision) return 'inputs-changed';
  if (result.status === 'error') return 'error';
  if (!result.has_record) return 'inputs-changed';
  if (!plannerRuleInputsCurrent(result, rules)) return 'inputs-changed';
  if (!result.has_evaluation || !statsCurrent(result.stats) || !result.outcome || result.referee_version !== REFEREE_VERSION
    || isStale(result.score, rules)) return 'needs-rescore';
  return 'scored';
}

/** Each run has the same denominator. Partial scores are never suite scores. */
export function runCoverage(cases: CaseHead[], results: Map<string, BenchResultSummary>, rules: CriteriaOverrides) {
  const scores = new Map<string, { points: number; passed: boolean } | null>();
  let ready = 0;
  for (const c of cases) {
    if (c.dataset && c.recorded_at) ready++;
    const result = results.get(c.id);
    scores.set(c.id, resultState(c, result, rules) === 'scored'
      ? { points: result!.score!.points, passed: storedPassed(result!.score!, null) } : null);
  }
  const points = [...scores.values()].filter(s => s !== null).map(s => s.points);
  return { ready, scored: points.length, scores, score: points.length === ready ? runScore(points) : null };
}
