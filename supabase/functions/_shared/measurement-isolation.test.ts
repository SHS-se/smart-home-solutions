import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  dispatchWorkbench,
  generateOptimisationPlan,
  type OptimisationSnapshot,
} from "./planner/energy-optimisation.ts";
import { isolateMeasurements } from "./planner/measurement-isolation.ts";
import { replanReference } from "./planner/replan-continuity.ts";
import { scoreDispatch } from "./planner/dispatch-plan.ts";
import { mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";

/** Battery, pool and a routed car, as one household. */
function household(
  car: Partial<NonNullable<OptimisationSnapshot["ev_battery"]>> = {},
): OptimisationSnapshot {
  const snapshot = mixedModeSnapshot();
  const end = new Date(Date.parse(snapshot.slots.at(-1)!.start) + 900_000)
    .toISOString();
  return {
    ...snapshot,
    capabilities: { ...snapshot.capabilities, ev: true },
    ev_battery: {
      name: "Model Y",
      connected: true,
      capacity_kwh: 75,
      soc: 0.55,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      kwh_per_km: 0.16,
      available_from: snapshot.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.ev_connected",
        soc: "sensor.ev_soc",
        target_soc: "number.ev_charge_limit",
        energy_remaining: "sensor.ev_energy_remaining",
        charge_current: "number.ev_charge_current",
      },
      ...car,
    },
    services: [...snapshot.services, {
      id: "ev:horizon",
      device: "ev",
      earliest_start: snapshot.slots[0].start,
      deadline: end,
      required_kwh: 0,
      control: {
        type: "discrete_current",
        min_current_a: 6,
        max_current_a: 16,
        current_step_a: 1,
        phase_count: 3,
        voltage_v: 230,
      },
      priority: 3,
    }],
  };
}

const now = (snapshot: OptimisationSnapshot) => new Date(snapshot.captured_at);
/** What the plan asks of the devices that were not left out. */
const schedule = (plan: ReturnType<typeof generateOptimisationPlan>) =>
  plan.plans.priority.slots.map((slot) => [
    slot.battery_charge_w,
    slot.battery_discharge_w,
    slot.pool_w,
  ]);

Deno.test("an impossible car reading leaves only the car out of the plan", () => {
  const snapshot = household({ soc: 1.05 });
  const plan = generateOptimisationPlan(snapshot, now(snapshot));

  assertEquals(plan.status, "ready", JSON.stringify(plan.validation_errors));
  assertEquals(plan.capabilities.ev, false);
  assertEquals(plan.ev_battery, null);
  assertEquals(plan.services.some((service) => service.device === "ev"), false);
  assertEquals(plan.measurement_issues, [{
    device: "ev",
    field: "soc",
    entity_id: "sensor.ev_soc",
    value: 1.05,
    reason: "The car reported a state of charge of 105%, outside 0–100%.",
    detected_by: "planner",
  }]);
  assertEquals(plan.execution_plan!.measurement_issues, plan.measurement_issues);
  // The rest of the house is planned exactly as if it had no car at all.
  const carless = mixedModeSnapshot();
  const reference = generateOptimisationPlan(carless, now(carless));
  assertEquals(plan.plans.priority.dispatched_devices, ["battery", "pool"]);
  assertEquals(schedule(plan), schedule(reference));
  assertEquals(plan.capabilities.battery, true);
  assert(plan.battery !== null, "the battery is still planned");
});

Deno.test("an impossible pool reading leaves only the pool out of the plan", () => {
  const snapshot = household();
  snapshot.pool = { ...snapshot.pool!, water_temperature_c: 500 };
  const plan = generateOptimisationPlan(snapshot, now(snapshot));

  assertEquals(plan.status, "ready", JSON.stringify(plan.validation_errors));
  assertEquals(plan.capabilities.pool, false);
  assertEquals(plan.pool, null);
  assertEquals(plan.measurement_issues.map((issue) => [issue.device, issue.field, issue.value]), [
    ["pool", "water_temperature_c", 500],
  ]);
  assertEquals(plan.plans.priority.dispatched_devices, ["battery", "ev"]);
  assertEquals(plan.capabilities.battery, true);
  assert(plan.battery !== null, "the battery is still planned");
  // The pool's running draw is still household demand, just not a decision.
  assert(plan.plans.priority.slots.every((slot) => slot.pool_w === 0));
});

Deno.test("an impossible battery reading leaves only the battery out of the plan", () => {
  for (const soc of [-0.1, 1.3]) {
    const snapshot = household();
    snapshot.battery = { ...snapshot.battery!, soc };
    const plan = generateOptimisationPlan(snapshot, now(snapshot));

    assertEquals(plan.status, "ready", JSON.stringify(plan.validation_errors));
    assertEquals(plan.capabilities.battery, false);
    assertEquals(plan.battery, null);
    assertEquals(plan.battery_execution, undefined);
    assertEquals(plan.sources.battery, null);
    assertEquals(plan.measurement_issues.map((issue) => [issue.device, issue.entity_id]), [
      ["battery", "sensor.sigen_plant_battery_state_of_charge"],
    ]);
    assertEquals(plan.plans.priority.dispatched_devices, ["ev", "pool"]);
  }
});

