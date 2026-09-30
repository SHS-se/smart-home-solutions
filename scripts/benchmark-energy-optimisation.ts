// Run with: deno bench --no-check scripts/benchmark-energy-optimisation.ts
// Keep the complete plan in this benchmark: ingest generates all three scenarios.
import {
  CAPTURED_AT,
  snapshot,
} from "../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import { generateOptimisationPlan } from "../supabase/functions/_shared/planner/energy-optimisation.ts";
import {
  assembleOptimisationPlan,
  energyPlanningStep,
} from "../supabase/functions/_shared/energy-planning-step.ts";
import type { EnergyPlanningContinuation } from "../supabase/functions/_shared/energy-planning-protocol.ts";

for (const season of ["sunny", "dark"] as const) {
  const input = snapshot();
  if (season === "dark") {
    input.slots = input.slots.map((slot, index) => ({
      ...slot,
      pv_forecast_w: 0,
      import_price_sek_per_kwh: 1.5 + Math.sin(index * 0.15) * 0.7,
      export_price_sek_per_kwh: 0.2,
    }));
    input.outdoor_temperature_c = input.slots.map(() => -5);
  }
  Deno.bench(`72-hour ${season} ingest plan`, () => {
    const result = generateOptimisationPlan(input, new Date(CAPTURED_AT));
    if (result.status !== "ready") {
      throw new Error(
        `Benchmark plan failed: ${result.validation_errors.join(", ")}`,
      );
    }
  });
  // One stage per call, as a worker without a budget runs them.
  const planningInput = { snapshot: input, now: CAPTURED_AT, price_archive: [] };
  const continuation: EnergyPlanningContinuation = { completed: [] };
  for (let stage = 0; stage < 32; stage++) {
    const payload = JSON.stringify({ input: planningInput, continuation });
    const run = () => {
      const request = JSON.parse(payload);
      return energyPlanningStep(request.input, request.continuation);
    };
    const result = run();
    const name = continuation.checkpoint?.next ?? "auction";
    Deno.bench(`72-hour ${season} stage ${stage}: ${name}`, () => {
      JSON.stringify(run());
    });
    continuation.completed.push(...result.completed);
    continuation.checkpoint = result.checkpoint;
    if (result.done) break;
  }
  // Ingest's share: the plan from the finished auctions, replayed not searched.
  Deno.bench(`72-hour ${season} ingest assembly`, () => {
    assembleOptimisationPlan(planningInput, continuation.completed);
  });
}
