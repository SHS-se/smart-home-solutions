// Re-evaluation owns only derived result fields. It never prepares cases, loads
// historical planner code, merges runs, or changes stored decisions/input hashes.
import { loadCase, type BenchCase } from "../src/lib/planner-bench/case.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { BASE_LANE, LANES } from "../src/lib/planner-bench/lanes.ts";
import { REFEREE_VERSION } from "../src/lib/planner-bench/referee.ts";
import { isStale, runScore, SCORER_VERSION, storedPassed } from "../src/lib/planner-bench/score.ts";
import type { BenchStore, EvaluatedResult, ResultKey, StoredScenario } from "./store.ts";

const keyOf = (r: ResultKey) => `${r.sha}/${r.scenario_id}/${r.lane}`;
const describe = (r: ResultKey) => `${r.sha.slice(0, 12)} / ${r.scenario_id} / ${r.lane}`;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

type RescoreStore = Pick<BenchStore, "scenarios" | "runs" | "evaluatedResults" | "planRecord" | "saveEvaluation">;

export interface PlannerRescoreSummary {
  sha: string;
  expectedCases: number;
  oldScore: number | null;
  oldScored: number;
  score: number | null;
  scored: number;
  passed: number;
  currentLanes: number;
  expectedLanes: number;
  plannerErrors: number;
  missingLanes: number;
}

export interface RescoreReport {
  scorerVersion: number;
  refereeVersion: number;
  scenarioFilter: string | null;
  readyCases: number;
  archivedCases: number;
  unreadyCases: number;
  eligible: number;
  processed: number;
  alreadyCurrent: number;
  verifiedCurrent: number;
  missingRecords: number;
  evaluationErrors: number;
  verificationErrors: number;
  plannerErrors: number;
  missingLanes: number;
  planners: PlannerRescoreSummary[];
  issues: string[];
}

export class RescoreIncompleteError extends Error {
  constructor(readonly report: RescoreReport) {
    super(`Rescore incomplete: ${report.missingRecords} missing decision records, ${report.evaluationErrors} evaluation errors, ${report.verificationErrors} verification errors. See the coverage report; restore missing decisions or rerun the named planner/case/lane, then rescore.`);
    this.name = "RescoreIncompleteError";
  }
}

