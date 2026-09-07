// deno run --allow-read scripts/compare-planner-replay.ts capsule.json [from-ISO to-ISO]
// Reads captured data only. Never executes the capsule's entrypoint instructions.
import {
  generateOptimisationPlan,
  type OptimisationPlan,
} from "../supabase/functions/_shared/energy-optimisation.ts";

const [path, from, to] = Deno.args;
if (
  !path || Boolean(from) !== Boolean(to) ||
  (from &&
    (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) ||
      Date.parse(from) >= Date.parse(to)))
) {
  throw new Error(
    "Usage: compare-planner-replay.ts capsule.json [from-ISO to-ISO]",
  );
}
const capsule = JSON.parse(await Deno.readTextFile(path));
if (
  capsule.format !== "shs-energy-optimisation-quarter-replay" ||
  capsule.schema_version !== 1
) {
  throw new Error("Expected a version 1 quarter replay capsule");
}
const input = capsule.entrypoint.arguments;
const started = performance.now();
const result = generateOptimisationPlan(
  input.snapshot,
  new Date(input.now),
  input.price_archive,
  input.resolved_price_outlook,
);
const elapsedMs = performance.now() - started;
const metrics = (plan: OptimisationPlan) => {
  const scenario = plan.plans.priority;
  const slots = scenario.slots.filter((slot) =>
    !from ||
    (Date.parse(slot.start) >= Date.parse(from) &&
      Date.parse(slot.start) < Date.parse(to))
  );
  if (!slots.length) throw new Error("Selected interval contains no quarters");
  const starts = (field: "battery_charge_w") =>
    slots.reduce((sum, slot, i) =>
      sum + ((slot[field] ?? 0) > 1 &&
          (i === 0 || (slots[i - 1][field] ?? 0) <= 1)
        ? 1
        : 0), 0);
  return {
    model: plan.model_version,
    status: plan.status,
    errors: plan.validation_errors,
    peak_import_w: Math.max(...slots.map((slot) => slot.grid_import_w)),
    grid_variation_kw: slots.slice(1).reduce(
      (sum, slot, i) =>
        sum + Math.abs(slot.grid_import_w - slots[i].grid_import_w) / 1_000,
      0,
    ),
    battery_charge_runs: starts("battery_charge_w"),
    battery_charged_kwh: slots.reduce(
      (sum, slot) => sum + slot.battery_charge_w / 4_000,
      0,
    ),
    // Full-horizon summary includes closing inventory: lower spending alone
    // must not be presented as savings at equal service or equal battery SOC.
    horizon_summary: scenario.summary,
  };
};
console.log(
  JSON.stringify(
    {
      elapsed_ms: elapsedMs,
      from: from ?? null,
      to: to ?? null,
      captured: metrics(capsule.expected.planner_output),
      current: metrics(result),
    },
    null,
    2,
  ),
);
