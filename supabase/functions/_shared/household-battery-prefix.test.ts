import { assert, assertEquals, assertThrows } from "@std/assert";
import { executionFixtureRequest } from "../../../scripts/generate-battery-execution-fixtures.ts";
import { convertedFlows } from "./battery-conversion.ts";
import {
  createBatteryPrefixScorer,
  createHouseholdScorer,
  emptyObjective,
  type Objective,
  reconcileObjective,
} from "./household-score.ts";
import type { HouseholdCandidate } from "./household-case.ts";

type Action = Extract<
  HouseholdCandidate["actions"][string][number],
  { kind: "battery" }
>;
const action = (
  charge = 0,
  discharge = 0,
  solar = 0,
  exported = 0,
): Action => ({
  kind: "battery",
  charge_w: charge,
  discharge_w: discharge,
  solar_charge_w: solar,
  export_w: exported,
});

for (const dc of [false, true]) {
  for (const wear of ["ac_throughput", "discharged_storage"] as const) {
    Deno.test(`incremental battery scoring exactly matches every full trajectory prefix: DC=${dc}, wear=${wear}`, () => {
      const { problem } = executionFixtureRequest(8);
      const b = problem.plant.equipment[0];
      assert(b.kind === "battery");
      b.wear_basis = wear;
      b.charge_efficiency = .91;
      b.discharge_efficiency = .87;
      if (dc) {
        b.conversion = {
          revision: "measured-losses",
          grid_charge: { gain: .95, overhead_w: 0 },
          surplus_charge: { gain: .96, overhead_w: 5 },
          discharge: { gain: .988, overhead_w: 162.58 },
          idle_loss_w: 125.83,
        };
      }
      const actions = problem.intervals.map((_, i) => {
        const charge = [800, 0, 0, 250][i % 4],
          discharge = i % 4 === 1 ? 500 : 0;
        const load = problem.plant.residual_loads.reduce(
            (s, l) => s + l.power_w[i],
            0,
          ),
          pv = problem.plant.pv_w[i];
        const f = b.conversion
          ? convertedFlows(b.conversion, charge, discharge, pv, load)
          : null;
        return action(
          charge,
          discharge,
          f ? f.solar : Math.min(charge, Math.max(0, pv - load)),
          Math.max(0, (f ? f.discharge : discharge) - Math.max(0, load - pv)),
        );
      });
      const candidate = {
        id: "path",
        actions: { [b.id]: actions },
        pv_curtail_w: actions.map(() => 0),
      };
      const full = createHouseholdScorer(problem).score(candidate);
      assert(full.status === "scored", JSON.stringify(full));
      const scorer = createBatteryPrefixScorer(problem);
      let prefix = scorer.initial;
      const totals = emptyObjective();
      for (let i = 0; i < actions.length; i++) {
        const before = structuredClone(prefix);
        const step = scorer.extend(prefix, actions[i], 0);
        assertEquals(
          prefix,
          before,
          "sibling search paths cannot mutate one another",
        );
        assertEquals(scorer.extend(prefix, actions[i], 0), step);
        assert(step.status === "scored");
        prefix = step.prefix;
        for (const key of Object.keys(totals) as (keyof Objective)[]) {
          totals[key] += full.intervals[i].objective[key];
        }
        if (i === actions.length - 1) {
          for (const key of Object.keys(totals) as (keyof Objective)[]) {
            totals[key] += full.closing[key];
          }
        }
        assertEquals(prefix.energy_kwh, full.trajectory.state[b.id][i + 1]);
        assertEquals(prefix.import_w, full.trajectory.intervals[i].import_w);
        assertEquals(prefix.objective, reconcileObjective(totals));
      }
      assertEquals(prefix.objective, full.objective);
      assertThrows(() => scorer.extend(prefix, action(), 0), RangeError);
    });
  }
}

