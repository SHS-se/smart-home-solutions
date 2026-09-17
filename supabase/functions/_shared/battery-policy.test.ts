import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compileBatteryPolicy, selectBatteryPolicy } from "./battery-policy.ts";
import { createHouseholdScorer } from "./household-score.ts";
import type {
  Equipment,
  HouseholdCandidate,
  HouseholdProblem,
} from "./household-case.ts";

type Battery = Extract<Equipment, { kind: "battery" }>;
type Action = Extract<
  HouseholdCandidate["actions"][string][number],
  { kind: "battery" }
>;
interface Case {
  problem: HouseholdProblem;
  reference_id: string;
  alternatives: {
    id: string;
    current: { actions: Action[]; pv_curtail_w: number[] };
  }[];
  search: {
    energy_levels_kwh: number[];
    pv_curtailment_fractions: number[];
    retained_per_level: number;
    max_interval_evaluations: number;
  };
}
const fixture: Case = JSON.parse(
  Deno.readTextFileSync(
    new URL(
      "../../../docs/energy-optimisation/fixtures/battery-policy/fixed-tail-reversal.json",
      import.meta.url,
    ),
  ),
);
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
function base(n = 3): Case {
  const c = structuredClone(fixture);
  c.problem.intervals = Array.from({ length: n }, (_, i) => ({
    start: new Date(
      Date.parse(c.problem.identity.actuals_watermark) + i * 900000,
    ).toISOString(),
    end: new Date(
      Date.parse(c.problem.identity.actuals_watermark) + (i + 1) * 900000,
    ).toISOString(),
  }));
  c.problem.plant.pv_w = Array(n).fill(0);
  c.problem.plant.residual_loads[0].power_w = Array(n).fill(1000);
  const b = battery(c);
  b.available = Array(n).fill(true);
  b.grid_charge_allowed = Array(n).fill(false);
  b.export_allowed = Array(n).fill(false);
  c.problem.economics.import_sek_per_kwh = Array(n).fill(1);
  c.problem.economics.export_sek_per_kwh = Array(n).fill(0);
  c.search.max_interval_evaluations = 1_000_000;
  return c;
}
function battery(c: Case): Battery {
  const b = c.problem.plant.equipment[0];
  assert(b.kind === "battery");
  return b;
}
function compiled(c: Case) {
  const result = compileBatteryPolicy(c);
  assert(result.status === "compiled", JSON.stringify(result));
  return result;
}
function fullCandidate(c: Case, powers: Action[]): HouseholdCandidate {
  return {
    id: "oracle",
    actions: { [battery(c).id]: powers },
    pv_curtail_w: Array(powers.length).fill(0),
  };
}

Deno.test("battery compiler reverses the frozen-tail decision by rescheduling the future", () => {
  const c = structuredClone(fixture);
  const r = compiled(c);
  const score = createHouseholdScorer(c.problem).score;
  const frozenHold = score(fullCandidate(c, [action(), action(), action()]));
  const frozenDischarge = score(
    fullCandidate(c, [action(0, 1000), action(), action()]),
  );
  assert(frozenHold.status === "scored" && frozenDischarge.status === "scored");
  assert(frozenDischarge.objective.total_sek < frozenHold.objective.total_sek);
  assertEquals(r.ranking, ["hold", "discharge"]);
  const hold = r.alternatives.find((a) => a.id === "hold")!;
  const discharge = r.alternatives.find((a) => a.id === "discharge")!;
  assertEquals(hold.full.total_sek, 0.75);
  assertEquals(discharge.full.total_sek, 2.75);
  assertEquals(discharge.current.total_sek - hold.current.total_sek, -0.5);
  assertEquals(discharge.future_delta.total_sek, 2.5);
  assertEquals(discharge.total_delta_sek, 2);
  for (const a of r.alternatives) {
    const independent = score(a.candidate);
    assert(independent.status === "scored");
    assertEquals(independent.objective, a.full);
    for (const key of Object.keys(a.full) as (keyof typeof a.full)[]) {
      assertAlmostEquals(
        a.current[key] - hold.current[key] + a.future_delta[key],
        a.full[key] - hold.full[key],
      );
    }
    assert(a.search.exhaustive_in_declared_graph);
    assert(a.search.interval_evaluations <= c.search.max_interval_evaluations);
  }
  assert(
    r.work.interval_evaluations <= r.work.interval_evaluations_upper_bound,
  );
});

