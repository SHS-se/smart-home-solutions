import { batterySnapshot } from "./generate-ha-plan-fixture.ts";
import { generateOptimisationPlanWithBatteryProjection } from "../supabase/functions/_shared/energy-optimisation.ts";
import { buildBatteryExecutionContract } from "../supabase/functions/_shared/battery-plan-execution.ts";

export function batteryExecutionFixture() {
  const snapshot = batterySnapshot();
  const now = new Date(Date.parse(snapshot.slots[0].start) + 8 * 60_000);
  snapshot.captured_at = now.toISOString();
  const result = generateOptimisationPlanWithBatteryProjection(snapshot, now);
  const projection = result.battery_projection;
  if (projection.status !== "ready") throw new Error(projection.reasons.join(","));
  const contract = buildBatteryExecutionContract({
    plan: result.plan, rows: projection.provenance.final_demand,
    pv_w: projection.problem.plant.pv_w, mode: "controlling", scope_revision: "fixture-whole-house",
    feedback: { generation: 0, source_receipt: 0, previous_contract_id: null, objectives: [] },
  });
  return {
    fixture: "battery-plan-execution-v1", generated_by: "generateOptimisationPlanWithBatteryProjection",
    captured_at: now.toISOString(), contract,
  };
}

if (import.meta.main) {
  await Deno.writeTextFile(new URL("../contracts/ha-api/fixtures/battery-plan-execution-v1.json", import.meta.url),
    JSON.stringify(batteryExecutionFixture(), null, 2) + "\n");
}
