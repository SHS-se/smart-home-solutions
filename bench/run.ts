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
//   --rerecord              read the complete measured outcome and pre-case history again,
//                           replacing what is stored (after those tables were corrected).
//                           Cases made from an hourly history file keep theirs.
//   --current <sha>         mark this commit as the production planner.
//   --test <sha>            mark this commit as the test environment planner.
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
// Every commit keeps its own run, results and environment marks, even when
// its planner code matches another commit. The page hides older consecutive
// equal-score entries without changing stored commit identity.
//
// Each commit is checked out into its own git worktree and run in a fresh Deno
// process, so versions never share module state and one version crashing
// cannot take the others with it.

import { ADAPTER_VERSION, loadPlanner } from "./adapter.ts";
import { canonicalJson, caseTargets, hasMeasuredOutcome, loadCase, sha256, type BenchCase } from "../src/lib/planner-bench/case.ts";
import { caseFromReplay, REPLAY_FORMAT } from "../src/lib/planner-bench/convert-replay.ts";
import { evaluate } from "../src/lib/planner-bench/evaluate.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { homeComfortTargets } from "./comfort.ts";
import { LANES, laneParts, toldCase, type LaneId } from "../src/lib/planner-bench/lanes.ts";
import { rescoreExisting, rescoreMarkdown, RescoreIncompleteError, type RescoreReport } from "./rescore.ts";
import { completeCase, recordedDemandDays, recordedWind, type HistorySource } from "./history.ts";
import { type BenchStore, DbStore, laneKey, LocalStore, type StoredScenario } from "./store.ts";
import { commitTree, plannerDir, plannerVersion } from "./planner-version.ts";

const harness = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const VALUED = ["shas", "scenario", "current", "test", "branch", "local", "out", "worker", "root"] as const;
const args: Partial<Record<(typeof VALUED)[number], string>> & { force?: boolean; rerecord?: boolean } = {};
for (let i = 0; i < Deno.args.length; i++) {
  const name = Deno.args[i].replace(/^--/, "");
  if (name === "force") args.force = true;
  else if (name === "rerecord") args.rerecord = true;
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
  scenario.dataset && hasMeasuredOutcome(scenario.recorded) ? [{ scenario, c: loadCase(scenario.dataset, scenario.recorded) }] : []);

/** Identity of everything a planner generation is given for a case under one lane. */
function inputHash(c: BenchCase, generation: string, lane: LaneId): Promise<string> {
  const { origin: _origin, recorded: { recorded_at: _at, ...recorded }, ...dataset } = c;
  return sha256(canonicalJson({ dataset, recorded, household: HOUSEHOLD, adapter: ADAPTER_VERSION, generation, lane: laneParts(lane) }));
}

/** Worker: run the planner at --root for commit --worker on every case whose result is missing or stale. */
async function worker(sha: string, root: string) {
  const bench = store();
  const planner = await loadPlanner(root);
  const [done, rules] = await Promise.all([bench.resultHashes(sha), bench.rules()]);
  let failures = 0;
  for (const { scenario, c } of readyCases(await bench.scenarios(args.scenario))) {
    for (const lane of LANES) {
      const hash = await inputHash(c, planner.generation, lane);
      const base = { sha, scenario_id: scenario.id, lane, input_hash: hash, case_revision: scenario.revision };
      const previous = done.get(laneKey(scenario.id, lane));
      if (!args.force && previous?.input_hash === hash && previous.status === "ok" && previous.has_record) {
        if (previous.case_revision !== scenario.revision) await bench.bindResultRevision(base);
        continue;
      }
      try {
        const { record, cpuMs } = planner.plan(toldCase(c, lane), HOUSEHOLD, laneParts(lane).scale);
        // Whatever the planner was told, its plan is judged on the case as it really was.
        const evaluation = evaluate(c, record, rules, lane);
        await bench.saveResult({ ...base, status: "ok", error: null, cpu_ms: Math.round(cpuMs), record, ...evaluation });
        console.log(`  ${scenario.name} ${lane}: ${record.status}, ${Math.round(cpuMs)} ms, ${evaluation.outcome.cost_sek.toFixed(1)} kr at real prices`
          + ` (planner expected ${record.beliefs.grid_cost_sek?.toFixed(1) ?? "?"}), left in stores ${evaluation.outcome.terminal.credit_sek.toFixed(1)} kr,`
          + ` score ${evaluation.score.points} (quarter rules ${evaluation.score.sum}), pool ${evaluation.stats.pool_kwh.toFixed(1)} kWh, car ${evaluation.stats.ev_kwh.toFixed(1)} kWh`);
      } catch (error) {
        failures++;
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 4000) : String(error);
        await bench.saveResult({ ...base, status: "error", error: message, cpu_ms: null, record: null });
        console.log(`  ${scenario.name} ${lane}: ERROR ${message.split("\n")[0]}`);
      }
    }
  }
  if (failures) throw new Error(`${failures} planner/case/lanes failed; successful results were saved. Rerun to retry the errors.`);
}