Deno.test("battery compiler values negative-price grid recovery with losses and gross wear", () => {
  const c = base(2), b = battery(c);
  b.state_kwh.initial = 0;
  b.grid_charge_allowed.fill(true);
  b.charge_efficiency = b.discharge_efficiency = 0.95;
  b.wear_sek_per_kwh = 0.1;
  c.problem.plant.residual_loads[0].power_w = [0, 1000];
  c.problem.economics.import_sek_per_kwh = [-1, 10];
  c.alternatives[1] = {
    id: "charge",
    current: { actions: [action(1000)], pv_curtail_w: [0] },
  };
  const r = compiled(c),
    charge = r.alternatives.find((a) => a.id === "charge")!;
  assertEquals(r.ranking[0], "charge");
  assertAlmostEquals(charge.full.total_sek, 0.0413125);
  assertAlmostEquals(charge.full.wear_sek, 0.0475625);
  b.grid_charge_allowed[0] = false;
  const restricted = compiled(c);
  assertEquals(restricted.ranking, ["hold"]);
  assertEquals(restricted.omitted[0].status, "current_infeasible");
});

Deno.test("battery compiler keeps terminal value after the current boundary even for one-quarter horizon", () => {
  const c = base(1);
  battery(c).state_kwh.initial = 0;
  battery(c).grid_charge_allowed.fill(true);
  c.problem.plant.residual_loads[0].power_w = [0];
  c.problem.economics.terminal = [{
    id: "closing",
    store_id: "battery",
    model_id: "explicit-terminal",
    coverage_from: c.problem.intervals[0].end,
    event_ids: [],
    curve: {
      unit: "kwh",
      points: [{ at: 1, sek_per_unit: 10 }, { at: 2, sek_per_unit: 0 }],
    },
  }];
  c.alternatives[1] = {
    id: "charge",
    current: { actions: [action(1000)], pv_curtail_w: [0] },
  };
  const a = compiled(c).alternatives.find((a) => a.id === "charge")!;
  assertAlmostEquals(a.current.total_sek, 0.25);
  assertEquals(a.current.terminal_sek, 0);
  assertAlmostEquals(a.future_delta.total_sek, -2.5);
  assertAlmostEquals(a.total_delta_sek, -2.25);
});

Deno.test("battery compiler forces all subintervals in the remaining quarter and owns boundary ramp in future", () => {
  const c = base(3);
  c.problem.identity.actuals_watermark = "2026-09-14T08:07:30Z";
  c.problem.intervals = [
    { start: "2026-09-14T08:07:30Z", end: "2026-09-14T08:10:00Z" },
    { start: "2026-09-14T08:10:00Z", end: "2026-09-14T08:15:00Z" },
    { start: "2026-09-14T08:15:00Z", end: "2026-09-14T08:30:00Z" },
  ];
  c.problem.economics.import_sek_per_kwh.fill(0);
  c.problem.economics.initial_import_w = 0;
  c.problem.economics.ramp_sek_per_kw = 1;
  c.alternatives[0].current = {
    actions: [action(), action()],
    pv_curtail_w: [0, 0],
  };
  c.alternatives[1].current = {
    actions: [action(0, 1000), action(0, 1000)],
    pv_curtail_w: [0, 0],
  };
  const r = compiled(c), d = r.alternatives.find((a) => a.id === "discharge")!;
  assertEquals(r.coverage.current_interval_count, 2);
  assertEquals(d.current.ramp_sek, 0);
  assertAlmostEquals(d.future_delta.ramp_sek, 0.5);
  c.alternatives[0].current.actions.pop();
  assertEquals(compileBatteryPolicy(c).status, "rejected");
});

