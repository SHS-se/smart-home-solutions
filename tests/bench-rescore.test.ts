import { assert, assertEquals, assertRejects } from "@std/assert";
import { rescoreExisting, rescoreMarkdown, RescoreIncompleteError } from "../bench/rescore.ts";
import { type EvaluatedResult, type ResultKey, type RunSummary, type StoredScenario } from "../bench/store.ts";
import { loadCase, QUARTERS, type BenchRecorded, type BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import { evaluate, type Evaluation } from "../src/lib/planner-bench/evaluate.ts";
import { LANES } from "../src/lib/planner-bench/lanes.ts";
import { REFEREE_VERSION } from "../src/lib/planner-bench/referee.ts";
import { SCORER_VERSION } from "../src/lib/planner-bench/score.ts";
import type { CriteriaOverrides, PlanRecord } from "../src/lib/planner-bench/types.ts";

const fill = (value: number) => Array<number>(QUARTERS).fill(value);
const dataset: BenchScenarioData = {
  format: "shs-bench-case", version: 1,
  origin: { kind: "manual", detail: "rescore test", created_at: "2026-09-24T00:00:00Z" },
  start: "2026-09-24T00:00:00Z", timezone: "Europe/Stockholm", location: { latitude: 59.4, longitude: 18 },
  known_prices: { import_sek_per_kwh: fill(1), export_sek_per_kwh: fill(0.4) },
  solar_forecast_w: fill(0), base_load_forecast_w: fill(500), other_devices_w: {},
  start_state: { battery_soc: 0.5, pool_water_c: 30, ev: { soc: 0.7, target_soc: 0.8 } }, comfort: { pool_c: 30, ev_km: 300 },
};
const recorded: BenchRecorded = {
  prices: { import_sek_per_kwh: fill(1), export_sek_per_kwh: fill(0.4) },
  outdoor_temperature_c: fill(20), solar_irradiance_w_per_m2: fill(0),
  history: {
    prices: { start: "2026-09-23T00:00:00Z", import_sek_per_kwh: [], export_sek_per_kwh: [] },
    grid_import_kwh: { start: "2026-08-31T22:00:00Z", kwh: [] },
  }, recorded_at: "2026-09-28T00:00:00Z",
};
const record: PlanRecord = {
  status: "ready", generation: "test", valuation: { scale: 1, pool: "none", ev: "none", battery: "none" },
  decisions: { pool_w: fill(0), ev_w: fill(0), battery_charge_w: fill(0), battery_discharge_w: fill(0) },
  beliefs: { import_sek_per_kwh: fill(1), grid_cost_sek: null }, curves: [],
};
const keyOf = (r: ResultKey) => `${r.sha}/${r.scenario_id}/${r.lane}`;

class MemoryStore {
  cases: StoredScenario[] = [
    { id: "ready", name: "Ready", archived: false, dataset, recorded },
    { id: "waiting", name: "Waiting", archived: false, dataset, recorded: null },
    { id: "archived", name: "Archived", archived: true, dataset, recorded },
  ];
  rows: EvaluatedResult[] = ["old-not-in-git", "new-not-in-git"].flatMap(sha => LANES.map(lane => ({
    sha, scenario_id: "ready", lane, status: "ok" as const, error: null, score: null, referee_version: 0,
  })));
  records = new Map(this.rows.map(row => [keyOf(row), structuredClone(record)]));
  hashes = new Map(this.rows.map(row => [keyOf(row), `immutable-${keyOf(row)}`]));
  writes: ResultKey[] = [];
  discardWrites = false;
  async rules(): Promise<CriteriaOverrides> { return {}; }
  async scenarios(only?: string, includeArchived = false) {
    return this.cases.filter(c => (!only || c.id === only) && (includeArchived || !c.archived));
  }
  async runs(): Promise<RunSummary[]> {
    return ["old-not-in-git", "new-not-in-git"].map(sha => ({ sha, committed_at: dataset.start, planner_version: null, is_current: false }));
  }
  async evaluatedResults() { return structuredClone(this.rows); }
  async planRecord(key: ResultKey) { return structuredClone(this.records.get(keyOf(key)) ?? null); }
  async saveEvaluation(key: ResultKey, evaluation: Evaluation) {
    this.writes.push(key);
    if (this.discardWrites) return;
    this.rows = this.rows.map(row => keyOf(row) === keyOf(key) ? { ...row, score: evaluation.score, referee_version: evaluation.referee_version } : row);
  }
}

Deno.test("rescore evaluates every stored lane with the real evaluator and is idempotent without changing decisions or input hashes", async () => {
  const store = new MemoryStore();
  const rawBefore = structuredClone(store.records), hashesBefore = structuredClone(store.hashes);
  const first = await rescoreExisting(store);
  assertEquals([first.processed, first.verifiedCurrent, first.eligible], [12, 12, 12]);
  assertEquals([first.readyCases, first.unreadyCases, first.archivedCases], [1, 1, 1]);
  assertEquals(first.planners.map(p => [p.scored, p.currentLanes, p.missingLanes]), [[1, 6, 0], [1, 6, 0]]);
  for (const row of store.rows) {
    assertEquals(row.score, evaluate(loadCase(dataset, recorded), record, {}, row.lane).score);
    assertEquals(row.score!.version, SCORER_VERSION);
    assertEquals(row.referee_version, REFEREE_VERSION);
  }
  const second = await rescoreExisting(store);
  assertEquals([second.processed, second.alreadyCurrent, second.verifiedCurrent], [0, 12, 12]);
  assertEquals(store.writes.length, 12);
  assertEquals(store.records, rawBefore);
  assertEquals(store.hashes, hashesBefore);
  assert(rescoreMarkdown(second).includes("12/12"));
});

Deno.test("a successful result without its decisions fails after other lanes are rescored and reports the repair", async () => {
  const store = new MemoryStore();
  store.records.delete(keyOf(store.rows[0]));
  const error = await assertRejects(() => rescoreExisting(store), RescoreIncompleteError, "missing decision records");
  assertEquals(error.report.missingRecords, 1);
  assertEquals(error.report.processed, 11);
  assertEquals(error.report.verifiedCurrent, 11);
  assert(error.report.issues.some(issue => issue.includes("Restore the raw record")));
});

Deno.test("fresh reads detect a store that did not persist an evaluation", async () => {
  const store = new MemoryStore();
  store.discardWrites = true;
  const error = await assertRejects(() => rescoreExisting(store), RescoreIncompleteError);
  assertEquals(error.report.verificationErrors, 12);
  assertEquals(error.report.verifiedCurrent, 0);
});

Deno.test("prior planner errors and absent lanes are reported without preventing rescore of successful results", async () => {
  const store = new MemoryStore();
  store.rows[0].status = "error";
  store.rows[0].error = "historical planner failed";
  store.rows.pop();
  const report = await rescoreExisting(store);
  assertEquals([report.processed, report.plannerErrors, report.missingLanes], [10, 1, 1]);
});

Deno.test("rescore-only CLI works with absent historical git objects, no subprocess permission and an unready case", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bench-rescore-test-" });
  const root = new URL("..", import.meta.url).pathname;
  try {
    const cases = `${dir}/cases`, out = `${dir}/results.json`, summary = `${dir}/summary.md`;
    await Deno.mkdir(cases);
    await Deno.writeTextFile(`${cases}/ready.json`, JSON.stringify({ dataset, recorded }));
    await Deno.writeTextFile(`${cases}/waiting.json`, JSON.stringify({ dataset, recorded: null }));
    const runs = [{ sha: "not-a-local-git-object", short_sha: "not-a-l", committed_at: dataset.start, subject: "Preserve me", branch: null, status: "done" }];
    const results = LANES.map(lane => ({ sha: runs[0].sha, scenario_id: "ready", lane, status: "ok", error: null, cpu_ms: 1, input_hash: "immutable", record, score: null, referee_version: 0 }));
    await Deno.writeTextFile(out, JSON.stringify({ runs, results }));
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-check", "--sloppy-imports", "--allow-read", "--allow-write", "--allow-env", "--config", `${root}/deno.json`, `${root}/bench/run.ts`, "--shas", "none", "--local", cases, "--out", out],
      env: { GITHUB_STEP_SUMMARY: summary }, stdout: "piped", stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const after = JSON.parse(await Deno.readTextFile(out));
    assertEquals(after.runs, runs);
    assertEquals(after.results.map((r: { input_hash: string; record: PlanRecord }) => [r.input_hash, r.record]), results.map(r => [r.input_hash, r.record]));
    assert((await Deno.readTextFile(summary)).includes("6/6"));
    assert((await Deno.readTextFile(summary)).includes("1 unready"));
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("a concurrent rule edit prevents a falsely current verification", async () => {
  const store = new MemoryStore();
  let reads = 0;
  store.rules = async () => ++reads < 2 ? {} : { pool_low: { threshold: 0.5 } };
  const error = await assertRejects(() => rescoreExisting(store), RescoreIncompleteError);
  assertEquals(error.report.verificationErrors, 12);
});

Deno.test("rescore-only refuses a missing local result file instead of reporting zero results", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bench-missing-store-" });
  const root = new URL("..", import.meta.url).pathname;
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-check", "--sloppy-imports", "--allow-read", "--allow-write", "--allow-env", "--config", `${root}/deno.json`, `${root}/bench/run.ts`, "--shas", "none", "--local", dir, "--out", `${dir}/missing.json`],
      stdout: "piped", stderr: "piped",
    }).output();
    assert(!result.success);
    assert(new TextDecoder().decode(result.stderr).includes("NotFound"));
  } finally { await Deno.remove(dir, { recursive: true }); }
});
