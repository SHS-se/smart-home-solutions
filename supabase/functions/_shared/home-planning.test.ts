import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyBatteryChoice } from "./home-planning.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateOptimisationPlan } from "./planner/energy-optimisation.ts";

Deno.test("battery exclusion changes planning without mutating hardware or per-device identity", () => {
  const original = dispatchedEvSnapshot();
  const before = structuredClone(original);
  const excluded = applyBatteryChoice(original, false);
  assertEquals(original, before);
  assertEquals(excluded.battery, null);
  assertEquals(excluded.capabilities.battery, false);
  assertEquals(excluded.device_models, original.device_models);
  assertEquals(excluded.policy.battery_export_enabled, false);
  assertEquals(excluded.policy.battery_export_reserve_soc, 0);
  const plan = generateOptimisationPlan(excluded, new Date(excluded.captured_at));
  assertEquals(plan.capabilities.battery, false);
  for (const slot of plan.plans.priority.slots) {
    assertEquals(slot.battery_charge_w, 0); assertEquals(slot.battery_discharge_w, 0);
  }
  assertEquals(applyBatteryChoice(original, true), original);
});
