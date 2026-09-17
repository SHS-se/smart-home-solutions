import { assert, assertAlmostEquals } from "@std/assert";
import { executionFixtureRequest } from "../../../scripts/generate-battery-execution-fixtures.ts";
import {
  batteryAction,
  createBatteryActionDomain,
} from "./battery-action-domain.ts";
import { batteryExecutionSearchScope } from "./battery-execution-policy.ts";
import {
  createBatteryPrefixScorer,
  emptyObjective,
} from "./household-score.ts";
import { gridPower, solarCapacity } from "./battery-conversion.ts";

function setup(dc: boolean) {
  const r = executionFixtureRequest(1), p = r.problem, b = p.plant.equipment[0];
  assert(b.kind === "battery");
  p.plant.residual_loads[1].power_w[0] = 0;
  b.state_kwh = { ...b.state_kwh, min: 0, initial: 5, max: 17 };
  b.charge_max_w = 8800;
  b.discharge_max_w = 9600;
  if (dc) {
    b.conversion = {
      revision: "synthetic",
      grid_charge: { gain: .947, overhead_w: 36 },
      surplus_charge: { gain: .95, overhead_w: 20 },
      discharge: { gain: .974, overhead_w: 143 },
      idle_loss_w: 124,
    };
  }
  return { r, p, b };
}
for (const dc of [false, true]) {
  Deno.test(`reachable actions cross-score at native/grid/energy boundaries (DC: ${dc})`, () => {
    for (
      const [load, pv, limit, supply, exporting, gridCharge] of [
        [2920, 2350, 13200, 570, false, true],
        [3000, 0, 1000, 3000, false, true],
        [200, 4000, 13200, 0, false, false],
        [0, 0, 100, 0, true, true],
        [1000, 0, 13200, 250, false, true],
        [1000, 0, 13200, 1000, true, true],
      ] as const
    ) {
      const { r, p, b } = setup(dc);
      p.plant.pv_w[0] = pv;
      p.plant.residual_loads[0].power_w[0] = load;
      p.plant.grid.import_limit_w = limit;
      p.plant.grid.export_limit_w = 500;
      b.grid_charge_allowed[0] = gridCharge;
      b.export_allowed[0] = exporting;
      r.permissions.minimum_export_price_sek_per_kwh = -100;
      r.permissions.export_reserve_kwh = 4.5;
      r.future_supply_bound_w[0] = supply;
      const domain = createBatteryActionDomain(
        p,
        batteryExecutionSearchScope(r, 0),
      );
      const scorer = createBatteryPrefixScorer(p);
      for (const energy of [0, 4.5, 4.500001, 5, 16.999999, 17]) {
        const steps = domain.propose(0, energy, [0, 17], [0], 600);
        assert(steps.length <= domain.proposalBound(2, 1));
        for (const step of steps) {
          assert(domain.admits(0, energy, step.action, step.curtail_w));
          const scored = scorer.extend(
            {
              length: 0,
              energy_kwh: energy,
              import_w: null,
              objective: emptyObjective(),
            },
            step.action,
            step.curtail_w,
          );
          if (step.action.charge_w + step.action.discharge_w === 0) continue; // Hold may violate the grid limit.
          assert(
            scored.status === "scored",
            JSON.stringify({ dc, load, pv, energy, step, scored }),
          );
          assertAlmostEquals(
            scored.prefix.energy_kwh,
            domain.energyAfter(0, energy, step.action),
          );
        }
      }
    }
  });
}

Deno.test("DC grid cap keeps the exact solar boundary across charging activation jump", () => {
  const { r, p, b } = setup(true), f = b.conversion!;
  const load = 1000, pv = 3000;
  p.plant.pv_w[0] = pv;
  p.plant.residual_loads[0].power_w[0] = load;
  r.future_supply_bound_w[0] = 0;
  const solar = solarCapacity(f, pv, load);
  // Import limit lies in the discontinuity when grid charging first activates.
  const below = gridPower(f, solar, 0, pv, load),
    above = gridPower(f, solar + 1e-6, 0, pv, load);
  assert(above > below);
  p.plant.grid.import_limit_w = (below + above) / 2;
  const domain = createBatteryActionDomain(
    p,
    batteryExecutionSearchScope(r, 0),
  );
  const charge = domain.propose(0, 5, [0, 17], [0], null).map((s) =>
    s.action.charge_w
  );
  assertAlmostEquals(Math.max(...charge), solar);
  assert(domain.admits(0, 5, batteryAction(solar, 0, pv, load, f), 0));
});