Deno.test("a device Home Assistant already left out stays named, and a named device stays out", () => {
  const snapshot = household();
  snapshot.capabilities = { ...snapshot.capabilities, ev: false };
  snapshot.ev_battery = null;
  snapshot.services = snapshot.services.filter((service) => service.device !== "ev");
  const unavailable = {
    device: "ev" as const,
    field: "soc",
    entity_id: "sensor.ev_soc",
    value: "unavailable",
    reason: "The car's state of charge is unavailable.",
    detected_by: "home_assistant" as const,
  };
  snapshot.measurement_issues = [unavailable];
  const plan = generateOptimisationPlan(snapshot, now(snapshot));
  assertEquals(plan.status, "ready");
  assertEquals(plan.measurement_issues, [unavailable]);

  // A reported issue takes its device out even if the state is still present.
  const contradictory = household();
  contradictory.measurement_issues = [unavailable];
  const isolated = generateOptimisationPlan(contradictory, now(contradictory));
  assertEquals(isolated.capabilities.ev, false);
  assertEquals(isolated.measurement_issues, [unavailable]);
});

Deno.test("isolation is idempotent and refuses a malformed issue list", () => {
  const once = isolateMeasurements(household({ soc: 1.05, departure_target_soc: 8 }));
  assertEquals(once.measurement_issues!.map((issue) => issue.field), ["soc", "departure_target_soc"]);
  assertEquals(isolateMeasurements(once), once);
  const clean = household();
  assertEquals(isolateMeasurements(clean), clean);
  assertThrows(
    () => isolateMeasurements({ ...household(), measurement_issues: [{ device: "ev" }] as never }),
    Error,
    "measurement_issues[0] is invalid",
  );
});

Deno.test("the workbench leaves out the same devices as the plan", () => {
  const snapshot = household({ soc: 1.05 });
  const bench = dispatchWorkbench(snapshot, [], undefined, now(snapshot))!;
  assertEquals(bench.stores.map((store) => store.key).sort(), ["battery", "pool"]);
});

Deno.test("realistic states beyond a target are planned as they are", () => {
  // Above its own charge limit: the car needs nothing, and nothing else stops.
  const car = household({ soc: 0.83 });
  const plan = generateOptimisationPlan(car, now(car));
  assertEquals(plan.status, "ready", JSON.stringify(plan.validation_errors));
  assertEquals(plan.measurement_issues, []);
  assertEquals(plan.plans.priority.store_diagnostics.find((store) => store.key === "ev")?.end_state,
    plan.plans.priority.store_diagnostics.find((store) => store.key === "ev")?.state);
  const bench = dispatchWorkbench(car, [], undefined, now(car))!;
  assertEquals(scoreDispatch(bench.slots, bench.stores, bench.limits, bench.planned).infeasibilities, []);

  // Below a cut-off raised after the pack discharged, and with the cut-off now
  // above the configured targets.
  const pack = household();
  pack.battery = { ...pack.battery!, soc: 0.08, min_soc: 0.3 };
  const low = generateOptimisationPlan(pack, now(pack));
  assertEquals(low.status, "ready", JSON.stringify(low.validation_errors));
  assertEquals(low.measurement_issues, []);
  assert(low.plans.priority.slots.every((slot) => slot.battery_discharge_w === 0),
    "a pack below its cut-off is not discharged");

  // Warmer than its stop temperature: no heat is bought.
  const warm = household();
  warm.pool = { ...warm.pool!, water_temperature_c: 34 };
  const pool = generateOptimisationPlan(warm, now(warm));
  assertEquals(pool.status, "ready", JSON.stringify(pool.validation_errors));
  assert(pool.plans.priority.slots.every((slot) => slot.pool_w === 0));
});

Deno.test("a car above its charge limit keeps replan continuity for the house", () => {
  const snapshot = household({ soc: 0.83 });
  const previous = generateOptimisationPlan(snapshot, now(snapshot));
  const next = { ...snapshot, snapshot_id: "00000000-0000-4000-8000-000000000009" };
  next.replan_reference = replanReference(previous, next, now(next));
  assert(next.replan_reference, "the previous plan is a usable reference");
  const continued = generateOptimisationPlan(next, now(next));
  // Before, the car's reading scored every schedule infeasible and continuity
  // was bypassed with `invalid_proposed_dispatch`.
  assert(
    !["invalid_proposed_dispatch", "invalid_reference"].includes(continued.plans.priority.continuity!.reason),
    JSON.stringify(continued.plans.priority.continuity),
  );
  assert(continued.plans.priority.continuity!.proposed_sek !== null);
});
