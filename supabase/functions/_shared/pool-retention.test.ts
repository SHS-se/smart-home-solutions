import { assert, assertEquals } from "@std/assert";
import { syntheticHome, withPool } from "../../../tests/planner-contracts/synthetic.ts";
import { runRulesPlanner } from "./run-rules-planner.ts";
import type { PublishedCommandReference } from "./rules-planner.ts";
import { actionablePlanningWarnings } from "./planner/planning-warnings.ts";
import { preparePoolService } from "./rules-pool-service.ts";

// User requirement: when rescheduling fails, retain accepted instructions;
// missing wireless observations must not manufacture continuous heating.
Deno.test("pool evidence failure retains the full accepted schedule and leaves uncovered intervals without instructions", () => {
  const s = withPool(syntheticHome(16));
  s.grid.import_limit_w = 500 + 3600 + 12 * 690;
  const input = { snapshot: s, now: s.captured_at, price_archive: [] };
  const previous = runRulesPlanner(input).plan;
  const reference: PublishedCommandReference = { plan_id: previous.plan_id, pool_planning_basis: "thermal",
    pool_stop_temperature_c: 30, slots: previous.plans.priority.slots.slice(0, 12).map((q, i) => ({ ...q,
      pool_permitted: i % 3 === 0, pool_command_w: i % 3 === 0 ? 3600 : 0, pool_w: i % 3 === 0 ? 3600 : 0,
      ev_target_current_a: 0, device_loads_w: { synthetic_pool: i % 3 === 0 ? 3600 : 0 },
      device_commands: { synthetic_pool: { type: "switch_schedule", on_seconds: i % 3 === 0 ? 900 : 0 } },
    })) };
  s.pool_model!.heater_response = undefined;
  s.comfort!.pool!.target_c = 32; // Failed rescheduling cannot silently alter the accepted target.
  const plan = runRulesPlanner(input, reference).plan;
  const slots = plan.plans.priority.slots;
  assertEquals(plan.pool!.stop_temperature_c, 30);
  for (let i = 0; i < 12; i++) {
    assertEquals(slots[i].pool_permitted, reference.slots[i].pool_permitted);
    assertEquals(slots[i].pool_command_w, reference.slots[i].pool_command_w);
    assertEquals(slots[i].device_commands!.synthetic_pool, reference.slots[i].device_commands!.synthetic_pool);
    if (slots[i].pool_permitted) {
      assertEquals(slots[i].device_loads_w.synthetic_pool, 3600);
      assert(slots[i].ev_target_current_a <= 12);
    }
  }
  for (const q of slots.slice(12)) {
    assertEquals(q.pool_permitted, null);
    assertEquals(q.pool_command_w, undefined);
    assertEquals(q.device_commands!.synthetic_pool.type, "unavailable");
    assertEquals(q.device_loads_w.synthetic_pool, 1000, "uncontrolled demand remains the measured profile");
  }
  assertEquals(slots.filter(q => q.pool_permitted).length, 4);
  assert(slots.every(q => q.pool_temperature_c === undefined), "retention must not fabricate a new temperature curve");
  const notes = actionablePlanningWarnings(plan.planning_warnings ?? []).filter(w => w.scope === "pool");
  assertEquals(notes.length, 1);
  assertEquals(notes[0].code, "pool_reschedule_failed");
  const again = runRulesPlanner(input, { plan_id: plan.plan_id, pool_planning_basis: "empirical",
    pool_stop_temperature_c: plan.pool!.stop_temperature_c, slots }).plan;
  assertEquals(again.plans.priority.slots.map(q => [q.pool_permitted, q.pool_command_w]),
    slots.map(q => [q.pool_permitted, q.pool_command_w]), "retention cannot extend itself across an uncovered tail");
});