Deno.test("battery compiler accepts equivalent supported UTC timestamp spellings", () => {
  const c = JSON.parse(JSON.stringify(fixture).replaceAll(".000Z", "Z"));
  assertEquals(compiled(c).ranking, ["hold", "discharge"]);
});

Deno.test("battery compiler handles curtailment and battery export as separate permissions", () => {
  const c = base(2), b = battery(c);
  c.alternatives = [c.alternatives[0]];
  b.available.fill(false);
  c.problem.plant.residual_loads[0].power_w = [0, 0];
  c.problem.plant.pv_w = [0, 2000];
  c.problem.economics.export_sek_per_kwh = [0, -2];
  c.problem.plant.grid.export_limit_w = 500;
  const r = compiled(c);
  assertEquals(r.alternatives[0].candidate.pv_curtail_w, [0, 2000]);
  c.search.pv_curtailment_fractions = [0];
  c.problem.economics.export_sek_per_kwh[1] = 2;
  assertEquals(compiled(c).alternatives[0].candidate.pv_curtail_w, [0, 1500]);
  b.available.fill(true);
  c.alternatives.push({
    id: "export",
    current: { actions: [action(0, 1000, 0, 1000)], pv_curtail_w: [0] },
  });
  c.problem.plant.grid.export_limit_w = 4000;
  assert(
    compiled(c).omitted.some((a) =>
      a.id === "export" && a.status === "current_infeasible"
    ),
  );
  b.export_allowed.fill(true);
  assert(compiled(c).alternatives.some((a) => a.id === "export"));
});

Deno.test("battery compiler does not invent a feasible reference or subtract infeasible scores", () => {
  const c = base();
  battery(c).state_kwh.initial = 0;
  c.reference_id = "discharge";
  const r = compileBatteryPolicy(c);
  assertEquals(r.status, "reference_unavailable");
  assert(!("alternatives" in r));
  assertEquals(selectBatteryPolicy(r, c.problem).status, "unavailable");
});

Deno.test("sparse goals admit reachable partial discharge required by the grid limit", () => {
  const c = base(2);
  c.problem.plant.grid.import_limit_w = 500;
  c.problem.plant.residual_loads[0].power_w = [0, 1000];
  battery(c).discharge_max_w = 600;
  c.alternatives = [c.alternatives[0]];
  c.search.energy_levels_kwh = [];
  const r = compiled(c);
  const feasible = createHouseholdScorer(c.problem).score(
    fullCandidate(c, [action(), action(0, 500)]),
  );
  assert(feasible.status === "scored");
  assert(r.alternatives[0].full.total_sek <= feasible.objective.total_sek);
  const selected = r.alternatives[0].candidate.actions[battery(c).id][1];
  assert(
    selected.kind === "battery" && selected.discharge_w >= 500 &&
      selected.discharge_w <= 600,
  );
});

Deno.test("battery compiler rejects unsupported scope, malformed coverage and oversized work", () => {
  for (
    const modify of [
      (c: Case) => {
        c.problem.plant.equipment.push(structuredClone(battery(c)));
      },
      (c: Case) => {
        c.alternatives[0].current.actions[0].charge_w = NaN;
      },
      (c: Case) => {
        c.reference_id = "absent";
      },
      (c: Case) => {
        c.search.energy_levels_kwh = [100];
      },
      (c: Case) => {
        c.search.max_interval_evaluations = 1;
      },
      (c: Case) => {
        c.problem.economics.import_sek_per_kwh.push(1);
      },
      (c: Case) => {
        c.problem.intervals[0].end = "2026-09-14T08:10:00Z";
        c.problem.intervals = [c.problem.intervals[0]];
      },
    ]
  ) {
    const c = base();
    modify(c);
    assertEquals(compileBatteryPolicy(c).status, "rejected");
  }
  const large = base();
  large.problem.identity.case_id = "x".repeat(2_000_001);
  const r = compileBatteryPolicy(large);
  assert(r.status === "rejected");
  assertEquals(r.reason, "work_limit_exceeded");
});

