import { batterySnapshot } from "./generate-ha-plan-fixture.ts";
import { generateOptimisationPlanWithBatteryProjection } from "../supabase/functions/_shared/planner/energy-optimisation.ts";


export function batteryExecutionFixture() {
  const snapshot = { ...batterySnapshot(), schema_version: 9 as const,
    operating_scope: { modes: { $battery: "controlling" as const, $pool: "monitoring" as const, $ev: "monitoring" as const },
      device_owners: {}, external_demands: {} },
    battery_execution_feedback: { generation: 1, source_receipt: 0, previous_contract_id: null,
      objectives: [], scope_revision: "fixture-whole-house" },
  };
  const now = new Date(Date.parse(snapshot.slots[0].start) + 8 * 60_000);
  snapshot.captured_at = now.toISOString();
  const result = generateOptimisationPlanWithBatteryProjection(snapshot, now);
  const contract = result.plan.battery_execution;
  if (!contract) throw new Error("planner did not publish execution instructions");
  return {
    fixture: "battery-plan-execution-v1", generated_by: "generateOptimisationPlanWithBatteryProjection",
    captured_at: now.toISOString(), contract,
  };
}

if (import.meta.main) {
  await Deno.writeTextFile(new URL("../contracts/ha-api/fixtures/battery-plan-execution-v1.json", import.meta.url),
    JSON.stringify(batteryExecutionFixture(), null, 2) + "\n");
}