Deno.test("missing evidence preserves independent circulation and respects unavailable pool intervals", () => {
  const s = withPool(syntheticHome(8));
  s.pool_model!.heater_response = undefined;
  s.device_models.push({ ...s.device_models[0], key: "synthetic_pump", pool_role: "circulation",
    active_power_w: 500, forecast_w_by_slot: s.slots.map(() => 200) });
  s.operating_scope = { modes: { $pool: "controlling", synthetic_pump: "controlling" },
    device_owners: { synthetic_pool: "$pool", synthetic_pump: "synthetic_pump" }, external_demands: {} };
  const accepted = s.slots.map((slot, i) => ({ start: slot.start, pool_permitted: i % 2 === 0,
    pool_command_w: i % 2 === 0 ? 3600 : 0,
    device_commands: { synthetic_pool: { type: "switch_schedule" as const, on_seconds: i % 2 === 0 ? 900 : 0 },
      synthetic_pump: { type: "switch_schedule" as const, on_seconds: i % 3 === 0 ? 900 : 0 } },
    device_loads_w: { synthetic_pool: i % 2 === 0 ? 3600 : 0, synthetic_pump: i % 3 === 0 ? 500 : 0 } }));
  s.execution_availability = [{ owner: "$pool", status: "temporarily_absent", cause: "synthetic_fault",
    blocked_intervals: [{ start: s.slots[4].start, end: s.slots[5].start }] }];
  const service = preparePoolService(s, accepted, 30);
  assertEquals(service.permitted, [true, false, true, false, null, false, true, false]);
  assertEquals(service.power.synthetic_pool[4], 1000);
  assertEquals(service.commands.synthetic_pool[4].type, "unavailable");
  assertEquals(service.commands.synthetic_pump, accepted.map(q => q.device_commands.synthetic_pump));
  assertEquals(service.power.synthetic_pump, accepted.map(q => q.device_loads_w.synthetic_pump));
});

Deno.test("thermal planning resumes after a no-instruction interval without releasing EV holds", () => {
  const s = withPool(syntheticHome(16));
  s.grid.import_limit_w = 20000; // Both services can run; recovery is not a priority override.
  const response = s.pool_model!.heater_response;
  s.pool_model!.heater_response = undefined;
  const input = { snapshot: s, now: s.captured_at, price_archive: [] };
  const unknown = runRulesPlanner(input).plan;
  assert(unknown.plans.priority.slots.every(q => q.pool_permitted === null));
  s.pool_model!.heater_response = response;
  const recovered = runRulesPlanner(input, { plan_id: unknown.plan_id, pool_planning_basis: "empirical",
    pool_stop_temperature_c: unknown.pool!.stop_temperature_c, slots: unknown.plans.priority.slots }).plan;
  assertEquals(recovered.pool!.planning_basis, "thermal");
  assert(recovered.plans.priority.slots.every(q => Number.isFinite(q.pool_temperature_c)));
  assert(recovered.plans.priority.slots.some(q => q.pool_permitted === true));
  assertEquals(recovered.plans.priority.slots.slice(0, 4).map(q => q.ev_target_current_a),
    unknown.plans.priority.slots.slice(0, 4).map(q => q.ev_target_current_a));
});

Deno.test("an explicit reviewed booking supersedes the retained pool schedule", () => {
  const s = withPool(syntheticHome(12));
  const input = { snapshot: s, now: s.captured_at, price_archive: [] };
  const previous = runRulesPlanner(input).plan;
  const slots = previous.plans.priority.slots.map(q => ({ ...q, ev_target_current_a: 0,
    pool_permitted: false, pool_command_w: 0, pool_w: 0,
    device_commands: { synthetic_pool: { type: "switch_schedule" as const, on_seconds: 0 } } }));
  const reference: PublishedCommandReference = { plan_id: previous.plan_id, pool_planning_basis: "thermal",
    pool_stop_temperature_c: 30, slots };
  s.pool_model!.heater_response = undefined;
  const booked = { ...slots[7], pool_permitted: true, pool_command_w: 3600,
    device_commands: { synthetic_pool: { type: "switch_schedule" as const, on_seconds: 900 } } };
  const result = runRulesPlanner({ ...input, fixed_plan: { id: "synthetic_booking", source_snapshot_id: s.snapshot_id,
    starts_at: slots[7].start, ends_at: slots[8].start, slots: [{ start: slots[7].start,
      targets: booked, power_w: {}, discharge_w: {}, allow_export: false }] } }, reference).plan;
  assertEquals(result.plans.priority.slots.map(q => q.pool_permitted), s.slots.map((_q, i) => i === 7));
  assertEquals(result.plans.priority.slots[7].device_commands!.synthetic_pool, booked.device_commands.synthetic_pool);
});
