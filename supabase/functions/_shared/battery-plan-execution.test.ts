import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { batteryExecutionFixture } from "../../../scripts/generate-battery-execution-fixture.ts";
import { batterySnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateOptimisationPlanWithBatteryProjection } from "./energy-optimisation.ts";
import { buildBatteryExecutionContract } from "./battery-plan-execution.ts";

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
