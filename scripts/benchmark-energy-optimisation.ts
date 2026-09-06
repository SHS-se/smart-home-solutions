// Run with: deno bench --no-check scripts/benchmark-energy-optimisation.ts
// Keep the complete plan in this benchmark: ingest generates all three scenarios.
import {
  CAPTURED_AT,
  snapshot,
} from "../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import { generateOptimisationPlan } from "../supabase/functions/_shared/energy-optimisation.ts";

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
      throw new Error(`Benchmark plan failed: ${result.validation_errors.join(", ")}`);
    }
  });
}
