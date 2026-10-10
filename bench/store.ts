// Where the bench keeps test cases, runs and results.
//
// `DbStore` is the real one: the bench_* tables in the TEST Supabase project,
// written with the service-role key (CI only). `LocalStore` keeps the same
// records in one JSON file so the runner can be developed and checked without a
// database; its test cases are `{ dataset, recorded }` files in a directory.

import { canonicalJson, sha256, type BenchRecorded, type BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import type { Evaluation } from "../src/lib/planner-bench/evaluate.ts";
import type { StoredScore } from "../src/lib/planner-bench/score.ts";
import type { LaneId } from "../src/lib/planner-bench/lanes.ts";
import type { BenchRun, CriteriaOverrides, PlanRecord } from "../src/lib/planner-bench/types.ts";

/** Only the derived fields whose dependencies changed cross the database boundary. */
export type EvaluationMutation =
  | { kind: "score"; score: StoredScore }
  | { kind: "audit-score"; score: StoredScore; audit: NonNullable<Evaluation["series"]["audit"]> }
  | { kind: "evaluation"; value: Evaluation };

export function evaluationMutation(previous: EvaluatedResult, value: Evaluation): EvaluationMutation {
  if (!previous.has_evaluation || previous.referee_version !== value.referee_version || previous.stats_version !== value.stats.version) {
    return { kind: "evaluation", value };
  }
  if (previous.score?.criteria === value.score.criteria && canonicalJson(previous.score?.audit) === canonicalJson(value.score.audit)) {
    return { kind: "score", score: value.score };
  }
  return { kind: "audit-score", score: value.score, audit: value.series.audit! };
}

export interface StoredScenario {
  id: string;
  revision: string;
  name: string;
  archived: boolean;
  /** The test case; null for a scenario still held as a replay. */
  dataset: BenchScenarioData | null;
  /** What was recorded for its window; null until the window has passed. */
  recorded: BenchRecorded | null;
}

export interface RunRecord {
  sha: string;
  short_sha: string;
  committed_at: string;
  subject: string;
  branch: string | null;
  status: BenchRun["status"];
  error?: string | null;
  finished_at?: string | null;
  /** What the planner's code does (planner-version.ts), independent of commit identity. */
  planner_version?: string | null;
}

export interface RunSummary {
  status: BenchRun["status"];
  error: string | null;
  sha: string;
  committed_at: string;
  planner_version: string | null;
  is_current: boolean;
  is_test: boolean;
}

/** One result: a planner commit, a test case and the lane it was planned under. */
export interface ResultKey {
  sha: string;
  scenario_id: string;
  lane: LaneId;
}

/** `${scenario_id}|${lane}`: a result's place within one commit. */
export const laneKey = (scenarioId: string, lane: LaneId) => `${scenarioId}|${lane}`;

export interface ResultRecord extends Partial<Evaluation>, ResultKey {
  created_at?: string;
  status: "ok" | "error";
  error: string | null;
  cpu_ms: number | null;
  /** Identity of everything the planner was given (run.ts); a result with another hash is stale. */
  input_hash: string;
  case_revision: string | null;
  /** What the planner did; the one stored truth a result's numbers derive from. */
  record: PlanRecord | null;
}

export interface EvaluatedResult extends ResultKey {
  planner_generation?: string | null;
  planner_rules?: string | null;
  planner_criteria?: string | null;
  input_hash: string | null;
  case_revision: string | null;
  created_at: string | null;
  has_record: boolean;
  has_evaluation: boolean;
  status: "ok" | "error";
  error: string | null;
  score: StoredScore | null;
  referee_version: number | null;
  /** The version of the stored totals (stats.ts); null on totals from before they carried one. */
  stats_version: number | null;
}

export interface ResultIdentity {
  planner_rules?: string | null;
  planner_criteria?: string | null;
  input_hash: string | null;
  case_revision: string | null;
  status: "ok" | "error";
  has_record: boolean;
}

export interface BenchStore {
  /** The rule overrides every case and planner is scored with. */
  rules(): Promise<CriteriaOverrides>;
  scenarios(only?: string, includeArchived?: boolean): Promise<StoredScenario[]>;
  /** The stripped replay a scenario was uploaded as, for converting it once. */
  legacyReplayInput(id: string): Promise<unknown | null>;
  saveDataset(id: string, dataset: BenchScenarioData): Promise<void>;
  saveRecorded(id: string, recorded: BenchRecorded | null, pendingReason: string | null): Promise<void>;
  knownShas(): Promise<string[]>;
  runs(): Promise<RunSummary[]>;
  /** The input hash of each result this commit has, by `laneKey`. */
  resultHashes(sha: string): Promise<Map<string, ResultIdentity>>;
  bindResultRevision(result: ResultKey & { input_hash: string; case_revision: string }): Promise<void>;
  saveRun(run: RunRecord): Promise<void>;
  /** Remove a run that is at neither branch head, with its results and verdicts (retention.ts). False when nothing was removed. */
  deleteRun(sha: string): Promise<boolean>;
  markDeployed(sha: string, environment: "production" | "test"): Promise<void>;
  saveResult(result: ResultRecord): Promise<void>;
  /** Every result, including planner errors, for complete rescore coverage checks. */
  evaluatedResults(): Promise<EvaluatedResult[]>;
  planRecord(observed: EvaluatedResult): Promise<PlanRecord | null>;
  saveEvaluation(observed: EvaluatedResult, evaluation: Evaluation): Promise<void>;
}

interface BenchTransport {
  now(): number;
  wait(ms: number): Promise<void>;
}
const transport: BenchTransport = {
  now: () => performance.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export class DbStore implements BenchStore {
  private queue: Promise<void> = Promise.resolve();
  private previousDuration: number | null = null;
  constructor(private url: string, private key: string, private timing: BenchTransport = transport) {}

  private request(path: string, init: RequestInit = {}): Promise<unknown> {
    const result = this.queue.then(async () => {
      // Leave at least as much idle time as the preceding request spent busy.
      // Queue every read/write, including callers using Promise.all.
      if (this.previousDuration !== null) await this.timing.wait(Math.max(250, this.previousDuration));
      const started = this.timing.now();
      try { return await this.performRequest(path, init); }
      finally { this.previousDuration = this.timing.now() - started; }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performRequest(path: string, init: RequestInit) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]}: ${response.status} ${await response.text()}`);
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  }

  private patch(path: string, body: unknown) {
    return this.request(path, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
  }

  /** Stable ordering plus explicit pages avoids PostgREST's default row limit. */
  private async pages<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    const pageSize = 500;
    for (;;) {
      const page = await this.request(`${path}&limit=${pageSize}&offset=${rows.length}`) as T[];
      rows.push(...page);
      // Ask for the next page even after a short page: the server may cap below our requested size.
      if (!page.length) return rows;
    }
  }

  async rules() {
    const rows = await this.request("bench_rules?select=criteria") as { criteria: CriteriaOverrides }[];
    return rows[0]?.criteria ?? {};
  }

  async scenarios(only?: string, includeArchived = false) {
    const filter = only ? `&id=eq.${encodeURIComponent(only)}` : "";
    const archived = includeArchived ? "" : "&archived=eq.false";
    return await this.pages<StoredScenario>(`bench_scenarios?select=id,revision,name,dataset,recorded,archived${archived}${filter}&order=captured_at,id`);
  }

  async legacyReplayInput(id: string) {
    const rows = await this.request(`bench_scenarios?select=input&id=eq.${id}`) as { input: unknown }[];
    return rows[0]?.input ?? null;
  }

  async saveDataset(id: string, dataset: BenchScenarioData) {
    await this.patch(`bench_scenarios?id=eq.${id}`, { dataset, captured_at: dataset.start });
  }

  async saveRecorded(id: string, recorded: BenchRecorded | null, pendingReason: string | null) {
    await this.patch(`bench_scenarios?id=eq.${id}`, { recorded, pending_reason: pendingReason });
  }

  async knownShas() {
    const rows = await this.pages<{ sha: string }>("bench_runs?select=sha&order=committed_at,sha");
    return rows.map(row => row.sha);
  }

  async runs() {
    return await this.pages<RunSummary>("bench_runs?select=sha,committed_at,planner_version,is_current,is_test,status,error&order=committed_at,sha");
  }

  async resultHashes(sha: string) {
    const rows = await this.pages<ResultIdentity & ResultKey>(`bench_result_summaries?select=scenario_id,lane,input_hash,case_revision,status,has_record,planner_rules,planner_criteria&sha=eq.${sha}&order=scenario_id,lane`);
    return new Map(rows.map(row => [laneKey(row.scenario_id, row.lane), row]));
  }

  async bindResultRevision(result: ResultKey & { input_hash: string; case_revision: string }) {
    const saved = await this.request("rpc/bench_bind_result_revision", { method: "POST", body: JSON.stringify({
      p_sha: result.sha, p_scenario: result.scenario_id, p_lane: result.lane,
      p_input_hash: result.input_hash, p_revision: result.case_revision,
    }) });
    if (saved !== true) throw new Error("Case or source decisions changed while validating the result revision.");
  }

  async saveRun(run: RunRecord) {
    await this.request("bench_runs?on_conflict=sha", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(run),
    });
  }

  async deleteRun(sha: string) {
    // The head marks are part of the condition, so a run that became a head meanwhile stays.
    const removed = await this.request(`bench_runs?sha=eq.${encodeURIComponent(sha)}&is_current=is.false&is_test=is.false`, {
      method: "DELETE", headers: { Prefer: "return=representation" },
    }) as { sha: string }[] | null;
    return (removed?.length ?? 0) === 1;
  }

  async markDeployed(sha: string, environment: "production" | "test") {
    await this.request("rpc/bench_set_deployed", { method: "POST", body: JSON.stringify({ p_sha: sha, p_environment: environment }) });
  }

  async saveResult(result: ResultRecord) {
    await this.request("bench_results?on_conflict=sha,scenario_id,lane", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        series: null, stats: null, outcome: null, score: null, referee_version: null,
        ...result, created_at: new Date().toISOString(),
      }),
    });
  }

  async evaluatedResults() {
    return await this.pages<EvaluatedResult>("bench_result_summaries?select=sha,scenario_id,lane,status,error,score,referee_version,stats_version:stats->version,input_hash,case_revision,created_at,has_record,has_evaluation,planner_generation,planner_rules,planner_criteria&order=sha,scenario_id,lane");
  }

  private where = ({ sha, scenario_id, lane }: ResultKey) =>
    `sha=eq.${sha}&scenario_id=eq.${scenario_id}&lane=eq.${encodeURIComponent(lane)}`;

  async planRecord(key: EvaluatedResult) {
    const guard = (field: string, value: string | null) => `${field}=${value === null ? "is.null" : `eq.${encodeURIComponent(value)}`}`;
    const rows = await this.request(`bench_results?select=record&${this.where(key)}&${guard("input_hash", key.input_hash)}&${guard("created_at", key.created_at)}`) as { record: PlanRecord | null }[];
    return rows[0]?.record ?? null;
  }

  async saveEvaluation(observed: EvaluatedResult, evaluation: Evaluation) {
    const { sha, scenario_id, lane, input_hash, case_revision, created_at, referee_version, score } = observed;
    const saved = await this.request("rpc/bench_save_evaluation", {
      method: "POST", body: JSON.stringify({ p_update: {
        guard: { sha, scenario_id, lane, input_hash, case_revision, created_at, referee_version, score },
        ...evaluationMutation(observed, evaluation),
      } }),
    });
    if (saved !== true) throw new Error("Benchmark source or evaluation changed during rescore; rerun with fresh metadata.");
  }
}

const same = (a: ResultKey, b: ResultKey) => a.sha === b.sha && a.scenario_id === b.scenario_id && a.lane === b.lane;

interface LocalFile {
  runs: (RunRecord & { is_current?: boolean; is_test?: boolean })[];
  results: ResultRecord[];
  rules?: CriteriaOverrides;
}

/** Test cases from `{ dataset, recorded }` files in `dir`; records in the JSON file at `out`. */
export class LocalStore implements BenchStore {
  constructor(private dir: string, private out: string) {}

  private async load(): Promise<LocalFile> {
    try { return JSON.parse(await Deno.readTextFile(this.out)); }
    catch (error) {
      if (error instanceof Deno.errors.NotFound) return { runs: [], results: [] };
      throw error;
    }
  }
  private async save(file: LocalFile) { await Deno.writeTextFile(this.out, JSON.stringify(file)); }

  async rules() { return (await this.load()).rules ?? {}; }

  async scenarios(only?: string, includeArchived = false) {
    const out: StoredScenario[] = [];
    for await (const entry of Deno.readDir(this.dir)) {
      if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
      const id = entry.name.replace(/\.json$/, "");
      if (only && only !== id) continue;
      const file = JSON.parse(await Deno.readTextFile(`${this.dir}/${entry.name}`));
      if (file.archived && !includeArchived) continue;
      const { origin: _origin, ...dataset } = file.dataset ?? {};
      const { recorded_at: _at, ...recorded } = file.recorded ?? {};
      const revision = await sha256(canonicalJson({ dataset, recorded }));
      out.push({ id, revision, name: id, archived: file.archived === true, dataset: file.dataset ?? null, recorded: file.recorded ?? null });
    }
    return out.sort((a, b) => (a.dataset?.start ?? "").localeCompare(b.dataset?.start ?? ""));
  }
  legacyReplayInput() { return Promise.resolve(null); }
  private async rewrite(id: string, change: Record<string, unknown>) {
    const path = `${this.dir}/${id}.json`;
    await Deno.writeTextFile(path, JSON.stringify({ ...JSON.parse(await Deno.readTextFile(path)), ...change }));
  }
  async saveDataset(id: string, dataset: BenchScenarioData) { await this.rewrite(id, { dataset }); }
  async saveRecorded(id: string, recorded: BenchRecorded | null, pending_reason: string | null) { await this.rewrite(id, { recorded, pending_reason }); }
  async knownShas() { return (await this.load()).runs.map(run => run.sha); }
  async runs() {
    return (await this.load()).runs.map(run => ({
      sha: run.sha, committed_at: run.committed_at, status: run.status, error: run.error ?? null, planner_version: run.planner_version ?? null, is_current: !!run.is_current, is_test: !!run.is_test,
    })).sort((a, b) => a.committed_at.localeCompare(b.committed_at));
  }
  async resultHashes(sha: string) {
    return new Map((await this.load()).results.filter(r => r.sha === sha).map(r => [laneKey(r.scenario_id, r.lane), {
      input_hash: r.input_hash ?? null, case_revision: r.case_revision ?? null, status: r.status, has_record: r.record != null,
      planner_rules: r.record?.planner_rules ?? null,
      planner_criteria: r.record?.planner_criteria ?? null,
    }]));
  }
  async bindResultRevision(result: ResultKey & { input_hash: string; case_revision: string }) {
    const file = await this.load();
    const row = file.results.find(r => same(r, result));
    const scenario = (await this.scenarios(result.scenario_id))[0];
    if (!row || row.input_hash !== result.input_hash || row.status !== "ok" || !row.record || scenario?.revision !== result.case_revision) {
      throw new Error("Case or source decisions changed while validating the result revision.");
    }
    row.case_revision = result.case_revision;
    await this.save(file);
  }
  async saveRun(run: RunRecord) {
    const file = await this.load();
    const old = file.runs.find(r => r.sha === run.sha);
    file.runs = [...file.runs.filter(r => r.sha !== run.sha), { ...old, ...run }];
    await this.save(file);
  }
  async deleteRun(sha: string) {
    const file = await this.load();
    if (!file.runs.some(run => run.sha === sha && !run.is_current && !run.is_test)) return false;
    file.runs = file.runs.filter(run => run.sha !== sha);
    file.results = file.results.filter(result => result.sha !== sha);
    await this.save(file);
    return true;
  }
  async markDeployed(sha: string, environment: "production" | "test") {
    const file = await this.load();
    if (!file.runs.some(run => run.sha === sha)) throw new Error(`Unknown deployed planner: ${sha}`);
    const field = environment === "production" ? "is_current" : "is_test";
    file.runs = file.runs.map(run => ({ ...run, [field]: run.sha === sha }));
    await this.save(file);
  }
  async saveResult(result: ResultRecord) {
    const file = await this.load();
    file.results = [...file.results.filter(r => !same(r, result)), { ...result, created_at: new Date().toISOString() }];
    await this.save(file);
  }
  async evaluatedResults() {
    return (await this.load()).results
      .map(r => ({ sha: r.sha, scenario_id: r.scenario_id, lane: r.lane, status: r.status, error: r.error,
        score: r.score ?? null, referee_version: r.referee_version ?? null, stats_version: r.stats?.version ?? null, input_hash: r.input_hash ?? null, case_revision: r.case_revision ?? null,
        created_at: r.created_at ?? null, has_record: r.record != null,
        planner_generation: r.record?.generation ?? null, planner_rules: r.record?.planner_rules ?? null,
        planner_criteria: r.record?.planner_criteria ?? null,
        has_evaluation: r.series != null && r.stats != null && r.outcome != null }));
  }
  async planRecord(key: EvaluatedResult) {
    return (await this.load()).results.find(r => same(r, key)
      && (r.input_hash ?? null) === key.input_hash && (r.created_at ?? null) === key.created_at)?.record ?? null;
  }
  async saveEvaluation(key: EvaluatedResult, evaluation: Evaluation) {
    const file = await this.load();
    const row = file.results.find(r => same(r, key));
    const scenario = (await this.scenarios(key.scenario_id))[0];
    const mutation = evaluationMutation(key, evaluation);
    if (!row || row.status !== "ok" || !row.record || (row.input_hash ?? null) !== key.input_hash
      || row.case_revision !== key.case_revision || scenario?.revision !== key.case_revision || !scenario.recorded
      || (row.created_at ?? null) !== key.created_at || (row.referee_version ?? null) !== key.referee_version
      || canonicalJson(row.score ?? null) !== canonicalJson(key.score)
      || (mutation.kind !== "evaluation" && (row.series == null || row.stats == null || row.outcome == null))) {
      throw new Error("Benchmark source or evaluation changed during rescore; rerun with fresh metadata.");
    }
    const patch = mutation.kind === "evaluation" ? mutation.value : mutation.kind === "score"
      ? { score: mutation.score } : { score: mutation.score, series: { ...row.series!, audit: mutation.audit } };
    file.results = file.results.map(r => same(r, key) ? { ...r, ...patch } : r);
    await this.save(file);
  }
}
