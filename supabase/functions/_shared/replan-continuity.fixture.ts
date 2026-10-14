import { assert } from "jsr:@std/assert@1";
import { snapshotV8 } from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import { replanReference } from "./planner/replan-continuity.ts";
import { solvedPlan } from "./planner/solved-plan.fixture.ts";

export function referencedSnapshot(cheap = false) {
  const input = snapshotV8();
  if (cheap) {
    input.slots.forEach((s) => {
      if (s.import_price_sek_per_kwh !== null) s.import_price_sek_per_kwh *= .1;
      if (s.export_price_sek_per_kwh !== null) s.export_price_sek_per_kwh *= .1;
    });
    // Guarantee house supply in the first quarter under any later pool run
    // search; a 10 W reference adjustment then tests the same battery action.
    input.slots[0].import_price_sek_per_kwh = 1;
    // These continuity cases need a fixed declining valuation: a 10 W
    // adjustment stays within the deadband, while replacing house supply
    // with hold costs enough to switch immediately. Previously the automatic
    // candidate search supplied this shape; balanced valuation need not do so.
    const battery = input.battery!;
    input.battery_curve_mode = "custom";
    input.value_curves = { ...input.value_curves, battery: {
      unit: "kwh",
      points: [
        { at: 0, sek_per_unit: .159 },
        { at: (battery.max_soc - battery.min_soc) * battery.capacity_kwh, sek_per_unit: 0 },
      ],
    } };
  }
  const previous = solvedPlan(input, new Date(input.captured_at)).plan;
  input.snapshot_id = "00000000-0000-4000-8000-000000000002";
  input.replan_reference = replanReference(
    previous,
    input,
    new Date(input.captured_at),
  );
  assert(input.replan_reference);
  return { input, previous };
}
