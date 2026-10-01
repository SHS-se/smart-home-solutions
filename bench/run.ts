// Planner bench runner: replay every test case through one or more planner
// versions and store what each planned (docs/planner-bench/README.md).
//
//   deno run -A --config deno.json bench/run.ts [options]
//
//   --shas a,b,c | all | none
//                           commits to run (default: HEAD). `all` = every commit already on the bench,
//                           `none` = no planner runs, only recompute stale scores.
//   --scenario <id>         only this test case (default: every case).
//   --force                 re-run cases that already have a result for the commit.
//   --current <sha>         mark this commit as the planner currently deployed.
//   --branch <name>         recorded against the run (CI passes the pushed branch).
//   --local <dir> --out <file.json>
//                           no database: cases are the replay files in <dir>,
//                           records go to <file.json>.
//
// Database mode needs BENCH_SUPABASE_URL and BENCH_SERVICE_ROLE_KEY.
//
// Commits whose planner code is the same (planner-version.ts) share one run:
// a commit whose planner version is already on the bench is not run again, and
// runs already stored with the same version fold into the earliest.
//
// Each commit is checked out into its own git worktree and run in a fresh Deno
// process, so versions never share module state and one version crashing
// cannot take the others with it.

import { loadPlanner } from "./planner-adapter.ts";
import { isStale, storedScore } from "../src/lib/planner-bench/score.ts";
import { type BenchStore, DbStore, LocalStore, type RunSummary } from "./store.ts";
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

/** Worker: run the planner at --root for commit --worker on every case it still lacks. */
async function worker(sha: string, root: string) {
  const bench = store();
  const planner = await loadPlanner(root);
  const cases = await bench.scenarios(args.scenario);
  const done = args.force ? new Set<string>() : await bench.resultIds(sha);
  const all = cases.map(c => c.input);
  for (const scenario of cases) {
    if (done.has(scenario.id)) continue;
    try {
      const { series, stats, cpuMs } = planner.run(scenario.input, all);
      await bench.saveResult({ sha, scenario_id: scenario.id, status: "ok", error: null, cpu_ms: Math.round(cpuMs), series, stats,
        score: storedScore(series, scenario.criteria) });
      console.log(`  ${scenario.name}: ${Math.round(cpuMs)} ms, pool ${stats.pool_kwh.toFixed(1)} kWh, cost ${stats.grid_cost_sek.toFixed(1)} kr`);
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 4000) : String(error);
      await bench.saveResult({ sha, scenario_id: scenario.id, status: "error", error: message, cpu_ms: null, series: null, stats: null, score: null });
      console.log(`  ${scenario.name}: ERROR ${message.split("\n")[0]}`);
    }
  }
}

/**
 * Recompute every stored score written by an older scorer or before the case's
 * criteria last changed. Reads the stored plan series; no planner runs.
 */
async function rescoreStale(bench: BenchStore) {
  const criteria = new Map((await bench.scenarios()).map(c => [c.id, c.criteria]));
  let rescored = 0;
  for (const result of await bench.scoredResults()) {
    const overrides = criteria.get(result.scenario_id);
    if (overrides === undefined || !isStale(result.score, overrides)) continue;
    const series = await bench.series(result.sha, result.scenario_id);
    if (!series) continue;
    await bench.saveScore(result.sha, result.scenario_id, storedScore(series, overrides));
    rescored++;
  }
  console.log(`Rescored ${rescored} stale result${rescored === 1 ? "" : "s"}.`);
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
  const byVersion = await foldSameVersions(bench);
  const requested = args.shas === "all" ? await bench.knownShas()
    : args.shas === "none" ? []
    : (args.shas ?? "HEAD").split(",").map(s => s.trim()).filter(Boolean);
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
    await rescoreStale(bench);
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
  if (failures) Deno.exit(1);
}

if (args.worker) await worker(args.worker, args.root!);
else await orchestrate();
