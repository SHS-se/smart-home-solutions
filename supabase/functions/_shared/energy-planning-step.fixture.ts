import { assert, assertEquals } from "jsr:@std/assert@1";
import { snapshot } from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import type { OptimisationSnapshot } from "./planner/energy-optimisation.ts";
import { solvedPlan } from "./planner/solved-plan.fixture.ts";
import type { DispatchCheckpoint, DispatchResult, ResponsiveRanking } from "./planner/dispatch-plan.ts";
import { assembleOptimisationPlan, energyPlanningStep, type PlanningBudget } from "./energy-planning-step.ts";
import type { EnergyPlanningInput, EnergyPlanningStep } from "./energy-planning-protocol.ts";

export const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const inputFor = (snapshot: OptimisationSnapshot): EnergyPlanningInput => ({
  snapshot,
  now: snapshot.captured_at,
  price_archive: [],
});

/** A worker call's budget that runs out after `checks` pause points. */
export const countedBudget = (checks: number): () => PlanningBudget => () => {
  let used = 0;
  return { spent: () => ++used > checks, allowsAuction: () => used <= checks };
};

/**
 * Runs the chain over JSON as ingest does, one budget per call, and checks the
 * assembled plan against the synchronous planner. Returns how many calls it
 * took and how often a stage paused part-way.
 */
export function assertStagesMatch(
  input: EnergyPlanningInput,
  budget?: () => PlanningBudget,
) {
  const original = wire(input);
  const expected = solvedPlan(
    input.snapshot,
    new Date(input.now),
    input.price_archive,
    input.resolved_price_outlook,
    input.fixed_plan,
  ).plan;
  const completed: DispatchResult[] = [];
  const rankings: ResponsiveRanking[] = [];
  let checkpoint: DispatchCheckpoint | undefined;
  const seen = new Set<string>();
  const counts = { calls: 0, transfers: 0, refinement: 0, rankings: 0, rankingOnly: 0 };
  for (let i = 0; i < 4096; i++) {
    counts.calls++;
    const step: EnergyPlanningStep = wire(
      energyPlanningStep(wire(input), wire({ completed, checkpoint, rankings }), budget?.()),
    );
    completed.push(...step.completed);
    rankings.push(...step.rankings);
    counts.rankings += step.rankings.length;
    if (step.rankings.length && !step.completed.length && !step.checkpoint) counts.rankingOnly++;
    checkpoint = step.checkpoint;
    if (step.done) {
      assertEquals(checkpoint, undefined);
      assertEquals(
        wire(assembleOptimisationPlan(wire(input), completed, rankings).plan),
        wire(expected),
      );
      assertEquals(input, original);
      if (!budget) assert(seen.has("transfers") && seen.has("refinement"));
      return counts;
    }
    if (checkpoint) seen.add(checkpoint.next);
    if (checkpoint?.transferred) counts.transfers++;
    if (checkpoint?.refinement) counts.refinement++;
  }
  throw new Error("Planning did not finish");
}

export const seasonInput = (season: "sunny" | "dark") => {
  const input = inputFor(snapshot());
  if (season === "dark") {
    input.snapshot.slots = input.snapshot.slots.map((slot, i) => ({
      ...slot,
      pv_forecast_w: 0,
      import_price_sek_per_kwh: 1.5 + Math.sin(i * .15) * .7,
      export_price_sek_per_kwh: .2,
    }));
  }
  return input;
};

export function registerSeasonTests(season: "sunny" | "dark") {
  Deno.test(`distributed 288-quarter ${season} plan preserves every command and diagnostic`, () => {
    const counts = assertStagesMatch(seasonInput(season));
    assertEquals([counts.transfers, counts.refinement], [0, 0]);
  });

  Deno.test(`distributed ${season} plan survives transfer and refinement stages paused part-way`, () => {
    // A worker whose CPU budget is spent checkpoints between two transfers or
    // two refinement trials; the resumed stages must reach exactly the plan an
    // uninterrupted solve does.
    const counts = assertStagesMatch(seasonInput(season), countedBudget(25));
    assert(counts.transfers > 0 && counts.refinement > 0, JSON.stringify(counts));
  });

  Deno.test(`distributed ${season} plan crosses every boundary in memory when the budget allows`, () => {
    const counts = assertStagesMatch(seasonInput(season), () => ({
      spent: () => false,
      allowsAuction: () => true,
    }));
    assertEquals(counts.calls, 1);
  });
}
