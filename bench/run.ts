// Planner bench runner: plan every test case with one or more planner versions
// and store what each decided (docs/planner-bench/README.md, test-cases.md).
//
//   deno run -A --config deno.json bench/run.ts [options]
//
//   --shas a,b,c | all | none
//                           commits to run (default: HEAD). `all` = every commit already on the bench,
//                           and may be one of the list; `none` = only rescore existing ready cases,
//                           without case preparation or historical planner checkouts.
//   --scenario <id>         only this test case (default: every case).
//   --force                 re-run cases whose result is already up to date.
//   --current <sha>         mark this commit as the planner currently deployed.
//   --branch <name>         recorded against the run (CI passes the pushed branch).
//   --local <dir> --out <file.json>
//                           no database: cases are `{ dataset, recorded }` files in <dir>,
//                           records go to <file.json>.
//
// Database mode needs BENCH_SUPABASE_URL and BENCH_SERVICE_ROLE_KEY; BENCH_HOME_ID
// names the home whose recorded history completes the cases (default: the one
// home recording to the project).
//
// Before any planner runs, scenarios still held as replays are converted to
// test cases, and cases whose 72 hours have since been recorded get their real
// prices, weather and history (history.ts). A case is run only once complete.
//
// A result is up to date when it was planned from exactly the present input:
// the case, the household, the comfort profile and the adapter (its
// `input_hash`). Editing a case re-runs that case; changing the household
// re-runs everything; adding a case re-runs nothing. What the planner decided
// is stored, and the referee's account of it (cost at real prices, pool and
// battery trajectories, score) is recomputed from that whenever the referee or
// the scorer changes, with no planner run.
//
// Commits whose planner code is the same (planner-version.ts) share one run:
// a commit whose planner version is already on the bench is not run again, and
// runs already stored with the same version fold into the earliest.
//
// Each commit is checked out into its own git worktree and run in a fresh Deno
// process, so versions never share module state and one version crashing
// cannot take the others with it.

import { ADAPTER_VERSION, loadPlanner } from "./adapter.ts";
import { canonicalJson, loadCase, sha256, type BenchCase } from "../src/lib/planner-bench/case.ts";
import { caseFromReplay, REPLAY_FORMAT } from "../src/lib/planner-bench/convert-replay.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { HOUSEHOLD, TARGETS } from "../src/lib/planner-bench/household.ts";
import { LANES, laneParts, toldCase, type LaneId } from "../src/lib/planner-bench/lanes.ts";
import { rescoreExisting, rescoreMarkdown, RescoreIncompleteError, type RescoreReport } from "./rescore.ts";
import { completeCase, recordedWind, type HistorySource } from "./history.ts";
import { type BenchStore, DbStore, laneKey, LocalStore, type RunSummary, type StoredScenario } from "./store.ts";
import { commitTree, currentVersionMethod, plannerVersion } from "./planner-version.ts";

const harness = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const VALUED = ["shas", "scenario", "current", "branch", "local", "out", "worker", "root"] as const;
const args: Partial<Record<(typeof VALUED)[number], string>> & { force?: boolean } = {};
for (let i = 0; i < Deno.args.length; i++) {
  const name = Deno.args[i].replace(/^--/, "");
  if (name === "force") args.force = true;
  else if ((VALUED as readonly string[]).includes(name) && Deno.args[i + 1] !== undefined) {
    args[name as (typeof VALUED)[number]] = Deno.args[++i];
  } else throw new Error(`Unknown or incomplete option: ${Deno.args[i]}`);
}

function store(): BenchStore {
  if (args.local) {
    if (!args.out) throw new Error("--local needs --out <file.json>");
    return new LocalStore(args.local, args.out);
  }
  const url = Deno.env.get("BENCH_SUPABASE_URL"), key = Deno.env.get("BENCH_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Set BENCH_SUPABASE_URL and BENCH_SERVICE_ROLE_KEY, or use --local <dir> --out <file>.");
  return new DbStore(url, key);
}

