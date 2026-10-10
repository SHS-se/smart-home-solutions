/** User-selected lower bound: production main when the new planner was introduced. */
export const BENCH_BASELINE_SHA = "4cc6718cecdcc6b06fbc48216c504e6022fd659d";
export const BENCH_BASELINE_COMMITTED_AT = "2026-10-07T16:37:53Z";

export function retainedCommit(committedAt: string): boolean {
  const at = Date.parse(committedAt);
  if (!Number.isFinite(at)) throw new Error("Invalid benchmark commit timestamp");
  return at >= Date.parse(BENCH_BASELINE_COMMITTED_AT);
}

// History: the earlier planners kept beside the main and dev heads. Only the
// best are kept. Whenever the bench has run its planners, a planner that has
// left the dev or main head joins them and the worst is dropped. A dropped
// run goes with its results; its commit stays in git and can be run again.

/** How many earlier planners the bench keeps beside the main and dev heads. */
export const HISTORY_KEPT = 10;

export interface HistoryRun {
  sha: string;
  committed_at: string;
  planner_version: string | null;
  is_current: boolean;
  is_test: boolean;
  status: string;
}

const newestFirst = (a: HistoryRun, b: HistoryRun) => Date.parse(b.committed_at) - Date.parse(a.committed_at) || b.sha.localeCompare(a.sha);

/**
 * The runs that compete for a place in history, and the ones that hold no
 * score of their own: a commit whose planner code is the same as a branch
 * head's, or as a newer commit's, scores what that one scores.
 */
export function historyCandidates(runs: readonly HistoryRun[]): { candidates: HistoryRun[]; duplicates: string[] } {
  const seen = new Set(runs.filter(run => run.is_current || run.is_test).flatMap(run => run.planner_version ?? []));
  const candidates: HistoryRun[] = [], duplicates: string[] = [];
  for (const run of runs.filter(run => !run.is_current && !run.is_test).sort(newestFirst)) {
    if (run.planner_version !== null && seen.has(run.planner_version)) { duplicates.push(run.sha); continue; }
    if (run.planner_version !== null) seen.add(run.planner_version);
    candidates.push(run);
  }
  return { candidates, duplicates };
}

/**
 * Which candidates to drop so the best `keep` remain. `score` is a run's
 * complete score on today's cases and rules, or null when it has none. A run
 * without one is not among the best and goes first, the oldest before the
 * newer; then the lowest scores, the older of two equal ones first.
 */
export function historyDrops(candidates: readonly HistoryRun[], score: (sha: string) => number | null, keep = HISTORY_KEPT): string[] {
  const excess = candidates.length - keep;
  if (excess <= 0) return [];
  const worstFirst = [...candidates].sort((a, b) => {
    const x = score(a.sha), y = score(b.sha);
    if (x === null || y === null) return x === y ? newestFirst(b, a) : x === null ? -1 : 1;
    return x - y || newestFirst(b, a);
  });
  return worstFirst.slice(0, excess).map(run => run.sha);
}

export interface HistoryStore {
  runs(): Promise<HistoryRun[]>;
  /** Remove a run that is at neither branch head, with its results. */
  deleteRun(sha: string): Promise<boolean>;
}

export interface HistoryOutcome {
  duplicates: string[];
  /** The candidates whose planners were run again because a score no longer held. */
  rerun: string[];
  dropped: { sha: string; score: number | null }[];
  kept: { sha: string; score: number | null }[];
}

/**
 * Keep the best earlier planners. Scores are compared only when every
 * candidate has one that holds today: when one does not, every candidate is
 * run again first (`solve` plans only what is missing or out of date), since a
 * score from other cases or rules says nothing about which planner is worst.
 *
 * @param scores each sha's complete current score, or null where it has none, after refreshing what can be
 *   recomputed from stored decisions; null altogether when there is no case to score on, and history is left alone.
 */
export async function keepBestHistory(
  bench: HistoryStore,
  scores: (shas: readonly string[]) => Promise<Map<string, number | null> | null>,
  solve: (shas: readonly string[]) => Promise<void>,
  keep = HISTORY_KEPT,
): Promise<HistoryOutcome> {
  const { candidates, duplicates } = historyCandidates(await bench.runs());
  for (const sha of duplicates) await bench.deleteRun(sha);
  const outcome: HistoryOutcome = { duplicates, rerun: [], dropped: [], kept: [] };
  if (candidates.length <= keep) {
    outcome.kept = candidates.map(run => ({ sha: run.sha, score: null }));
    return outcome;
  }
  const shas = candidates.map(run => run.sha);
  const unjudged = () => { outcome.kept = candidates.map(run => ({ sha: run.sha, score: null })); return outcome; };
  let score = await scores(shas);
  if (!score) return unjudged();
  const known = score;
  if (shas.some(sha => known.get(sha) == null)) {
    outcome.rerun = shas;
    await solve(shas);
    score = await scores(shas);
    if (!score) return unjudged();
    const fresh = score;
    // Not one planner could be scored: the bench is at fault, not eleven planners.
    if (shas.every(sha => fresh.get(sha) == null)) {
      throw new Error(`None of the ${shas.length} earlier planners could be scored, so none was dropped. Fix the bench run and run it again.`);
    }
  }
  const final = score;
  const drop = new Set(historyDrops(candidates, sha => final.get(sha) ?? null, keep));
  for (const sha of drop) await bench.deleteRun(sha);
  const told = (run: HistoryRun) => ({ sha: run.sha, score: final.get(run.sha) ?? null });
  outcome.dropped = candidates.filter(run => drop.has(run.sha)).map(told);
  outcome.kept = candidates.filter(run => !drop.has(run.sha)).map(told);
  return outcome;
}

export function historyMarkdown(outcome: HistoryOutcome, keep = HISTORY_KEPT): string {
  const line = ({ sha, score }: { sha: string; score: number | null }) => `- ${sha.slice(0, 8)}: ${score === null ? "no score" : score.toFixed(1)}`;
  const lines = ["## Planner bench history", `The bench keeps the ${keep} best earlier planners beside the main and dev heads.`];
  if (outcome.duplicates.length) lines.push(`Removed ${outcome.duplicates.length} commit(s) whose planner is the same as a newer commit's: ${outcome.duplicates.map(sha => sha.slice(0, 8)).join(", ")}.`);
  if (outcome.rerun.length) lines.push(`A score no longer held, so all ${outcome.rerun.length} earlier planners were run again before choosing.`);
  if (outcome.dropped.length) lines.push("", "Dropped:", ...outcome.dropped.map(line), "", "Kept:", ...outcome.kept.map(line));
  else lines.push(`Nothing to drop: ${outcome.kept.length} earlier planner(s).`);
  return lines.join("\n") + "\n";
}
