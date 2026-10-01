// Run one planner version, checked out at `root`, on one test case.
//
// The harness is always the current checkout; the planner it runs is whatever
// commit sits at `root`. So the only thing the harness may assume about a
// planner is its public entry points, which have been stable since the replay
// format existed:
//
//   energy-optimisation.ts  generateOptimisationPlan(snapshot, now, archive, outlook, fixed, solveAuction)
//                           dispatchWorkbench(...)            (optional: pool temperatures)
//   dispatch-plan.ts        dispatchAuctionSteps(...)         (optional: reuse the plan's own auctions)
//                           scoreDispatch(...)                (optional: pool temperatures)
//
// A planner version that needs its input prepared differently (a planning
// basis built from price history, say) owns that step: it exports
// `prepare(input, allInputs)` from `bench/prepare.ts` in its own commit.

import { planSeries } from "../src/lib/planner-bench/series.ts";
import { planStats } from "../src/lib/planner-bench/stats.ts";
import type { BenchInput, BenchSeries, BenchStats } from "../src/lib/planner-bench/types.ts";
import { diskTree } from "../scripts/module-graph.ts";
import { plannerDir } from "./planner-version.ts";

type Module = Record<string, unknown>;

export interface Planner {
  run(input: BenchInput, all: readonly BenchInput[]): { series: BenchSeries; stats: BenchStats; cpuMs: number };
}

async function optionalImport(path: string): Promise<Module | null> {
  try { await Deno.stat(path); } catch { return null; }
  return await import(`file://${path}`);
}

/**
 * The one amendment the bench makes to every case, for every version alike:
 * captures taken before the pool loss was fitted carry no pool model, and
 * without one the pool cannot be planned at all. 0.1 kW/K is the loss the
 * acceptance replays have always used for those captures.
 */
function amend(snapshot: Record<string, unknown>) {
  if (snapshot.pool && !snapshot.pool_model) {
    snapshot.pool_model = { loss_kw_per_k: 0.1, rated_cop: null, cop_per_air_c: null };
  }
  return snapshot;
}

export async function loadPlanner(root: string): Promise<Planner> {
  const planner = `${root}/${plannerDir(diskTree(root))}`;
  const M = await import(`file://${planner}/energy-optimisation.ts`);
  const D = await import(`file://${planner}/dispatch-plan.ts`);
  const prepare = (await optionalImport(`${root}/bench/prepare.ts`))?.prepare as
    ((input: BenchInput, all: readonly BenchInput[]) => BenchInput) | undefined;

  return {
    run(original, all) {
      const input = prepare ? prepare(structuredClone(original), all) : structuredClone(original);
      const snapshot = amend(input.snapshot as Record<string, unknown>);
      const now = new Date(input.now);
      const solved = new Map<string, unknown>();
      const solve = typeof D.dispatchAuctionSteps === "function"
        ? (...args: unknown[]) => {
          const steps = D.dispatchAuctionSteps(...args);
          for (;;) {
            const step = steps.next();
            if (step.done) {
              solved.set(JSON.stringify(args), structuredClone(step.value));
              return step.value;
            }
          }
        }
        : undefined;

      const started = performance.now();
      const plan = M.generateOptimisationPlan(snapshot, now, input.price_archive, input.resolved_price_outlook, undefined, solve);
      const cpuMs = performance.now() - started;

      let poolState: number[] | null = null;
      if (typeof M.dispatchWorkbench === "function" && typeof D.scoreDispatch === "function") {
        const replay = solve && ((...args: unknown[]) => {
          const hit = solved.get(JSON.stringify(args));
          return hit ? structuredClone(hit) : solve(...args);
        });
        const workbench = M.dispatchWorkbench(snapshot, input.price_archive, plan.price_outlook, now, "full", replay);
        if (workbench) {
          const score = D.scoreDispatch(workbench.slots, workbench.stores, workbench.limits, workbench.planned);
          poolState = score?.state?.pool ?? null;
        }
      }
      const series = planSeries(plan.plans.priority.slots, poolState);
      return { series, stats: planStats(series), cpuMs };
    },
  };
}