async function git(...argv: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args: argv, cwd: harness, stderr: "piped" }).output();
  if (!out.success) throw new Error(`git ${argv.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout).trim();
}

/** The scenarios that are complete test cases. */
const readyCases = (scenarios: StoredScenario[]) => scenarios.flatMap(scenario =>
  scenario.dataset && scenario.recorded ? [{ scenario, c: loadCase(scenario.dataset, scenario.recorded) }] : []);

/** Identity of everything a planner generation is given for a case under one lane. */
function inputHash(c: BenchCase, generation: string, lane: LaneId): Promise<string> {
  const { origin: _origin, recorded: { recorded_at: _at, ...recorded }, ...dataset } = c;
  return sha256(canonicalJson({ dataset, recorded, household: HOUSEHOLD, targets: TARGETS, adapter: ADAPTER_VERSION, generation, lane: laneParts(lane) }));
}

/** Worker: run the planner at --root for commit --worker on every case whose result is missing or stale. */
async function worker(sha: string, root: string) {
  const bench = store();
  const planner = await loadPlanner(root);
  const done = await bench.resultHashes(sha);
  for (const { scenario, c } of readyCases(await bench.scenarios(args.scenario))) {
    for (const lane of LANES) {
      const hash = await inputHash(c, planner.generation, lane);
      if (!args.force && done.get(laneKey(scenario.id, lane)) === hash) continue;
      const base = { sha, scenario_id: scenario.id, lane, input_hash: hash };
      try {
        const { record, cpuMs } = planner.plan(toldCase(c, lane), HOUSEHOLD, laneParts(lane).scale);
        // Whatever the planner was told, its plan is judged on the case as it really was.
        const evaluation = evaluate(c, record, scenario.criteria, lane);
        await bench.saveResult({ ...base, status: "ok", error: null, cpu_ms: Math.round(cpuMs), record, ...evaluation });
        console.log(`  ${scenario.name} ${lane}: ${record.status}, ${Math.round(cpuMs)} ms, ${evaluation.outcome.cost_sek.toFixed(1)} kr at real prices`
          + ` (planner expected ${record.beliefs.grid_cost_sek?.toFixed(1) ?? "?"}), left in stores ${evaluation.outcome.terminal.credit_sek.toFixed(1)} kr,`
          + ` score ${evaluation.score.points} (quarter rules ${evaluation.score.sum}), pool ${evaluation.stats.pool_kwh.toFixed(1)} kWh, car ${evaluation.stats.ev_kwh.toFixed(1)} kWh`);
      } catch (error) {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 4000) : String(error);
        await bench.saveResult({ ...base, status: "error", error: message, cpu_ms: null, record: null });
        console.log(`  ${scenario.name} ${lane}: ERROR ${message.split("\n")[0]}`);
      }
    }
  }
}

/** Where the home's recorded history is read from, or null without a database. */
async function historySource(): Promise<HistorySource | null> {
  const url = Deno.env.get("BENCH_SUPABASE_URL"), key = Deno.env.get("BENCH_SERVICE_ROLE_KEY");
  if (args.local || !url || !key) return null;
  let homeId = Deno.env.get("BENCH_HOME_ID");
  if (!homeId) {
    const response = await fetch(`${url}/rest/v1/energy_optimisation_outdoor_slots?select=home_id&order=start_ts.desc&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    homeId = response.ok ? (await response.json())[0]?.home_id : undefined;
  }
  return homeId ? { url, key, homeId } : null;
}

/** Convert scenarios still held as replays, and complete cases whose window has since been recorded. */
async function prepareCases(bench: BenchStore) {
  const source = await historySource();
  for (const scenario of await bench.scenarios(args.scenario)) {
    let dataset = scenario.dataset;
    if (!dataset) {
      const input = await bench.legacyReplayInput(scenario.id);
      if (!input) { console.log(`${scenario.name}: has neither a test case nor a replay; skipped.`); continue; }
      dataset = caseFromReplay({ format: REPLAY_FORMAT, entrypoint: { arguments: input } }, scenario.name).data;
      await bench.saveDataset(scenario.id, dataset);
      console.log(`${scenario.name}: converted from its replay.`);
    }
    if (scenario.recorded && source && !scenario.recorded.wind) {
      // Wind was not kept when this case was recorded; it is added once it has been observed.
      const wind = await recordedWind(source, HOUSEHOLD.site.market_area, dataset.start);
      if (wind) {
        await bench.saveRecorded(scenario.id, { ...scenario.recorded, wind }, null);
        console.log(`${scenario.name}: observed wind added.`);
      }
    }
    if (scenario.recorded || !source) continue;
    const done = await completeCase(source, dataset);
    if (dataset.start_state_unread?.length) {
      // Readings the replay lacked come from recorded history, once.
      const { ev_soc, ...read } = done.startState;
      const { start_state_unread: _unread, ...rest } = dataset;
      dataset = { ...rest, start_state: { ...dataset.start_state, ...read, ev: { ...dataset.start_state.ev, ...(ev_soc !== undefined ? { soc: ev_soc } : {}) } } };
      await bench.saveDataset(scenario.id, dataset);
    }
    if (done.recorded) {
      const wind = await recordedWind(source, HOUSEHOLD.site.market_area, dataset.start);
      if (wind) done.recorded.wind = wind;
    }
    await bench.saveRecorded(scenario.id, done.recorded, done.missing);
    console.log(`${scenario.name}: ${done.recorded ? "complete, recorded data stored" : `waiting, ${done.missing}`}.`);
  }
}