Deno.test("battery compiler is deterministic, owns input, and refuses changed anchor evidence", () => {
  const c = base(), saved = structuredClone(c), r = compiled(c);
  assertEquals(compiled(c), r);
  assertEquals(c, saved);
  c.alternatives.reverse();
  c.search.energy_levels_kwh.reverse();
  assertEquals(compiled(c), r);
  assertEquals(selectBatteryPolicy(r, c.problem).status, "selected");
  c.problem.plant.pv_w[0] += 1;
  assertEquals(selectBatteryPolicy(r, c.problem).status, "outside_coverage");
  assertEquals(r.coverage.problem.plant.pv_w[0], 0);
  for (
    const change of [
      (p: HouseholdProblem) => {
        p.identity.intent_revision = "changed";
      },
      (p: HouseholdProblem) => {
        p.economics.import_sek_per_kwh[0] += 0.01;
      },
      (p: HouseholdProblem) => {
        p.plant.residual_loads[0].power_w[0] += 1;
      },
    ]
  ) {
    const p = structuredClone(r.coverage.problem);
    change(p);
    assertEquals(selectBatteryPolicy(r, p).status, "outside_coverage");
  }
});

Deno.test("battery compiler beats or matches independent coarse power enumeration on small ideal cases", () => {
  let seed = 1729;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let trial = 0; trial < 20; trial++) {
    const c = base(4), b = battery(c);
    b.grid_charge_allowed.fill(true);
    c.problem.economics.import_sek_per_kwh = Array.from(
      { length: 4 },
      () => Math.floor(random() * 8) - 2,
    );
    c.problem.economics.ramp_sek_per_kw = random();
    c.problem.economics.shaping_sek_per_kwh_per_kw = random();
    c.problem.economics.initial_import_w = 1000;
    b.wear_sek_per_kwh = random() * 0.1;
    const r = compiled(c), score = createHouseholdScorer(c.problem).score;
    for (const alternative of r.alternatives) {
      let best = Infinity;
      for (const a of [-1000, 0, 1000]) {
        for (const d of [-1000, 0, 1000]) {
          for (const e of [-1000, 0, 1000]) {
            const suffix = [a, d, e].map((w) =>
              w > 0 ? action(w) : action(0, -w)
            );
            const first = c.alternatives.find((a) =>
              a.id === alternative.id
            )!.current.actions;
            const s = score(fullCandidate(c, [...first, ...suffix]));
            if (s.status === "scored") {
              best = Math.min(best, s.objective.total_sek);
            }
          }
        }
      }
      assert(alternative.full.total_sek <= best + 1e-9);
      assertEquals(
        alternative.search.exhaustive_in_declared_graph,
        alternative.search.pruned_prefixes === 0,
      );
    }
  }
});

Deno.test("battery compiler labels pruned search explicitly and respects its work estimate", () => {
  const c = base(5);
  battery(c).grid_charge_allowed.fill(true);
  c.problem.plant.pv_w.fill(500);
  c.search.retained_per_level = 1;
  c.problem.economics.ramp_sek_per_kw = 0.25;
  const r = compiled(c);
  assert(r.alternatives.some((a) => a.search.pruned_prefixes > 0));
  assertEquals(r.coverage.optimality, "unproven_after_pruning");
  assertEquals(r.coverage.approximation_error_bound_sek, null);
  assert(
    r.work.interval_evaluations <= r.work.interval_evaluations_upper_bound,
  );
  c.search.retained_per_level = 8;
  const wider = compiled(c);
  for (const a of wider.alternatives) {
    const narrow = r.alternatives.find((x) => x.id === a.id)!;
    // This case's measured refinement result, not a general beam monotonicity claim.
    assert(a.full.total_sek <= narrow.full.total_sek + 1e-9);
  }
});

