// Where the bench keeps test cases, runs and results.
//
// `DbStore` is the real one: the bench_* tables in the TEST Supabase project,
// written with the service-role key (CI only). `LocalStore` keeps the same
// records in one JSON file so the runner can be developed and checked without a
// database; its test cases come from replay files in a directory.

import { stripReplay } from "../src/lib/planner-bench/strip.ts";
import type { StoredScore } from "../src/lib/planner-bench/score.ts";
import type { BenchInput, BenchSeries, BenchStats, CriteriaOverrides } from "../src/lib/planner-bench/types.ts";

export interface StoredScenario {
  id: string;
  name: string;
  input: BenchInput;
  criteria: CriteriaOverrides;
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

export interface ResultRecord {
  sha: string;
  scenario_id: string;
  status: "ok" | "error";
  error: string | null;
  cpu_ms: number | null;
  series: BenchSeries | null;
  stats: BenchStats | null;
  score: StoredScore | null;
}

export interface ScoredResult {
  sha: string;
  scenario_id: string;
  score: StoredScore | null;
}

export interface BenchStore {
  scenarios(only?: string): Promise<StoredScenario[]>;
  knownShas(): Promise<string[]>;
  runs(): Promise<RunSummary[]>;
  setPlannerVersion(sha: string, version: string): Promise<void>;
  /** Fold run `from` into `into`, the same planner: its verdicts and current mark move over, its results go. */
  mergeRun(from: string, into: string): Promise<void>;
  /** Scenario ids that already have a result for this commit (successful or not). */
  resultIds(sha: string): Promise<Set<string>>;
  saveRun(run: RunRecord): Promise<void>;
  markCurrent(sha: string): Promise<void>;
  saveResult(result: ResultRecord): Promise<void>;
  /** Every successful result's stored score, for staleness checks. */
  scoredResults(): Promise<ScoredResult[]>;
  series(sha: string, scenarioId: string): Promise<BenchSeries | null>;
  saveScore(sha: string, scenarioId: string, score: StoredScore): Promise<void>;
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

  async scenarios(only?: string) {
    const filter = only ? `&id=eq.${encodeURIComponent(only)}` : "";
    return await this.request(`bench_scenarios?select=id,name,input,criteria&archived=eq.false${filter}&order=captured_at`) as StoredScenario[];
  }

  async knownShas() {
    const rows = await this.request("bench_runs?select=sha&order=committed_at") as { sha: string }[];
    return rows.map(row => row.sha);
  }

  async runs() {
    return await this.request("bench_runs?select=sha,committed_at,planner_version,is_current&order=committed_at") as RunSummary[];
  }

  async setPlannerVersion(sha: string, version: string) {
    await this.request(`bench_runs?sha=eq.${sha}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ planner_version: version }),
    });
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

  async resultIds(sha: string) {
    const rows = await this.request(`bench_results?select=scenario_id&sha=eq.${sha}`) as { scenario_id: string }[];
    return new Set(rows.map(row => row.scenario_id));
  }

  async saveRun(run: RunRecord) {
    await this.request("bench_runs?on_conflict=sha", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(run),
    });
  }

  async markCurrent(sha: string) {
    await this.request("bench_runs?is_current=eq.true", {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ is_current: false }),
    });
    await this.request(`bench_runs?sha=eq.${sha}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ is_current: true }),
    });
  }

  async saveResult(result: ResultRecord) {
    await this.request("bench_results?on_conflict=sha,scenario_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ ...result, created_at: new Date().toISOString() }),
    });
  }

  async scoredResults() {
    return await this.request("bench_result_summaries?select=sha,scenario_id,score&status=eq.ok") as ScoredResult[];
  }

  async series(sha: string, scenarioId: string) {
    const rows = await this.request(`bench_results?select=series&sha=eq.${sha}&scenario_id=eq.${scenarioId}`) as { series: BenchSeries | null }[];
    return rows[0]?.series ?? null;
  }

  async saveScore(sha: string, scenarioId: string, score: StoredScore) {
    await this.request(`bench_results?sha=eq.${sha}&scenario_id=eq.${scenarioId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ score }),
    });
  }
}

interface LocalFile {
  runs: (RunRecord & { is_current?: boolean })[];
  results: ResultRecord[];
}

/** Test cases from replay files in `dir`; records in the JSON file at `out`. */
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
      const stripped = stripReplay(JSON.parse(await Deno.readTextFile(`${this.dir}/${entry.name}`)));
      out.push({ id, name: id, input: stripped.input, criteria: {} });
    }
    return out.sort((a, b) => a.input.snapshot.captured_at.localeCompare(b.input.snapshot.captured_at));
  }
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
  async resultIds(sha: string) {
    return new Set((await this.load()).results.filter(r => r.sha === sha).map(r => r.scenario_id));
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
  async scoredResults() {
    return (await this.load()).results.filter(r => r.status === "ok").map(r => ({ sha: r.sha, scenario_id: r.scenario_id, score: r.score ?? null }));
  }
  async series(sha: string, scenarioId: string) {
    return (await this.load()).results.find(r => r.sha === sha && r.scenario_id === scenarioId)?.series ?? null;
  }
  async saveScore(sha: string, scenarioId: string, score: StoredScore) {
    const file = await this.load();
    file.results = file.results.map(r => r.sha === sha && r.scenario_id === scenarioId ? { ...r, score } : r);
    await this.save(file);
  }
}
