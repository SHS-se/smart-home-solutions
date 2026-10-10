import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { BENCH_BASELINE_COMMITTED_AT, historyCandidates, historyDrops, historyMarkdown, keepBestHistory, retainedCommit, type HistoryRun } from "../bench/retention.ts";

Deno.test("benchmark retention includes main baseline and newer commits, excluding older explicit selections", () => {
  assertEquals(retainedCommit(BENCH_BASELINE_COMMITTED_AT), true);
  assertEquals(retainedCommit("2026-10-08T10:12:04+02:00"), true);
  assertEquals(retainedCommit("2026-10-07T18:12:58+02:00"), false);
  assertThrows(() => retainedCommit("bad timestamp"), Error, "Invalid benchmark commit timestamp");
});

/** Commits a day apart, oldest first: `run("a", 1)` is older than `run("b", 2)`. */
const run = (sha: string, day: number, over: Partial<HistoryRun> = {}): HistoryRun => ({
  sha, committed_at: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`, planner_version: `code-${sha}`,
  is_current: false, is_test: false, status: "done", ...over,
});

Deno.test("history is the commits at neither head, less those whose planner a head or a newer commit already has", () => {
  const { candidates, duplicates } = historyCandidates([
    run("main", 1, { is_current: true }),
    run("old", 2),
    run("first-copy", 3, { planner_version: "code-shared" }),
    run("second-copy", 4, { planner_version: "code-shared" }),
    run("as-main", 5, { planner_version: "code-main" }),
    run("no-planner", 6, { planner_version: null, status: "unavailable" }),
    run("as-dev", 7, { planner_version: "code-dev" }),
    run("dev", 8, { is_test: true }),
  ]);
  // The newer of two equal planners stands for both; a commit with no planner is nobody's copy.
  assertEquals(candidates.map(r => r.sha), ["no-planner", "second-copy", "old"]);
  assertEquals(duplicates.sort(), ["as-dev", "as-main", "first-copy"]);
});

Deno.test("the worst scores are dropped until ten remain; a run without a score goes first, and the older of two equal ones", () => {
  const runs = Array.from({ length: 12 }, (_, i) => run(`p${i}`, i + 1));
  const scores = new Map(runs.map((r, i) => [r.sha, -100 - i]));
  assertEquals(historyDrops(runs.slice(0, 10), sha => scores.get(sha)!), []);
  // p11 and p10 score lowest.
  assertEquals(historyDrops(runs, sha => scores.get(sha)!), ["p11", "p10"]);
  scores.set("p3", -500).set("p0", -500);
  assertEquals(historyDrops(runs, sha => scores.get(sha)!), ["p0", "p3"]);
  assertEquals(historyDrops(runs, sha => sha === "p7" ? null : scores.get(sha)!), ["p7", "p0"]);
  assertEquals(historyDrops(runs, sha => scores.get(sha)!, 11), ["p0"]);
});

class History {
  deleted: string[] = [];
  solved: string[][] = [];
  scored = 0;
  constructor(public all: HistoryRun[], public score: Map<string, number | null>, private afterSolve: Map<string, number | null> = score) {}
  runs = () => Promise.resolve(this.all);
  deleteRun = (sha: string) => {
    const kept = this.all.filter(r => r.sha !== sha || r.is_current || r.is_test);
    const removed = kept.length < this.all.length;
    if (removed) this.deleted.push(sha);
    this.all = kept;
    return Promise.resolve(removed);
  };
  scores = (shas: readonly string[]) => { this.scored++; return Promise.resolve(new Map(shas.map(sha => [sha, this.score.get(sha) ?? null]))); };
  solve = (shas: readonly string[]) => { this.solved.push([...shas]); this.score = this.afterSolve; return Promise.resolve(); };
  keep = () => keepBestHistory(this, this.scores, this.solve);
}
const eleven = () => [run("main", 1, { is_current: true }), ...Array.from({ length: 11 }, (_, i) => run(`p${i}`, i + 2)), run("dev", 20, { is_test: true })];

Deno.test("when dev moves on and the scores hold, the worst of the eleven is dropped without running a planner", async () => {
  const history = new History(eleven(), new Map(Array.from({ length: 11 }, (_, i) => [`p${i}`, i === 4 ? -900 : -300 - i])));
  const outcome = await history.keep();
  assertEquals(history.deleted, ["p4"]);
  assertEquals(history.solved, []);
  assertEquals(outcome.dropped, [{ sha: "p4", score: -900 }]);
  assertEquals(outcome.kept.length, 10);
  assertEquals(history.all.filter(r => r.is_current || r.is_test).map(r => r.sha), ["main", "dev"]);
  // Ten or fewer: nothing is scored, run or dropped.
  const settled = new History(history.all, new Map());
  assertEquals((await settled.keep()).dropped, []);
  assertEquals([settled.scored, settled.solved.length, settled.deleted.length], [0, 0, 0]);
});

Deno.test("one score that no longer holds has all eleven run again, and the new scores decide", async () => {
  const stale = new Map<string, number | null>(Array.from({ length: 11 }, (_, i) => [`p${i}`, -300 - i]));
  stale.set("p2", null);
  // On today's cases the order is another: p9 is now the worst.
  const fresh = new Map(Array.from({ length: 11 }, (_, i) => [`p${i}`, i === 9 ? -950 : -400 + i]));
  const history = new History(eleven(), stale, fresh);
  const outcome = await history.keep();
  assertEquals(history.solved, [outcome.rerun]);
  assertEquals(outcome.rerun.length, 11);
  assertEquals(history.deleted, ["p9"]);
  assert(historyMarkdown(outcome).includes("all 11 earlier planners were run again"));
});

Deno.test("a planner that still cannot be scored after the rerun is the one dropped; when none can, nothing is", async () => {
  const fresh = new Map<string, number | null>(Array.from({ length: 11 }, (_, i) => [`p${i}`, i === 6 ? null : -400 + i]));
  const history = new History(eleven(), new Map(), fresh);
  assertEquals((await history.keep()).dropped, [{ sha: "p6", score: null }]);
  const broken = new History(eleven(), new Map(), new Map());
  await assertRejects(() => broken.keep(), Error, "None of the 11 earlier planners could be scored");
  assertEquals(broken.deleted, []);
});

Deno.test("copies of a head's planner leave history at once, whatever its size", async () => {
  const history = new History([run("main", 1, { is_current: true }), run("older", 2), run("ui-only", 3, { planner_version: "code-dev" }), run("dev", 4, { is_test: true })], new Map());
  const outcome = await history.keep();
  assertEquals(outcome.duplicates, ["ui-only"]);
  assertEquals(history.all.map(r => r.sha), ["main", "older", "dev"]);
  assertEquals(history.scored, 0);
});

Deno.test("with no case to score on, history is left as it is", async () => {
  const history = new History(eleven(), new Map());
  const outcome = await keepBestHistory(history, () => Promise.resolve(null), history.solve);
  assertEquals([outcome.dropped, history.deleted, history.solved], [[], [], []]);
  assertEquals(outcome.kept.length, 11);
});
