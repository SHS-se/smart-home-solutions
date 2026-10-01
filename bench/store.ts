// Where the bench keeps test cases, runs and results.
//
// `DbStore` is the real one: the bench_* tables in the TEST Supabase project,
// written with the service-role key (CI only). `LocalStore` keeps the same
// records in one JSON file so the runner can be developed and checked without a
// database; its test cases are `{ dataset, recorded }` files in a directory.

import type { BenchRecorded, BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import type { Evaluation } from "../src/lib/planner-bench/evaluate.ts";
import type { StoredScore } from "../src/lib/planner-bench/score.ts";
import type { CriteriaOverrides, PlanRecord } from "../src/lib/planner-bench/types.ts";

export interface StoredScenario {
  id: string;
  name: string;
  criteria: CriteriaOverrides;
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

export interface ResultRecord extends Partial<Evaluation> {
  sha: string;
  scenario_id: string;
  status: "ok" | "error";
  error: string | null;
  cpu_ms: number | null;
  /** Identity of everything the planner was given (run.ts); a result with another hash is stale. */
  input_hash: string;
  /** What the planner did; the one stored truth a result's numbers derive from. */
  record: PlanRecord | null;
}

export interface EvaluatedResult {
  sha: string;
  scenario_id: string;
  score: StoredScore | null;
  referee_version: number | null;
}

export interface BenchStore {
  scenarios(only?: string): Promise<StoredScenario[]>;
  /** The stripped replay a scenario was uploaded as, for converting it once. */
  legacyReplayInput(id: string): Promise<unknown | null>;
  saveDataset(id: string, dataset: BenchScenarioData): Promise<void>;
  saveRecorded(id: string, recorded: BenchRecorded | null, pendingReason: string | null): Promise<void>;
  knownShas(): Promise<string[]>;
  runs(): Promise<RunSummary[]>;
  setPlannerVersion(sha: string, version: string): Promise<void>;
  /** Fold run `from` into `into`, the same planner: its verdicts and current mark move over, its results go. */
  mergeRun(from: string, into: string): Promise<void>;
  /** The input hash of each result this commit has, by scenario. */
  resultHashes(sha: string): Promise<Map<string, string | null>>;
  saveRun(run: RunRecord): Promise<void>;
  markCurrent(sha: string): Promise<void>;
  saveResult(result: ResultRecord): Promise<void>;
  /** Every successful result's score and referee version, for staleness checks. */
  evaluatedResults(): Promise<EvaluatedResult[]>;
  planRecord(sha: string, scenarioId: string): Promise<PlanRecord | null>;
  saveEvaluation(sha: string, scenarioId: string, evaluation: Evaluation): Promise<void>;
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

  async scenarios(only?: string) {
    const filter = only ? `&id=eq.${encodeURIComponent(only)}` : "";
    return await this.request(`bench_scenarios?select=id,name,criteria,dataset,recorded&archived=eq.false${filter}&order=captured_at`) as StoredScenario[];
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
    const rows = await this.request("bench_runs?select=sha&order=committed_at") as { sha: string }[];
    return rows.map(row => row.sha);
  }

  async runs() {
    return await this.request("bench_runs?select=sha,committed_at,planner_version,is_current&order=committed_at") as RunSummary[];
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
    const rows = await this.request(`bench_results?select=scenario_id,input_hash&sha=eq.${sha}`) as { scenario_id: string; input_hash: string | null }[];
    return new Map(rows.map(row => [row.scenario_id, row.input_hash]));
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
    await this.request("bench_results?on_conflict=sha,scenario_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        series: null, stats: null, outcome: null, score: null, referee_version: null,
        ...result, created_at: new Date().toISOString(),
      }),
    });
  }

  async evaluatedResults() {
    return await this.request("bench_result_summaries?select=sha,scenario_id,score,referee_version&status=eq.ok") as EvaluatedResult[];
  }

  async planRecord(sha: string, scenarioId: string) {
    const rows = await this.request(`bench_results?select=record&sha=eq.${sha}&scenario_id=eq.${scenarioId}`) as { record: PlanRecord | null }[];
    return rows[0]?.record ?? null;
  }

  async saveEvaluation(sha: string, scenarioId: string, evaluation: Evaluation) {
    await this.patch(`bench_results?sha=eq.${sha}&scenario_id=eq.${scenarioId}`, evaluation);
  }
}

interface LocalFile {
  runs: (RunRecord & { is_current?: boolean })[];
  results: ResultRecord[];
}

/** Test cases from `{ dataset, recorded }` files in `dir`; records in the JSON file at `out`. */
export class LocalStore implements BenchStore {
  constructor(private dir: string, private out: string) {}

  private async load(): Promise<LocalFile> {
    try { return JSON.parse(await Deno.readTextFile(this.out)); }
    catch { return { runs: [], results: [] }; }
  }
  private async save(file: LocalFile) { await Deno.writeTextFile(this.out, JSON.stringify(file)); }

  async scenarios(only?: string) {
    const out: StoredScenario[] = [];
    for await (const entry of Deno.readDir(this.dir)) {
      if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
      const id = entry.name.replace(/\.json$/, "");
      if (only && only !== id) continue;
      const file = JSON.parse(await Deno.readTextFile(`${this.dir}/${entry.name}`));
      out.push({ id, name: id, criteria: {}, dataset: file.dataset ?? null, recorded: file.recorded ?? null });
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
    return new Map((await this.load()).results.filter(r => r.sha === sha).map(r => [r.scenario_id, r.input_hash ?? null]));
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
    file.results = [...file.results.filter(r => !(r.sha === result.sha && r.scenario_id === result.scenario_id)), result];
    await this.save(file);
  }
  async evaluatedResults() {
    return (await this.load()).results.filter(r => r.status === "ok")
      .map(r => ({ sha: r.sha, scenario_id: r.scenario_id, score: r.score ?? null, referee_version: r.referee_version ?? null }));
  }
  async planRecord(sha: string, scenarioId: string) {
    return (await this.load()).results.find(r => r.sha === sha && r.scenario_id === scenarioId)?.record ?? null;
  }
  async saveEvaluation(sha: string, scenarioId: string, evaluation: Evaluation) {
    const file = await this.load();
    file.results = file.results.map(r => r.sha === sha && r.scenario_id === scenarioId ? { ...r, ...evaluation } : r);
    await this.save(file);
  }
}