/** Recompute stale successful results, then read storage again to prove coverage. */
export async function rescoreExisting(bench: RescoreStore, onlyScenario?: string): Promise<RescoreReport> {
  const [scenarios, runs, before] = await Promise.all([
    bench.scenarios(onlyScenario, true), bench.runs(), bench.evaluatedResults(),
  ]);
  const report: RescoreReport = {
    scorerVersion: SCORER_VERSION, refereeVersion: REFEREE_VERSION,
    scenarioFilter: onlyScenario ?? null, readyCases: 0, archivedCases: 0, unreadyCases: 0, eligible: 0,
    processed: 0, alreadyCurrent: 0, verifiedCurrent: 0,
    missingRecords: 0, evaluationErrors: 0, verificationErrors: 0,
    plannerErrors: 0, missingLanes: 0, planners: [], issues: [],
  };
  const cases = new Map<string, { scenario: StoredScenario; c: BenchCase }>();
  for (const scenario of scenarios) {
    if (scenario.archived) { report.archivedCases++; continue; }
    if (!scenario.dataset || !scenario.recorded) { report.unreadyCases++; continue; }
    try {
      cases.set(scenario.id, { scenario, c: loadCase(scenario.dataset, scenario.recorded) });
      report.readyCases++;
    } catch (error) {
      report.evaluationErrors++;
      report.issues.push(`${scenario.name} (${scenario.id}): invalid ready case: ${messageOf(error)}. Correct this case before rescoring.`);
    }
  }
  let criteria = new Map([...cases].map(([id, entry]) => [id, entry.scenario.criteria]));
  const current = (result: EvaluatedResult) => {
    const overrides = criteria.get(result.scenario_id);
    return !!overrides && result.status === "ok" && result.referee_version === REFEREE_VERSION && !isStale(result.score, overrides);
  };
  const eligible = before.filter(result => result.status === "ok" && cases.has(result.scenario_id));
  report.eligible = eligible.length;
  const missing = new Set<string>();
  for (const result of eligible) {
    const entry = cases.get(result.scenario_id)!;
    try {
      // Check even current results: derived scores without their source decisions
      // cannot count as complete, reproducible benchmark coverage.
      const record = await bench.planRecord(result);
      if (!record) {
        report.missingRecords++;
        missing.add(keyOf(result));
        report.issues.push(`${describe(result)}: missing stored decisions. Restore the raw record or rerun this planner/case/lane; rescore cannot reconstruct it.`);
        continue;
      }
      if (current(result)) { report.alreadyCurrent++; continue; }
      await bench.saveEvaluation(result, evaluate(entry.c, record, entry.scenario.criteria, result.lane));
      report.processed++;
    } catch (error) {
      report.evaluationErrors++;
      report.issues.push(`${describe(result)}: ${messageOf(error)}`);
    }
  }

  const [after, latestScenarios] = await Promise.all([
    bench.evaluatedResults(), bench.scenarios(onlyScenario, true),
  ]);
  criteria = new Map(latestScenarios
    .filter(scenario => !scenario.archived && scenario.dataset && scenario.recorded)
    .map(scenario => [scenario.id, scenario.criteria]));
  const afterByKey = new Map(after.map(result => [keyOf(result), result]));
  const beforeKeys = new Set(eligible.map(keyOf));
  // Newly inserted successful results are included too; concurrent writes must
  // never make this verification silently claim a stale result is current.
  const verify = new Map(eligible.map(result => [keyOf(result), result]));
  for (const result of after) {
    if (result.status === "ok" && cases.has(result.scenario_id)) verify.set(keyOf(result), result);
  }
  report.eligible = verify.size;
  for (const [key, result] of verify) {
    if (missing.has(key)) continue;
    const stored = afterByKey.get(key);
    if (!stored || !current(stored)) {
      report.verificationErrors++;
      report.issues.push(`${describe(result)}: stored result missing or scorer/referee/criteria are not current after rescore. Retry after any concurrent case edit finishes.`);
      continue;
    }
    if (!beforeKeys.has(key) && !(await bench.planRecord(stored))) {
      report.missingRecords++;
      missing.add(key);
      report.issues.push(`${describe(stored)}: concurrently added result has no stored decisions.`);
      continue;
    }
    report.verifiedCurrent++;
  }

  const shas = [...new Set([...runs.map(run => run.sha), ...before.map(result => result.sha), ...after.map(result => result.sha)])];
  for (const sha of shas) {
    const old = before.filter(r => r.sha === sha && r.lane === BASE_LANE && r.status === "ok" && cases.has(r.scenario_id) && r.score);
    const now = after.filter(r => r.sha === sha && r.lane === BASE_LANE && current(r) && !missing.has(keyOf(r)));
    let missingLanes = 0, plannerErrors = 0, currentLanes = 0;
    for (const scenarioId of cases.keys()) {
      for (const lane of LANES) {
        const result = afterByKey.get(keyOf({ sha, scenario_id: scenarioId, lane }));
        if (!result) missingLanes++;
        else if (result.status === "error") plannerErrors++;
        else if (current(result) && !missing.has(keyOf(result))) currentLanes++;
      }
    }
    report.plannerErrors += plannerErrors;
    report.missingLanes += missingLanes;
    report.planners.push({
      sha, expectedCases: cases.size, oldScore: runScore(old.map(r => r.score!.points)), oldScored: old.length,
      score: runScore(now.map(r => r.score!.points)), scored: now.length,
      passed: now.filter(r => storedPassed(r.score!, null)).length,
      currentLanes, expectedLanes: cases.size * LANES.length, plannerErrors, missingLanes,
    });
  }
  if (report.missingRecords || report.evaluationErrors || report.verificationErrors) throw new RescoreIncompleteError(report);
  return report;
}

/** Shared console and GitHub Actions summary, with explicit comparison coverage. */
export function rescoreMarkdown(report: RescoreReport): string {
  const score = (value: number | null, count: number, total: number) => `${value ?? "—"} (${count}/${total})`;
  const lines = [
    "## Planner bench rescore",
    `Scope: ${report.scenarioFilter ? `case ${report.scenarioFilter}` : "all stored cases"}.`,
    `Scorer **v${report.scorerVersion}**, referee **v${report.refereeVersion}**. Verified **${report.verifiedCurrent}/${report.eligible}** eligible successful results across all six lanes.`,
    `Processed: ${report.processed}; already current: ${report.alreadyCurrent}; missing decisions: ${report.missingRecords}; evaluation errors: ${report.evaluationErrors}; verification errors: ${report.verificationErrors}.`,
    `Cases: ${report.readyCases} ready, ${report.unreadyCases} unready, ${report.archivedCases} archived. Unready and archived cases were not changed.`,
    `Existing planner errors: ${report.plannerErrors}; absent planner/case/lanes: ${report.missingLanes}. These need planner runs, not rescoring.`,
    "",
    "Nominal scores use told/nominal only; parentheses show scored/ready cases. Passes are automatic rule verdicts. Scores with different coverage are not directly comparable.",
    "",
    "| Planner | Previous score (coverage) | Current score (coverage) | Passes / scored | Current lanes / expected | Planner errors | Missing lanes |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.planners.map(p => `| ${p.sha.slice(0, 12)} | ${score(p.oldScore, p.oldScored, p.expectedCases)} | ${score(p.score, p.scored, p.expectedCases)} | ${p.passed}/${p.scored} | ${p.currentLanes}/${p.expectedLanes} | ${p.plannerErrors} | ${p.missingLanes} |`),
  ];
  if (report.issues.length) lines.push("", "### Incomplete coverage", ...report.issues.map(issue => `- ${issue.replaceAll("\n", " ")}`));
  return lines.join("\n") + "\n";
}