Deno.test("battery compiler bounds terminal curve complexity before suffix search", () => {
  const c = base();
  c.problem.economics.terminal = [{
    id: "oversize",
    store_id: "battery",
    coverage_from: c.problem.intervals.at(-1)!.end,
    model_id: "synthetic",
    event_ids: [],
    curve: {
      unit: "kwh",
      points: Array.from(
        { length: 579 },
        (_, i) => ({ at: i + 1, sek_per_unit: 579 - i }),
      ),
    },
  }];
  assertEquals(compileBatteryPolicy(c).status, "rejected");
});

Deno.test("full-horizon search work grows with added intervals rather than rescoring every prefix", () => {
  const run = (n: number) => {
    const c = base(n);
    c.search.energy_levels_kwh = [];
    c.search.retained_per_level = 2;
    c.search.pv_curtailment_fractions = [0];
    c.search.max_interval_evaluations = 500000;
    const result = compileBatteryPolicy(c);
    assert(result.status === "compiled", JSON.stringify(result));
    assert(
      result.work.interval_evaluations <=
        result.work.interval_evaluations_upper_bound,
    );
    return result.work;
  };
  const quarter = run(72), half = run(144), full = run(288);
  assertEquals(
    full.interval_evaluations_upper_bound -
      half.interval_evaluations_upper_bound,
    2 *
      (half.interval_evaluations_upper_bound -
        quarter.interval_evaluations_upper_bound),
  );
  assert(full.interval_evaluations_upper_bound < 500000);
});

for (const constrained of [false, true]) {
  Deno.test(`sparse search retains cheap early charge until expensive demand (headroom constrained: ${constrained})`, () => {
    const c = base(6), b = battery(c);
    b.state_kwh = { ...b.state_kwh, min: 0, max: 10, initial: 0 };
    b.charge_max_w = b.discharge_max_w = 4000;
    b.charge_efficiency = b.discharge_efficiency = 1;
    b.wear_sek_per_kwh = 0;
    b.grid_charge_allowed.fill(true);
    c.problem.plant.grid.import_limit_w = 4000;
    c.problem.plant.residual_loads[0].power_w = constrained
      ? [0, 0, 0, 3600, 0, 4000]
      : [0, 0, 0, 0, 0, 4000];
    c.problem.economics.import_sek_per_kwh = constrained
      ? [1, .1, 20, .01, 20, 10]
      : [1, .1, 2, 2, 2, 10];
    c.problem.economics.terminal = [];
    c.problem.economics.ramp_sek_per_kw =
      c.problem.economics
        .shaping_sek_per_kwh_per_kw =
        0;
    c.alternatives = [{
      id: "hold",
      current: { actions: [action()], pv_curtail_w: [0] },
    }];
    c.reference_id = "hold";
    c.search.energy_levels_kwh = [];
    c.search.retained_per_level = 2;
    const r = compiled(c), selected = r.alternatives[0];
    const known = createHouseholdScorer(c.problem).score(
      fullCandidate(c, [
        action(),
        action(4000),
        action(),
        action(),
        action(),
        action(0, 4000),
      ]),
    );
    assert(known.status === "scored");
    assertAlmostEquals(known.objective.total_sek, constrained ? .109 : .1);
    assert(
      selected.full.total_sek <= known.objective.total_sek + 1e-9,
      JSON.stringify(selected),
    );
    const actions = selected.candidate.actions[b.id];
    assert(actions[1].kind === "battery" && actions[1].charge_w > 0);
    assert(actions[5].kind === "battery" && actions[5].discharge_w > 0);
  });
}
