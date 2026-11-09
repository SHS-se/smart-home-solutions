import { canonicalJson, loadCase, type BenchRecorded, type BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import type { Evaluation } from "../src/lib/planner-bench/evaluate.ts";
import { BASE_LANE, type LaneId } from "../src/lib/planner-bench/lanes.ts";
import type { CriteriaOverrides, PlanRecord } from "../src/lib/planner-bench/types.ts";
import { isStale, plannerRuleInputsCurrent, runScore } from "../src/lib/planner-bench/score.ts";
import { REFEREE_VERSION } from "../src/lib/planner-bench/referee.ts";
import { STATS_VERSION } from "../src/lib/planner-bench/stats.ts";
import { BENCH_TOKEN_HEADER, BENCH_URL, type VersionIdentity } from "./edge-version.ts";
import { benchInputHash } from "./execution.ts";
import { DbStore, type EvaluatedResult, type ResultKey } from "./store.ts";
import { historySource, preparation, prepareCase, type CasePreparation } from "./prepare.ts";
import { refreshTargets, requiredLanes } from "./scope.ts";
import { HISTORY_KEPT, historyCandidates, historyDrops } from "./retention.ts";

export type BenchArtifact = VersionIdentity & {
  worker: string;
  bundle_hash: string;
  committed_at: string;
  subject: string;
};
export type CaseBasis = { id: string; revision: string; dataset: BenchScenarioData; recorded: BenchRecorded };
type SavedResult = Evaluation & { input_hash: string; case_revision: string; record: PlanRecord; created_at: string; status: string };
type Preparation = Omit<CasePreparation, "source"> & { homeId: string };
type CaseTask = { scenario: string; revision: string };
type Task = { id: number; attempt: number; rules: CriteriaOverrides; force: boolean; rerecord: boolean } &
  ({ kind: "retain" } | (CaseTask & ({ kind: "prepare"; preparation: Preparation } | { kind: "solve" | "rescore"; sha: string; lane: LaneId })));
export const SHA = /^[0-9a-f]{40}$/;
export const CASE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export class EdgeBench {
  constructor(private readonly key: string, private readonly token: string, private readonly send = fetch) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(`${BENCH_URL}${path}`, { ...init, headers: {
      apikey: this.key, authorization: `Bearer ${this.key}`, "content-type": "application/json", ...init.headers,
    } });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string; message?: string };
      throw new Error(`${path.split("?")[0]} (${response.status}): ${error.message ?? error.error ?? "request failed"}`);
    }
    return await response.json() as T;
  }

  rest<T>(path: string) {
    return this.request<T>(`/rest/v1/${path}`);
  }

  rpc<T>(name: string, args: object = {}) {
    return this.request<T>(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  }

  private worker<T>(name: string, payload: object) {
    return this.request<T>(`/functions/v1/${name}`, { method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { [BENCH_TOKEN_HEADER]: this.token }, body: JSON.stringify(payload) });
  }

  async staff(token: string): Promise<boolean> {
    try {
      const user = await this.request<{ id: string }>("/auth/v1/user", { headers: { authorization: `Bearer ${token}` } });
      const [staff] = await this.rest<{ role: string }[]>(`staff_users?select=role&user_id=eq.${encodeURIComponent(user.id)}`);
      return Boolean(staff);
    } catch {
      return false;
    }
  }

  async rules() {
    const [row] = await this.rest<{ criteria: CriteriaOverrides }[]>("bench_rules?select=criteria");
    if (!row) throw new Error("The shared bench rules are missing");
    return row.criteria;
  }

  async caseBasis(id: string): Promise<CaseBasis> {
    const [row] = await this.rest<CaseBasis[]>(`bench_scenarios?select=id,revision,dataset,recorded&id=eq.${id}&archived=is.false`);
    if (!row?.dataset || !row.recorded) throw new Error("Benchmark case has no complete measured outcome");
    return row;
  }

  async artifact(sha: string): Promise<BenchArtifact> {
    const [artifact] = await this.rest<BenchArtifact[]>(`bench_edge_artifacts?sha=eq.${sha}`);
    if (!artifact || artifact.worker !== `bench-${sha}`) throw new Error(`No TEST executable registered for ${sha}`);
    return artifact;
  }

  async savedResult({ sha, scenario_id, lane }: ResultKey) {
    const [row] = await this.rest<SavedResult[]>(`bench_results?select=status,input_hash,case_revision,record,score,referee_version,outcome,created_at&sha=eq.${sha}&scenario_id=eq.${scenario_id}&lane=eq.${encodeURIComponent(lane)}`);
    return row;
  }

  async resultSummary({ sha, scenario_id, lane }: ResultKey) {
    const [row] = await this.rest<EvaluatedResult[]>(`bench_result_summaries?select=sha,scenario_id,lane,status,score,referee_version,stats_version:stats->version,input_hash,case_revision,has_record,has_evaluation,planner_generation,planner_rules,planner_criteria&sha=eq.${sha}&scenario_id=eq.${scenario_id}&lane=eq.${encodeURIComponent(lane)}`);
    return row;
  }

  async enqueue(body: Record<string, unknown>, event: "staff" | "deployment") {
    const selection = String(body.shas ?? "heads");
    const scenario = String(body.scenario ?? "");
    if (!/^(heads|all|none|[0-9a-f]{7,40}(,[0-9a-f]{7,40})*)$/.test(selection) ||
        scenario && !CASE_ID.test(scenario)) throw new Error("Invalid planner selection or case");
    const lanes = requiredLanes(String(body.scope ?? "base"));
    const runs = await new DbStore(BENCH_URL, this.key).runs();
    const history = runs.filter(run => run.status !== "unavailable").map(run => run.sha);
    const wanted = selection === "none" ? [] : refreshTargets(selection, {
      current: runs.find(run => run.is_current)?.sha, test: runs.find(run => run.is_test)?.sha,
    }, history);
    const shas = await Promise.all(wanted.map(async ref => {
      if (SHA.test(ref)) return ref;
      const matches = await this.rest<{ sha: string }[]>(`bench_edge_artifacts?select=sha&sha=like.${ref}*&limit=2`);
      if (matches.length !== 1) throw new Error(`No unique TEST executable for ${ref}; register its exact commit first`);
      return matches[0].sha;
    }));
    let captured: Preparation | null = null;
    if (selection !== "none") {
      const source = await historySource(BENCH_URL, this.key, Deno.env.get("BENCH_HOME_ID"));
      const { targets, importLimitW } = await preparation(source);
      captured = { homeId: source.homeId, targets, importLimitW };
    }
    return this.rpc<number>("bench_enqueue_edge", { p_shas: [...new Set(shas)], p_scenario: scenario || null,
      p_lanes: lanes, p_force: body.force === true, p_rerecord: body.rerecord === true,
      p_rescore: selection === "none", p_event: event, p_preparation: captured });
  }

  private async execute(task: Task) {
    const store = new DbStore(BENCH_URL, this.key);
    if (task.kind === "retain") {
      const [runs, cases] = await Promise.all([store.runs(), this.rest<{ id: string; revision: string }[]>("bench_edge_ready_cases?select=id,revision")]);
      const { candidates, duplicates } = historyCandidates(runs);
      if (candidates.length <= HISTORY_KEPT || !cases.length) return { cases, drops: duplicates };
      const revisions = new Map(cases.map(c => [c.id, c.revision]));
      const complete = (await store.evaluatedResults()).filter(r => r.lane === BASE_LANE &&
        r.status === "ok" && r.has_record && r.has_evaluation && r.case_revision === revisions.get(r.scenario_id) &&
        r.referee_version === REFEREE_VERSION && r.stats_version === STATS_VERSION &&
        !isStale(r.score, task.rules) && plannerRuleInputsCurrent(r, task.rules));
      const scores = new Map(candidates.map(run => {
        const results = complete.filter(r => r.sha === run.sha);
        return [run.sha, results.length === cases.length ? runScore(results.map(r => r.score!.points)) : null];
      }));
      // Keep history while a score is stale. A full run of all retained
      // planners brings it back into the next comparable ranking.
      const drops = candidates.every(run => scores.get(run.sha) != null)
        ? historyDrops(candidates, sha => scores.get(sha) ?? null) : [];
      return { cases, drops: [...duplicates, ...drops] };
    }
    if (task.kind === "prepare") {
      const [scenario] = await store.scenarios(task.scenario);
      if (!scenario || scenario.revision !== task.revision) throw new Error("Case changed before preparation");
      const { homeId, targets, importLimitW } = task.preparation;
      return prepareCase(store, scenario, { source: { url: BENCH_URL, key: this.key, homeId }, targets, importLimitW }, task.rerecord);
    }
    const key = { sha: task.sha, scenario_id: task.scenario, lane: task.lane };
    const [basis, existing] = await Promise.all([this.caseBasis(task.scenario), this.resultSummary(key)]);
    if (basis.revision !== task.revision) throw new Error("Case changed before execution");
    const c = loadCase(basis.dataset, basis.recorded);
    const current = existing?.status === "ok" && existing.case_revision === basis.revision && existing.has_record &&
      existing.has_evaluation && existing.referee_version === REFEREE_VERSION && existing.stats_version === STATS_VERSION &&
      !isStale(existing.score, task.rules);
    if (task.kind === "rescore") {
      if (current) return null;
      const saved = await this.savedResult(key);
      if (saved?.status !== "ok" || !saved.record || saved.case_revision !== basis.revision) throw new Error("Stored decisions changed or are missing");
      return { ...await this.score(basis, saved.record, task.lane, task.rules), created_at: saved.created_at, input_hash: saved.input_hash };
    }
    const artifact = await this.artifact(task.sha);
    if (!task.force && current && plannerRuleInputsCurrent(existing, task.rules) &&
        existing.input_hash === await benchInputHash(c, artifact.generation, task.lane, task.rules)) return null;
    return this.solve(artifact, basis, task.lane, task.rules);
  }

  async advance() {
    const task = await this.rpc<Task | null>("bench_claim_edge_task");
    if (!task) return;
    const completion = await this.execute(task).then(
      p_result => ({ p_result, p_error: null }),
      cause => ({ p_result: null, p_error: cause instanceof Error ? cause.message : "Bench task failed" }),
    );
    await this.rpc("bench_finish_edge_task", { p_task: task.id, p_attempt: task.attempt, ...completion });
  }

  async solve(artifact: BenchArtifact, basis: CaseBasis, lane: LaneId, rules: CriteriaOverrides) {
    const c = loadCase(basis.dataset, basis.recorded);
    const input_hash = await benchInputHash(c, artifact.generation, lane, rules);
    const solved = await this.worker<VersionIdentity & { input_hash: string; record: PlanRecord; cpu_ms: number }>(
      artifact.worker, { dataset: basis.dataset, recorded: basis.recorded, rules, lane });
    if (solved.sha !== artifact.sha || solved.planner_version !== artifact.planner_version ||
      solved.generation !== artifact.generation || solved.input_hash !== input_hash) {
      throw new Error("Pinned worker returned a different executable or case input");
    }
    return { record: solved.record, cpu_ms: solved.cpu_ms, input_hash, ...await this.score(basis, solved.record, lane, rules) };
  }

  private score(basis: CaseBasis, record: PlanRecord, lane: LaneId, rules: CriteriaOverrides) {
    return this.worker<Evaluation>("planner-bench-score", { dataset: basis.dataset, recorded: basis.recorded, record, lane, rules });
  }

  /** Recompute independently without changing the Actions reference result. */
  async verify(sha: string, scenario_id: string) {
    const [artifact, basis, rules, expected] = await Promise.all([
      this.artifact(sha), this.caseBasis(scenario_id), this.rules(),
      this.savedResult({ sha, scenario_id, lane: BASE_LANE }),
    ]);
    if (expected?.status !== "ok" || expected.case_revision !== basis.revision) {
      throw new Error("The Actions reference is missing or stale");
    }
    const solved = await this.solve(artifact, basis, BASE_LANE, rules);
    const matches = {
      input: expected.input_hash === solved.input_hash,
      decisions: canonicalJson(expected.record.decisions) === canonicalJson(solved.record.decisions),
      score: canonicalJson(expected.score) === canonicalJson(solved.score),
      verdict: canonicalJson(expected.outcome) === canonicalJson(solved.outcome),
      referee: expected.referee_version === solved.referee_version,
    };
    if (Object.values(matches).every(Boolean)) {
      const saved = await this.rpc<boolean>("bench_record_edge_parity", { p_sha: sha, p_case: scenario_id,
        p_revision: basis.revision, p_reference_at: expected.created_at, p_hash: solved.input_hash,
        p_rules: rules, p_bundle: artifact.bundle_hash });
      if (!saved) throw new Error("The reference changed during Edge verification");
    }
    return { sha, scenario_id, matches, points: solved.score.points };
  }
}
