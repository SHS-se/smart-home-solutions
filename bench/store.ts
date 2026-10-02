// Where the bench keeps test cases, runs and results.
//
// `DbStore` is the real one: the bench_* tables in the TEST Supabase project,
// written with the service-role key (CI only). `LocalStore` keeps the same
// records in one JSON file so the runner can be developed and checked without a
// database; its test cases are `{ dataset, recorded }` files in a directory.

import type { BenchRecorded, BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import type { Evaluation } from "../src/lib/planner-bench/evaluate.ts";
import type { StoredScore } from "../src/lib/planner-bench/score.ts";
import type { LaneId } from "../src/lib/planner-bench/lanes.ts";
import type { CriteriaOverrides, PlanRecord } from "../src/lib/planner-bench/types.ts";

export interface StoredScenario {
  id: string;
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
  status: "running" | "done" | "failed";
  error?: string | null;
  finished_at?: string | null;
  /** What the planner's code does (planner-version.ts); commits sharing it share one entry. */
  planner_version?: string | null;
}

export interface RunSummary {
  sha: string;
  committed_at: string;
  planner_version: string | null;
  is_current: boolean;
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
  status: "ok" | "error";
  error: string | null;
  cpu_ms: number | null;
  /** Identity of everything the planner was given (run.ts); a result with another hash is stale. */
  input_hash: string;
  /** What the planner did; the one stored truth a result's numbers derive from. */
  record: PlanRecord | null;
}

export interface EvaluatedResult extends ResultKey {
  status: "ok" | "error";
  error: string | null;
  score: StoredScore | null;
  referee_version: number | null;
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
  setPlannerVersion(sha: string, version: string): Promise<void>;
  /** Fold run `from` into `into`, the same planner: its verdicts and current mark move over, its results go. */
  mergeRun(from: string, into: string): Promise<void>;
  /** The input hash of each result this commit has, by `laneKey`. */
  resultHashes(sha: string): Promise<Map<string, string | null>>;
  saveRun(run: RunRecord): Promise<void>;
  markCurrent(sha: string): Promise<void>;
  saveResult(result: ResultRecord): Promise<void>;
  /** Every result, including planner errors, for complete rescore coverage checks. */
  evaluatedResults(): Promise<EvaluatedResult[]>;
  planRecord(key: ResultKey): Promise<PlanRecord | null>;
  saveEvaluation(key: ResultKey, evaluation: Evaluation): Promise<void>;
}

export class DbStore implements BenchStore {
  constructor(private url: string, private key: string) {}

  private async request(path: string, init: RequestInit = {}) {
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
    return await this.pages<StoredScenario>(`bench_scenarios?select=id,name,dataset,recorded,archived${archived}${filter}&order=captured_at,id`);
  }

  async legacyReplayInput(id: string) {
    const rows = await this.request(`bench_scenarios?select=input&id=eq.${id}`) as { input: unknown }[];
    return rows[0]?.input ?? null;
  }

  async saveDataset(id: string, dataset: BenchScenarioData) {
    await this.patch(`bench_scenarios?id=eq.${id}`, { dataset, captured_at: dataset.start });
  }

  async saveRecorded(id: string, recorded: BenchRecorded | null, pendingReason: string | null) {
    await this.patch(`bench_scenarios?id=eq.${id}`, { ...(recorded ? { recorded } : {}), pending_reason: pendingReason });
  }

  async knownShas() {
    const rows = await this.pages<{ sha: string }>("bench_runs?select=sha&order=committed_at,sha");
    return rows.map(row => row.sha);
  }

  async runs() {
    return await this.pages<RunSummary>("bench_runs?select=sha,committed_at,planner_version,is_current&order=committed_at,sha");
  }

  async setPlannerVersion(sha: string, version: string) {
    await this.patch(`bench_runs?sha=eq.${sha}`, { planner_version: version });
  }

  async mergeRun(from: string, into: string) {
    const verdicts = await this.request(`bench_verdicts?select=scenario_id,verdict,note,decided_by,decided_at&sha=eq.${from}`) as Record<string, unknown>[];
    if (verdicts.length) {
      await this.request("bench_verdicts?on_conflict=sha,scenario_id", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(verdicts.map(verdict => ({ ...verdict, sha: into }))),
      });
    }
    const [run] = await this.request(`bench_runs?select=is_current&sha=eq.${from}`) as { is_current: boolean }[];
    if (run?.is_current) await this.markCurrent(into);
    // Results and verdicts cascade.
    await this.request(`bench_runs?sha=eq.${from}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }

  async resultHashes(sha: string) {
    const rows = await this.pages<{ scenario_id: string; lane: LaneId; input_hash: string | null }>(`bench_results?select=scenario_id,lane,input_hash&sha=eq.${sha}&order=scenario_id,lane`);
    return new Map(rows.map(row => [laneKey(row.scenario_id, row.lane), row.input_hash]));
  }

  async saveRun(run: RunRecord) {
    await this.request("bench_runs?on_conflict=sha", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(run),
    });
  }

  async markCurrent(sha: string) {
    await this.patch("bench_runs?is_current=eq.true", { is_current: false });
    await this.patch(`bench_runs?sha=eq.${sha}`, { is_current: true });
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
    return await this.pages<EvaluatedResult>("bench_result_summaries?select=sha,scenario_id,lane,status,error,score,referee_version&order=sha,scenario_id,lane");
  }

  private where = ({ sha, scenario_id, lane }: ResultKey) =>
    `sha=eq.${sha}&scenario_id=eq.${scenario_id}&lane=eq.${encodeURIComponent(lane)}`;

  async planRecord(key: ResultKey) {
    const rows = await this.request(`bench_results?select=record&${this.where(key)}`) as { record: PlanRecord | null }[];
    return rows[0]?.record ?? null;
  }

  async saveEvaluation(key: ResultKey, evaluation: Evaluation) {
    await this.patch(`bench_results?${this.where(key)}`, evaluation);
  }
}

const same = (a: ResultKey, b: ResultKey) => a.sha === b.sha && a.scenario_id === b.scenario_id && a.lane === b.lane;

interface LocalFile {
  runs: (RunRecord & { is_current?: boolean })[];
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
      out.push({ id, name: id, archived: file.archived === true, dataset: file.dataset ?? null, recorded: file.recorded ?? null });
    }
    return out.sort((a, b) => (a.dataset?.start ?? "").localeCompare(b.dataset?.start ?? ""));
  }
  legacyReplayInput() { return Promise.resolve(null); }
  private async rewrite(id: string, change: Record<string, unknown>) {
    const path = `${this.dir}/${id}.json`;
    await Deno.writeTextFile(path, JSON.stringify({ ...JSON.parse(await Deno.readTextFile(path)), ...change }));
  }
  async saveDataset(id: string, dataset: BenchScenarioData) { await this.rewrite(id, { dataset }); }
  async saveRecorded(id: string, recorded: BenchRecorded | null) { if (recorded) await this.rewrite(id, { recorded }); }
  async knownShas() { return (await this.load()).runs.map(run => run.sha); }
  async runs() {
    return (await this.load()).runs.map(run => ({
      sha: run.sha, committed_at: run.committed_at, planner_version: run.planner_version ?? null, is_current: !!run.is_current,
    })).sort((a, b) => a.committed_at.localeCompare(b.committed_at));
  }
  async setPlannerVersion(sha: string, version: string) {
    const file = await this.load();
    file.runs = file.runs.map(run => run.sha === sha ? { ...run, planner_version: version } : run);
    await this.save(file);
  }
  async mergeRun(from: string, into: string) {
    const file = await this.load();
    const moved = file.runs.find(run => run.sha === from)?.is_current;
    file.runs = file.runs.filter(run => run.sha !== from).map(run => moved && run.sha === into ? { ...run, is_current: true } : run);
    file.results = file.results.filter(result => result.sha !== from);
    await this.save(file);
  }
  async resultHashes(sha: string) {
    return new Map((await this.load()).results.filter(r => r.sha === sha).map(r => [laneKey(r.scenario_id, r.lane), r.input_hash ?? null]));
  }
  async saveRun(run: RunRecord) {
    const file = await this.load();
    const old = file.runs.find(r => r.sha === run.sha);
    file.runs = [...file.runs.filter(r => r.sha !== run.sha), { ...old, ...run }];
    await this.save(file);
  }
  async markCurrent(sha: string) {
    const file = await this.load();
    file.runs = file.runs.map(run => ({ ...run, is_current: run.sha === sha }));
    await this.save(file);
  }
  async saveResult(result: ResultRecord) {
    const file = await this.load();
    file.results = [...file.results.filter(r => !same(r, result)), result];
    await this.save(file);
  }
  async evaluatedResults() {
    return (await this.load()).results
      .map(r => ({ sha: r.sha, scenario_id: r.scenario_id, lane: r.lane, status: r.status, error: r.error, score: r.score ?? null, referee_version: r.referee_version ?? null }));
  }
  async planRecord(key: ResultKey) {
    return (await this.load()).results.find(r => same(r, key))?.record ?? null;
  }
  async saveEvaluation(key: ResultKey, evaluation: Evaluation) {
    const file = await this.load();
    file.results = file.results.map(r => same(r, key) ? { ...r, ...evaluation } : r);
    await this.save(file);
  }
}