/** Where the home's recorded history is read from, or null without a database. */
async function historySource(): Promise<HistorySource | null> {
  const url = Deno.env.get("BENCH_SUPABASE_URL"), key = Deno.env.get("BENCH_SERVICE_ROLE_KEY");
  if (args.local || !url || !key) return null;
  let homeId = Deno.env.get("BENCH_HOME_ID");
  if (!homeId) {
    const response = await fetch(`${url}/rest/v1/energy_optimisation_outdoor_slots?select=home_id&order=start_ts.desc&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`Could not identify the bench home: ${response.status} ${await response.text()}`);
    homeId = (await response.json())[0]?.home_id;
  }
  if (!homeId) throw new Error('No bench home found. Set BENCH_HOME_ID to the home whose history and comfort preferences the bench should use.');
  return { url, key, homeId };
}

/** Convert scenarios still held as replays, and complete cases whose window has since been recorded. */
async function prepareCases(bench: BenchStore) {
  const source = await historySource();
  const targets = source ? await homeComfortTargets(source) : null;
  if (targets) console.log(`Home ${source!.homeId}: pool target ${targets.pool_c} °C, car target ${targets.ev_km} km.`);
  for (const scenario of await bench.scenarios(args.scenario)) {
    let dataset = scenario.dataset;
    if (!dataset) {
      const input = await bench.legacyReplayInput(scenario.id);
      if (!input) { console.log(`${scenario.name}: has neither a test case nor a replay; skipped.`); continue; }
      dataset = caseFromReplay({ format: REPLAY_FORMAT, entrypoint: { arguments: input } }, scenario.name).data;
      await bench.saveDataset(scenario.id, dataset);
      console.log(`${scenario.name}: converted from its replay.`);
    }
    if (targets && canonicalJson(dataset.comfort) !== canonicalJson(targets)) {
      dataset = { ...dataset, comfort: targets };
      await bench.saveDataset(scenario.id, dataset);
      console.log(`${scenario.name}: current home comfort preferences captured.`);
    }
    caseTargets(dataset);
    if (scenario.recorded && (!hasMeasuredOutcome(scenario.recorded)
      || (args.rerecord && dataset.origin?.kind !== "history"))) {
      scenario.recorded = null;
      await bench.saveRecorded(scenario.id, null, "awaiting complete measured outcome");
      console.log(`${scenario.name}: recording cleared for measured completion.`);
    }
    if (scenario.recorded && source && !scenario.recorded.wind) {
      // Wind was not kept when this case was recorded; it is added once it has been observed.
      const wind = await recordedWind(source, HOUSEHOLD.site.market_area, dataset.start);
      if (wind) {
        scenario.recorded = { ...scenario.recorded, wind };
        await bench.saveRecorded(scenario.id, scenario.recorded, null);
        console.log(`${scenario.name}: observed wind added.`);
      }
    }
    if (scenario.recorded && source && !scenario.recorded.history.demand_days) {
      const demand = await recordedDemandDays(source, dataset.timezone, dataset.start);
      if (demand) {
        scenario.recorded = { ...scenario.recorded, history: { ...scenario.recorded.history, demand_days: demand } };
        await bench.saveRecorded(scenario.id, scenario.recorded, null);
      }
    }
    if (scenario.recorded || !source) continue;
    const done = await completeCase(source, dataset);
    if (dataset.start_state_unread?.length && Object.keys(done.startState).length) {
      // Readings the replay lacked come from recorded history, once.
      const { ev_soc, ...read } = done.startState;
      const remaining = dataset.start_state_unread.filter(field => !(field in done.startState));
      const { start_state_unread: _unread, ...rest } = dataset;
      dataset = { ...rest, ...(remaining.length ? { start_state_unread: remaining } : {}), start_state: { ...dataset.start_state, ...read, ev: { ...dataset.start_state.ev, ...(ev_soc !== undefined ? { soc: ev_soc } : {}) } } };
      await bench.saveDataset(scenario.id, dataset);
    }
    if (dataset.start_state_unread?.length) {
      done.recorded = null;
      done.missing = `${done.missing ? done.missing + "; " : ""}missing measured start state: ${dataset.start_state_unread.join(", ")}`;
    }
    if (done.recorded) {
      const wind = await recordedWind(source, HOUSEHOLD.site.market_area, dataset.start);
      if (wind) done.recorded.wind = wind;
      const demand = await recordedDemandDays(source, dataset.timezone, dataset.start);
      if (demand) done.recorded.history.demand_days = demand;
    }
    await bench.saveRecorded(scenario.id, done.recorded, done.missing);
    console.log(`${scenario.name}: ${done.recorded ? "complete, recorded data stored" : `waiting, ${done.missing}`}.`);
  }
}

/** Print and persist coverage even when some successful records could not be rescored. */
async function rescoreAndReport(bench: BenchStore, requireComplete = false) {
  const publish = async (report: RescoreReport) => {
    const markdown = rescoreMarkdown(report);
    console.log(markdown);
    const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
    if (summary) await Deno.writeTextFile(summary, markdown, { append: true });
  };
  try {
    const report = await rescoreExisting(bench, args.scenario);
    await publish(report);
    if (requireComplete && report.planners.some(p => p.currentLanes !== p.expectedLanes)) {
      throw new Error("Bench coverage is incomplete: see the reported missing, stale-input or failed lanes. Rerun the named planners.");
    }
  } catch (error) {
    if (error instanceof RescoreIncompleteError) await publish(error.report);
    throw error;
  }
}

async function orchestrate() {
  const bench = store();
  if (args.shas === "none") {
    if (args.current || args.test) throw new Error("--shas none only rescores; omit --current and --test to leave planner run identity unchanged.");
    if (args.rerecord) throw new Error("--shas none only rescores; --rerecord needs case preparation, so run it with --shas all.");
    // A rescore needs an existing source file; creating an empty local bench
    // is valid for planning, but would hide a mistyped path here.
    if (args.local) await Deno.stat(args.out!);
    await rescoreAndReport(bench);
    return;
  }
  await prepareCases(bench);
  const listed = [...(args.shas ?? "HEAD").split(","), args.current, args.test]
    .filter((ref): ref is string => Boolean(ref?.trim())).map(ref => ref.trim());
  const stored = new Set(listed.includes("all") ? await bench.knownShas() : []);
  // A commit asked for by name must exist; one that is only stored may not.
  for (const ref of listed) stored.delete(ref);
  const requested = [...new Set(listed.flatMap(ref => ref === "all" ? [...stored] : [ref]))];
  const scratch = await Deno.makeTempDir({ prefix: "planner-bench-" });
  let failures = 0;
  try {
    for (const ref of requested) {
      // A stored run may be of a commit that was never pushed; its results stay, but it cannot be run here.
      const shown = await git("show", "-s", "--format=%H%x09%h%x09%cI%x09%s", ref).catch(error => {
        if (!stored.has(ref)) throw error;
        console.log(`${ref.slice(0, 7)}: not in this checkout's history; left as it is.`);
        return null;
      });
      if (shown === null) continue;
      const [sha, shortSha, committedAt, subject] = shown.split("\t");
      console.log(`${shortSha} ${subject}`);
      const tree = commitTree(sha, harness);
      const metadata = { sha, short_sha: shortSha, committed_at: committedAt, subject, branch: args.branch ?? null };
      if (plannerDir(tree) === null) {
        const error = "This commit does not contain a planner entry point.";
        await bench.saveRun({ ...metadata, planner_version: null, status: "unavailable", error, finished_at: new Date().toISOString() });
        console.log(`  UNAVAILABLE: ${error} No benchmark results can be generated for this commit.`);
        continue;
      }
      const run = { ...metadata, planner_version: await plannerVersion(tree) };
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
    for (const [ref, environment] of [[args.current, "production"], [args.test, "test"]] as const) {
      if (!ref) continue;
      const sha = await git("rev-parse", ref);
      await bench.markDeployed(sha, environment);
    }
    await rescoreAndReport(bench, true);
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
  if (failures) Deno.exit(1);
}

if (args.worker) await worker(args.worker, args.root!);
else await orchestrate();