Deno.test("incremental scoring retains full scorer physical and structural rejections", () => {
  const cases = [
    "unavailable",
    "rating",
    "simultaneous",
    "grid_charge",
    "export",
    "grid_limit",
    "energy_limit",
    "curtailment",
    "nonfinite",
  ];
  for (const kind of cases) {
    const { problem } = executionFixtureRequest(1);
    const b = problem.plant.equipment[0];
    assert(b.kind === "battery");
    problem.plant.pv_w[0] = 0;
    let a = action(500), curtailed = 0;
    switch (kind) {
      case "unavailable":
        b.available[0] = false;
        break;
      case "rating":
        a = action(b.charge_max_w + 1);
        break;
      case "simultaneous":
        a = action(500, 500);
        break;
      case "grid_charge":
        b.grid_charge_allowed[0] = false;
        break;
      case "export":
        b.export_allowed[0] = false;
        problem.plant.residual_loads.forEach((l) => l.power_w[0] = 0);
        a = action(0, 500, 0, 500);
        break;
      case "grid_limit":
        problem.plant.grid.import_limit_w = 100;
        break;
      case "energy_limit":
        b.state_kwh.initial = b.state_kwh.max;
        break;
      case "curtailment":
        curtailed = 1;
        break;
      case "nonfinite":
        a = action(NaN);
        break;
    }
    const full = createHouseholdScorer(problem).score({
      id: "bad",
      actions: { [b.id]: [a] },
      pv_curtail_w: [curtailed],
    });
    const scorer = createBatteryPrefixScorer(problem),
      step = scorer.extend(scorer.initial, a, curtailed);
    assert(full.status !== "scored", kind);
    assertEquals(step.status, full.status, kind);
    if (full.status === "physically_infeasible" && step.status !== "scored") {
      assertEquals(step.violations, full.violations, kind);
    }
  }
});

Deno.test("prepared actions retain live energy, previous-import costs, interval permissions and input isolation", () => {
  const { problem } = executionFixtureRequest(2),
    b = problem.plant.equipment[0];
  assert(b.kind === "battery");
  problem.plant.pv_w.fill(0);
  problem.plant.residual_loads.forEach((l) => l.power_w.fill(1000));
  b.available[1] = false;
  const scorer = createBatteryPrefixScorer(problem), a = action(500);
  const first = scorer.extend(scorer.initial, a, 0);
  assert(first.status === "scored");
  const ramp = scorer.extend({ ...scorer.initial, import_w: 0 }, a, 0);
  assert(ramp.status === "scored");
  assert(ramp.prefix.objective.ramp_sek !== first.prefix.objective.ramp_sek);
  const high = scorer.extend(
    { ...scorer.initial, energy_kwh: b.state_kwh.max },
    a,
    0,
  );
  assert(high.status === "physically_infeasible");
  // Mutating a rejection must not poison cached physics for siblings.
  high.violations[0].message = "caller mutation";
  assertEquals(scorer.extend(scorer.initial, a, 0), first);
  a.charge_w = b.charge_max_w + 1;
  assertEquals(
    scorer.extend(scorer.initial, a, 0).status,
    "physically_infeasible",
  );
  a.charge_w = 500;
  assertEquals(
    scorer.extend(scorer.initial, a, 1).status,
    "physically_infeasible",
  );
  assertEquals(
    scorer.extend(first.prefix, a, 0).status,
    "physically_infeasible",
  );
  assertEquals(scorer.extend(scorer.initial, a, 0), first);
});

Deno.test("cached action validation never admits malformed scalar or extra fields", () => {
  const { problem } = executionFixtureRequest(1);
  const scorer = createBatteryPrefixScorer(problem);
  assertEquals(scorer.extend(scorer.initial, action(500), 0).status, "scored");
  for (
    const raw of [
      { ...action(500), extra: undefined },
      { ...action(500), charge_w: { toJSON: () => 500 } },
      { ...action(500), charge_w: NaN },
      { ...action(500), charge_w: null },
      { ...action(500), charge_w: Infinity },
      { ...action(500), charge_w: "500" },
      null,
    ]
  ) {
    assertEquals(
      scorer.extend(scorer.initial, raw as Action, 0).status,
      "invalid_candidate",
    );
  }
  assertEquals(
    scorer.extend(scorer.initial, action(500), NaN).status,
    "invalid_candidate",
  );
  assertEquals(scorer.extend(scorer.initial, action(500), 0).status, "scored");
});
