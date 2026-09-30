import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { batteryExecutionFixture } from "../../../scripts/generate-battery-execution-fixture.ts";
import { batterySnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateOptimisationPlanWithBatteryProjection } from "./planner/energy-optimisation.ts";
import { buildBatteryExecutionContract } from "./planner/battery-plan-execution.ts";

function source() {
  const snapshot = batterySnapshot();
  const result = generateOptimisationPlanWithBatteryProjection(snapshot, new Date(snapshot.captured_at));
  if (result.battery_projection.status !== "ready") throw new Error("fixture projection unavailable");
  return { plan: result.plan, rows: result.battery_projection.provenance.final_demand,
    pv_w: result.battery_projection.problem.plant.pv_w,
    mode: "controlling" as const, scope_revision: "whole-house",
    feedback: { generation: 0, source_receipt: 0, previous_contract_id: null, objectives: [] } };
}

Deno.test("canonical reference preserves a partial first quarter and every gross flow", () => {
  const { contract } = batteryExecutionFixture();
  assertEquals(contract.intervals[0].end_ms - contract.intervals[0].start_ms, 7 * 60_000);
  for (const row of contract.intervals) {
    assertEquals(row.pv_mwh + row.import_mwh + row.discharge_ac_mwh,
      row.load_mwh - row.unserved_mwh + row.charge_ac_mwh + row.export_mwh + row.curtailed_mwh + row.rounding_mwh);
    assert(Math.abs(row.rounding_mwh) <= 4);
    assert(row.stored_end_mwh <= contract.maximum_mwh);
    assert(row.stored_end_mwh >= contract.minimum_mwh);
    assert(!(row.charge_ac_mwh && row.discharge_ac_mwh));
  }
});

Deno.test("recovery is allocated once inside the original charging objective", () => {
  const contract = buildBatteryExecutionContract(source());
  for (const r of contract.recovery) {
    const objective = contract.objectives.find((o) => o.id === r.objective_id)!;
    assertEquals(objective.kind, "stored_energy");
    assert(r.end_ms <= objective.deadline_ms);
    assert(r.start_ms >= objective.start_ms);
    assertEquals(r.rule, "nominal_first_then_earliest");
    const row = contract.intervals.find((s) => s.start_ms === r.start_ms)!;
    assert(row.grid_charge_allowed);
    assert(r.max_correction_mwh <= objective.target_mwh - contract.minimum_mwh);
  }
  assertEquals(new Set(contract.recovery.map((r) => r.start_ms)).size, contract.recovery.length);
});

Deno.test("replan explicitly incorporates old responsibility without claiming recovery", () => {
  const input = source();
  const contract = buildBatteryExecutionContract({ ...input,
    feedback: { generation: 2, source_receipt: 80, previous_contract_id: "old-contract",
      objectives: [{ objective: { id: "old-need", deadline_ms: 100, kind: "stored_energy" },
        outcome: "missed", responsibility: "outstanding" }] } });
  assertEquals(contract.source_receipt, 80);
  assertEquals(contract.generation, 2);
  assertEquals(contract.previous_contract_id, "old-contract");
  assertEquals(contract.dispositions.length, 1);
  assertEquals(contract.dispositions[0].objective_id, "old-need");
  assert(["incorporated", "retired"].includes(contract.dispositions[0].outcome));
});

Deno.test("contract does not infer feedback generation, permissions or missing rows", () => {
  const input = source();
  assertThrows(() => buildBatteryExecutionContract({ ...input, rows: [] }));
  assertThrows(() => buildBatteryExecutionContract({ ...input,
    feedback: { ...input.feedback, generation: -1 } }));
  input.plan.plans.priority.slots[0].battery_command = null;
  assertThrows(() => buildBatteryExecutionContract(input), Error, "role missing");
});

Deno.test("stored execution consumer fixture comes from the real planner", async () => {
  const stored = JSON.parse(await Deno.readTextFile(new URL("../../../contracts/ha-api/fixtures/battery-plan-execution-v1.json", import.meta.url)));
  assertEquals(stored, batteryExecutionFixture());
});

import { mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { assembleOptimisationPlan, energyPlanningStep } from "./energy-planning-step.ts";
import type { EnergyPlanningContinuation } from "./energy-planning-protocol.ts";

function captured(mode: "controlling" | "control_verification") {
  const s = mixedModeSnapshot();
  s.operating_scope.modes.$battery = mode;
  s.battery_execution_feedback = { generation: 4, source_receipt: 17, previous_contract_id: null,
    scope_revision: "local-setup", observed: { at_ms: Date.parse(s.captured_at),
      stored_mwh: Math.round(s.battery!.soc * s.battery!.capacity_kwh * 1e6), source: "soc" }, objectives: [] };
  return s;
}

Deno.test("production contract binds the physical branch and acknowledges captured evidence", () => {
  const s = captured("controlling");
  const { plan, battery_projection } = generateOptimisationPlanWithBatteryProjection(s, new Date(s.captured_at));
  const contract = plan.battery_execution!;
  assert(contract);
  assertEquals(contract.generation, 4); assertEquals(contract.source_receipt, 17);
  assertEquals(contract.scope_revision, "local-setup");
  assertEquals(contract.intervals[0].load_mwh, Math.round(plan.execution_plan!.plans.priority.slots[0].load_w * plan.execution_plan!.plans.priority.slots[0].duration_hours * 1000));
  assertEquals(battery_projection.status, "unsupported");
});

Deno.test("Verification uses the same displayed household schedule", () => {
  const s = captured("control_verification");
  const { plan } = generateOptimisationPlanWithBatteryProjection(s, new Date(s.captured_at));
  const contract = plan.battery_execution!;
  assertEquals(contract.mode, "control_verification");
  assertEquals(plan.execution_plan!.battery, plan.battery);
  assertEquals(plan.execution_plan!.plans, plan.plans);
  for (const [i, row] of contract.intervals.entries()) {
    const slot = plan.execution_plan!.plans.priority.slots[i];
    assert(Math.abs(row.load_mwh - slot.load_w * slot.duration_hours * 1000) <= 2);
  }
});

Deno.test("excluded battery cannot be resurrected by retained feedback", () => {
  const s = captured("control_verification");
  s.battery = null; s.capabilities.battery = false; s.sources.battery = null;
  s.policy = {battery_target_is_hard:false,battery_end_of_solar_target_soc:0,
    terminal_soc_min:0,terminal_energy_value_sek_per_kwh:0,battery_export_enabled:false,
    battery_export_reserve_soc:0,battery_export_min_price_sek_per_kwh:0};
  assertEquals(generateOptimisationPlanWithBatteryProjection(s, new Date(s.captured_at)).plan.battery_execution, undefined);
});

Deno.test("execution feedback survives staged worker planning and repeats deterministically", () => {
  const s = captured("control_verification");
  const input = { snapshot:s, now:s.captured_at, price_archive:[] };
  const continuation: EnergyPlanningContinuation = { completed: [] };
  for (let i=0;i<100;i++) {
    const step = energyPlanningStep(input, continuation);
    continuation.completed.push(...step.completed);
    continuation.checkpoint = step.checkpoint;
    if (step.done) {
      assertEquals(assembleOptimisationPlan(input, continuation.completed).plan.battery_execution,
        generateOptimisationPlanWithBatteryProjection(s,new Date(s.captured_at)).plan.battery_execution);
      return;
    }
  }
  throw new Error("worker did not finish");
});

Deno.test("live responsibilities retain identity and explicitly amend changed targets", () => {
  const input = source();
  const old = buildBatteryExecutionContract(input);
  const first = old.objectives[0];
  input.plan.battery!.soc += 0.01;
  for (const responsibility of ["outstanding", "retained"]) {
    const revised = buildBatteryExecutionContract({ ...input, feedback: {
      generation: 1, source_receipt: 10, previous_contract_id: old.id,
      objectives: [{ objective: first, responsibility, outcome: "pending" }],
    }});
    assertEquals(revised.objectives[0].id, first.id);
    assert(revised.objectives[0].target_mwh !== first.target_mwh);
    assertEquals(revised.dispositions[0].outcome, "retained");
  }
});

Deno.test("incorporated windows that return get a new lifetime identity", () => {
  const input = source();
  const old = buildBatteryExecutionContract(input);
  const first = old.objectives[0];
  // Replace the first permission window with demand-following. The old
  // permission is incorporated into the later permission window.
  assertEquals(first.kind, "permission");
  const nextInput = structuredClone(input);
  for (const [i, row] of nextInput.rows.entries()) {
    if (Date.parse(row.end) <= first.deadline_ms) {
      nextInput.plan.plans.priority.slots[i].battery_command!.operation = "supply_house";
    }
  }
  const revised = buildBatteryExecutionContract({ ...nextInput, feedback: {
    generation: 1, source_receipt: 10, previous_contract_id: old.id,
    objectives: old.objectives.map((objective) => ({ objective,
      responsibility: "outstanding", outcome: "open" })),
  }});
  const disposition = revised.dispositions.find((d) => d.objective_id === first.id)!;
  assertEquals(disposition.outcome, "incorporated");
  assert(disposition.replacement_id !== first.id);
  input.plan.battery!.soc += 0.01;
  // Compact feedback contains all current responsibilities, but not the
  // original permission that was incorporated into the later window.
  const revivedInput = { ...input, feedback: {
    generation: 2, source_receipt: 20, previous_contract_id: revised.id,
    objectives: revised.objectives.map((objective) => ({ objective,
      responsibility: "outstanding", outcome: "open" })),
  }};
  const revived = buildBatteryExecutionContract(revivedInput);
  assertEquals(revived.objectives[0].deadline_ms, first.deadline_ms);
  assert(revived.objectives[0].target_mwh !== first.target_mwh);
  assert(revived.objectives[0].id !== first.id);
  assertEquals(revived, buildBatteryExecutionContract(revivedInput));
  // Full feedback must not revive closed identities either.
  for (const responsibility of ["incorporated", "retired"]) {
    const withHistory = buildBatteryExecutionContract({ ...revivedInput, feedback: {
      ...revivedInput.feedback, objectives: [...revivedInput.feedback.objectives,
        { objective: first, responsibility, outcome: "changed_before_deadline" }],
    }});
    assertEquals(withHistory, revived);
  }
});
