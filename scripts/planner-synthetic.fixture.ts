import { builderRecipe } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
// Entirely invented diagnostic household. No HA readings, case export or customer IDs.
import type { ReadyProblem } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { RULE_KEYS } from "../supabase/functions/_shared/planner-wasm/ready-problem.ts";
import { resolveRules } from "../src/lib/planner-bench/score.ts";
import recipe from "../planner-core/recipe.json" with { type: "json" };

export function syntheticReadyProblem(): ReadyProblem {
  const prices = Array.from(
    { length: 288 },
    (_, i) => 1 + .8 * Math.cos(i % 96 / 96 * 2 * Math.PI),
  );
  return {
    abi: 3,
    work_grant: recipe.work_grant,
    recipe: builderRecipe(recipe),
    slots: prices.map((price, i) => ({
      start_seconds: i * 900,
      hours: .25,
      base_w: 700,
      solar_w: Math.max(0, 3000 * Math.sin((i % 96 - 24) / 48 * Math.PI)),
      outdoor_c: 16,
      import_price: price,
      export_price: price - .5,
      published: i < 96,
    })),
    battery: {
      capacity_kwh: 10,
      min_soc: .1,
      max_soc: .95,
      charge_max_w: 3000,
      discharge_max_w: 3000,
      charge_efficiency: .9,
      discharge_efficiency: .9,
    },
    car: { capacity_kwh: 50, kwh_per_km: .18, charge_efficiency: .9 },
    charger: {
      voltage_v: 230,
      phase_count: 3,
      min_current_a: 6,
      max_current_a: 16,
      current_step_a: 1,
    },
    pool_store: {
      capacity_kwh_per_c: 30,
      loss: { kind: "linear", kw_per_c: .1, surroundings_c: 10 },
    },
    heater: {
      compressor_w: 2000,
      auxiliary_w: 200,
      heat_w: 8000,
      response: { kind: "steady" },
    },
    initial: {
      battery_kwh: 5,
      ev_kwh: 10,
      pool_c: 28,
      heater_state: { kind: "off_unobserved" },
    },
    targets: { pool_c: 30, ev_km: 200, ev_limit_kwh: 45 },
    limits: {
      import_w: 12000,
      export_w: 5000,
      battery_export_enabled: false,
      battery_export_reserve_kwh: 2,
      battery_export_min_price: 4,
      wear_per_kwh: .05,
    },
    rules: resolveRules({}).flatMap((r) =>
      r.enabled
        ? RULE_KEYS.filter((k) => k === r.key).map((key) => ({
          key,
          threshold: r.threshold,
          points: r.points,
          required: r.required ?? false,
          unless: RULE_KEYS.find((key) => key === r.unless) ?? null,
        }))
        : []
    ),
    service_guard: { pool: [1, 2], ev: [50, 100] },
    accepted: null,
    locked_through_seconds: 0,
  };
}