/** Print and persist coverage even when some successful records could not be rescored. */
async function rescoreAndReport(bench: BenchStore) {
  const publish = async (report: RescoreReport) => {
    const markdown = rescoreMarkdown(report);
    console.log(markdown);
    const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
    if (summary) await Deno.writeTextFile(summary, markdown, { append: true });
  };
  try {
    await publish(await rescoreExisting(bench, args.scenario));
  } catch (error) {
    if (error instanceof RescoreIncompleteError) await publish(error.report);
    throw error;
  }
}

const versionOf = (sha: string) => plannerVersion(commitTree(sha, harness));

/**
 * Give every stored run its planner version and fold runs that share one into
 * the earliest. Returns the remaining run of each version.
 */
async function foldSameVersions(bench: BenchStore): Promise<Map<string, RunSummary>> {
  const method = `${await currentVersionMethod()}:`;
  const runs = await bench.runs();
  for (const run of runs) {
    if (run.planner_version?.startsWith(method)) continue;
    try {
      run.planner_version = await versionOf(run.sha);
      await bench.setPlannerVersion(run.sha, run.planner_version);
    } catch {
      console.log(`${run.sha.slice(0, 7)}: not in this checkout's history; left as it is.`);
    }
  }
  const kept = new Map<string, RunSummary>();
  for (const run of runs) {
    if (!run.planner_version?.startsWith(method)) continue;
    const first = kept.get(run.planner_version);
    if (!first) { kept.set(run.planner_version, run); continue; }
    console.log(`${run.sha.slice(0, 7)}: same planner as ${first.sha.slice(0, 7)}, folded into it.`);
    await bench.mergeRun(run.sha, first.sha);
    first.is_current ||= run.is_current;
  }
  return kept;
}

async function orchestrate() {
  const bench = store();
  if (args.shas === "none") {
    if (args.current) throw new Error("--shas none only rescores; omit --current to leave planner run identity unchanged.");
    // A rescore needs an existing source file; creating an empty local bench
    // is valid for planning, but would hide a mistyped path here.
    if (args.local) await Deno.stat(args.out!);
    await rescoreAndReport(bench);
    return;
  }
  await prepareCases(bench);
  const byVersion = await foldSameVersions(bench);
  const listed = (args.shas ?? "HEAD").split(",").map(s => s.trim()).filter(Boolean);
  const requested = [...new Set((await Promise.all(listed.map(async ref => ref === "all" ? await bench.knownShas() : [ref]))).flat())];
  const scratch = await Deno.makeTempDir({ prefix: "planner-bench-" });
  let failures = 0;
  try {
    for (const ref of requested) {
      const [sha, shortSha, committedAt, subject] = (await git("show", "-s", "--format=%H%x09%h%x09%cI%x09%s", ref)).split("\t");
      const version = await versionOf(sha);
      const same = byVersion.get(version);
      if (same && same.sha !== sha) {
        console.log(`${shortSha} ${subject}\n  same planner as ${same.sha.slice(0, 7)}: nothing to run.`);
        continue;
      }
      console.log(`${shortSha} ${subject}`);
      const run = { sha, short_sha: shortSha, committed_at: committedAt, subject, branch: args.branch ?? null, planner_version: version };
      byVersion.set(version, { sha, committed_at: committedAt, planner_version: version, is_current: false });
      await bench.saveRun({ ...run, status: "running", error: null, finished_at: null });

      const root = `${scratch}/${shortSha}`;
      await git("worktree", "add", "--detach", "--force", root, sha);
      try {
        // Planner dependencies resolve through node_modules; the harness's copy
        // stands in for each commit's own (they change rarely).
        await Deno.symlink(`${harness}/node_modules`, `${root}/node_modules`).catch(() => {});
        const child = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", "--no-check", "--sloppy-imports", "--config", `${harness}/deno.json`, import.meta.filename!,
            "--worker", sha, "--root", root,
            ...(args.scenario ? ["--scenario", args.scenario] : []),
            ...(args.force ? ["--force"] : []),
            ...(args.local ? ["--local", args.local, "--out", args.out!] : [])],
          stdout: "inherit", stderr: "inherit",
        }).output();
        const status = child.success ? "done" : "failed";
        if (!child.success) failures++;
        await bench.saveRun({ ...run, status, error: child.success ? null : `worker exited with ${child.code}`, finished_at: new Date().toISOString() });
      } finally {
        await git("worktree", "remove", "--force", root).catch(() => {});
      }
    }
    if (args.current) {
      // The deployed commit may share its planner with an earlier run.
      const sha = await git("rev-parse", args.current);
      await bench.markCurrent(byVersion.get(await versionOf(sha))?.sha ?? sha);
    }
    await rescoreAndReport(bench);
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
  if (failures) Deno.exit(1);
}

if (args.worker) await worker(args.worker, args.root!);
else await orchestrate();
