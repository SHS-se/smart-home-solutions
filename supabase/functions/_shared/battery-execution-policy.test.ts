import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  executionContinuationVectors,
  executionCurrentVectors,
  executionFixtureRequest,
} from "../../../scripts/generate-battery-execution-fixtures.ts";
import {
  BATTERY_EXECUTION_LIMITS,
  batteryExecutionPolicySchema,
  type BatteryExecutionRequest,
  compileBatteryExecutionPolicy,
  evaluateExecutionContinuation,
  evaluateExecutionCurrent,
  type ExecutionCell,
  executionFutureProblem,
} from "./battery-execution-policy.ts";
import { compileBatteryPolicy } from "./battery-policy.ts";
import { type HouseholdCandidate } from "./household-case.ts";
import {
  createHouseholdScorer,
  emptyObjective,
  type Objective,
  reconcileObjective,
  scoreElectricityInterval,
} from "./household-score.ts";
import { totalUtility } from "./store-value.ts";

function compiled(request = executionFixtureRequest()) {
  const result = compileBatteryExecutionPolicy(request);
  assert(result.status === "compiled", JSON.stringify(result));
  return result.policy;
}
function battery(request: BatteryExecutionRequest) {
  const b = request.problem.plant.equipment[0];
  assert(b.kind === "battery");
  return b;
}
function assertObjective(actual: Objective, expected: Objective) {
  for (const key of Object.keys(expected) as (keyof Objective)[]) {
    assertAlmostEquals(actual[key], expected[key], 1e-7, key);
  }
}
function cellObjective(cell: ExecutionCell, energy: number, previous: number) {
  const objective = emptyObjective();
  for (const key of Object.keys(cell.cost) as (keyof ExecutionCell["cost"])[]) {
    const c = cell.cost[key], [constant, linear, quadratic] = c.polynomial;
    objective[key] = constant + linear * energy + quadratic * energy * energy +
      c.absolute_terms.reduce(
        (sum, t) =>
          sum +
          t.weight *
            Math.abs(
              t.energy * energy + t.previous_import * previous + t.constant,
            ),
        0,
      );
  }
  return reconcileObjective(objective);
}
const hold = {
  kind: "battery" as const,
  charge_w: 0,
  discharge_w: 0,
  solar_charge_w: 0,
  export_w: 0,
};
function witnesses(request: BatteryExecutionRequest) {
  const b = battery(request);
  const anchors = [
    ...new Set([
      b.state_kwh.min,
      b.state_kwh.max,
      b.state_kwh.initial,
      ...request.search.energy_levels_kwh,
    ]),
  ].sort((a, b) => a - b);
  return new Map<string, { anchor: number; candidate: HouseholdCandidate }>(
    anchors.flatMap((anchor, i) => {
      const future = executionFutureProblem(request.problem, anchor);
      const result = compileBatteryPolicy({
        problem: future,
        reference_id: "hold",
        alternatives: [{
          id: "hold",
          current: { actions: [hold], pv_curtail_w: [0] },
        }],
        search: { ...request.search, pv_curtailment_fractions: [0] },
      });
      if (result.status !== "compiled") return [];
      return [[`anchor-${i}`, {
        anchor,
        candidate: result.alternatives[0].candidate,
      }]] as const;
    }),
  );
}

Deno.test("execution wire is closed, bounded, deterministic, and honestly reports unmeasured regret", () => {
  const p = compiled();
  assertEquals(compiled(), p);
  assertEquals(p.schema, "battery-execution-policy-v2");
  assertEquals(p.quality.scorer_revision, "offline-household-v2");
  assertEquals(p.quality.compiler_revision, "execution-v2");
  assertEquals(p.quality.heldout_count, 0);
  assertEquals(p.quality.heldout_max_regret_sek, null);
  assertEquals(p.quality.certified_regret_bound_sek, null);
  assert(
    new TextEncoder().encode(JSON.stringify(p)).length <=
      BATTERY_EXECUTION_LIMITS.policy_bytes,
  );
  assert(p.continuation.cells.length <= 64);
  for (
    const malformed of [
      { ...p, unknown: true },
      { ...p, identity: { ...p.identity, unknown: true } },
      { ...p, plant: { ...p.plant, cutoff_kwh: p.plant.capacity_kwh } },
      { ...p, operations: [...p.operations, p.operations[0]] },
      {
        ...p,
        quality: { ...p.quality, scorer_revision: "household-scorer-v1" },
      },
      { ...p, quality: { ...p.quality, assurance: "certified-optimum" } },
      {
        ...p,
        continuation: {
          ...p.continuation,
          coordinate_order: ["previous_import_w", "energy_kwh"],
        },
      },
      {
        ...p,
        continuation: {
          ...p.continuation,
          cells: Array(65).fill(p.continuation.cells[0]),
        },
      },
    ]
  ) assert(!batteryExecutionPolicySchema.safeParse(malformed).success);
});

for (const wearBasis of ["ac_throughput", "discharged_storage"] as const) {
Deno.test(`every bridge/suffix cross-scores at endpoints and interiors with ${wearBasis} wear`, () => {
  const r = executionFixtureRequest(), b = battery(r);
  b.wear_basis = wearBasis;
  const p = compiled(r), paths = witnesses(r);
  let seed = 721;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  let count = 0;
  for (
    const cell of p.continuation.cells.filter((c) => c.witness_id !== "idle")
  ) {
    const witness = paths.get(cell.witness_id)!;
    assert(witness);
    assert(witness.candidate.pv_curtail_w.every((w) => w === 0));
    const [lo, hi] = cell.domain.energy_kwh;
    for (
      const energy of [
        lo,
        hi,
        ...Array.from({ length: 16 }, () => lo + random() * (hi - lo)),
      ]
    ) {
      for (
        const previous of [
          0,
          p.plant.import_limit_w,
          random() * p.plant.import_limit_w,
        ]
      ) {
        const future = executionFutureProblem(r.problem, energy);
        future.economics.initial_import_w = previous;
        const candidate: HouseholdCandidate = structuredClone(
          witness.candidate,
        );
        const delta = witness.anchor - energy;
        const charge = Math.max(delta, 0) / b.charge_efficiency / 0.25 * 1000;
        const discharge = Math.max(-delta, 0) * b.discharge_efficiency / 0.25 *
          1000;
        const load = future.plant.residual_loads.reduce(
          (sum, l) => sum + l.power_w[0],
          0,
        );
        candidate.actions[b.id][0] = {
          kind: "battery",
          charge_w: charge,
          discharge_w: discharge,
          solar_charge_w: Math.min(charge, future.plant.pv_w[0]),
          export_w: Math.max(0, discharge - load),
        };
        const score = createHouseholdScorer(future).score(candidate);
        assert(
          score.status === "scored",
          JSON.stringify({ cell: cell.id, energy, score }),
        );
        assertObjective(cellObjective(cell, energy, previous), score.objective);
        const selected = evaluateExecutionContinuation(p, energy, previous);
        assert(
          selected &&
            selected.objective.total_sek <= score.objective.total_sek + 1e-7,
        );
        count++;
      }
    }
  }
  assert(count >= 500);
});

}

Deno.test("terminal utility remains exact with no future, and with bridge but no fixed suffix", () => {
  for (const n of [1, 2]) {
    const r = executionFixtureRequest(n), p = compiled(r);
    if (n === 1) {
      for (const energy of [1, 1.5, 3.999, 4, 4.001, 7.324, 10]) {
        const response = evaluateExecutionContinuation(p, energy, 3210);
        assert(response);
        assertAlmostEquals(
          response.objective.terminal_sek,
          totalUtility(r.problem.economics.terminal[0].curve, energy),
        );
        assertAlmostEquals(
          response.objective.total_sek,
          -response.objective.terminal_sek,
        );
      }
    } else {
      const paths = witnesses(r);
      for (
        const cell of p.continuation.cells.filter((c) =>
          c.witness_id !== "idle"
        )
      ) {
        const anchor = paths.get(cell.witness_id)!.anchor;
        assertAlmostEquals(
          cell.cost.terminal_sek.polynomial[0],
          totalUtility(r.problem.economics.terminal[0].curve, anchor),
        );
        assertEquals(cell.cost.ramp_sek.absolute_terms.length, 1);
      }
    }
  }
  const empty = executionFixtureRequest(1);
  empty.problem.economics.terminal = [];
  assertEquals(
    evaluateExecutionContinuation(compiled(empty), 5, 1000)!.objective,
    emptyObjective(),
  );
});

Deno.test("current semantics, real EV demand, elapsed time, native envelope and reserve guards", () => {
  const p = compiled(),
    frame = {
      at_ms: p.validity.from_ms,
      energy_kwh: 5,
      pv_w: 1000,
      residual_load_w: 8000,
      previous_import_w: 7000,
    };
  const evaluate = (id: string, changes = {}) =>
    evaluateExecutionCurrent(p, p.operations.find((o) => o.id === id)!, {
      ...frame,
      ...changes,
    });
  const house = evaluate("house"),
    charge = evaluate("charge"),
    solar = evaluate("solar"),
    exporting = evaluate("export");
  assert(
    house.eligible && charge.eligible && solar.eligible && exporting.eligible,
  );
  assertEquals(house.terminal_import_w, 4000);
  assertEquals(solar.terminal_import_w, 7000);
  assertEquals(charge.terminal_import_w, 10000);
  assertEquals(exporting.terminal_import_w, 5000); // Total discharge, even when none reaches grid.
  assertEquals([house.possible_import_w, house.possible_export_w], [0, 0]);
  assertEquals([charge.possible_import_w, charge.possible_export_w], [3000, 0]);
  assertEquals([exporting.possible_import_w, exporting.possible_export_w], [
    0,
    2000,
  ]);
  assert(charge.current.import_sek < 0);
  const late = evaluate("charge", { at_ms: frame.at_ms + 300000 });
  assert(late.eligible && late.energy_end_kwh < charge.energy_end_kwh);
  assertEquals(evaluate("export", { energy_kwh: 3 }), {
    eligible: false,
    reason: "export_reserve",
  });
  assertEquals(evaluate("export", { energy_kwh: 3.1 }), {
    eligible: false,
    reason: "export_reserve_crossing",
  });
  assert(evaluate("house", { energy_kwh: 3.1 }).eligible);
  assertEquals(evaluate("hold", { at_ms: p.validity.until_ms }), {
    eligible: false,
    reason: "outside_validity",
  });
  const surplus = evaluate("solar", { pv_w: 6000, residual_load_w: 1500 });
  assert(surplus.eligible);
  assertEquals(surplus.terminal_import_w, 0);
  assertAlmostEquals(surplus.energy_end_kwh, 5 + 3 * 0.2 * 0.95);
});

Deno.test("current saturation uses fractional HOURS with only positive segments and exact ramp", () => {
  const p = compiled(), energy = 9.9991234567;
  const conditions = {
    at_ms: p.validity.from_ms,
    energy_kwh: energy,
    pv_w: 0,
    residual_load_w: 1000,
    previous_import_w: 0,
  };
  const op = p.operations.find((o) => o.id === "charge")!;
  const response = evaluateExecutionCurrent(p, op, conditions);
  assert(response.eligible);
  const active = (10 - energy) / (3 * 0.95),
    total = (p.validity.boundary_ms - conditions.at_ms) / 3600000;
  assert(Math.abs(active * 3600000 - Math.round(active * 3600000)) > 0.01);
  const first = scoreElectricityInterval({
    ...p.economics,
    hours: active,
    import_w: 4000,
    export_w: 0,
    previous_import_w: 0,
  });
  const second = scoreElectricityInterval({
    ...p.economics,
    hours: total - active,
    import_w: 1000,
    export_w: 0,
    previous_import_w: 4000,
  });
  const expected = emptyObjective();
  for (const key of Object.keys(expected) as (keyof Objective)[]) {
    expected[key] = first[key] + second[key];
  }
  expected.wear_sek = 3 * active * 0.1;
  assertObjective(response.current, reconcileObjective(expected));
  assertEquals(response.energy_end_kwh, 10);
  assertEquals(response.terminal_import_w, 1000);
  const full = evaluateExecutionCurrent(p, op, {
    ...conditions,
    energy_kwh: 10,
  });
  assert(full.eligible);
  assertAlmostEquals(full.current.ramp_sek, 0.07); // No zero-duration 4kW segment/ramp.
});

Deno.test("current checks post-saturation grid limits and native permissions independently", () => {
  const r = executionFixtureRequest(1),
    p = compiled(r),
    frame = {
      at_ms: p.validity.from_ms,
      energy_kwh: 9.999,
      pv_w: 12000,
      residual_load_w: 0,
      previous_import_w: 0,
    };
  assertEquals(
    evaluateExecutionCurrent(
      p,
      p.operations.find((o) => o.id === "solar")!,
      frame,
    ),
    { eligible: false, reason: "grid_limit" },
  );
  r.permissions.grid_charge_allowed =
    r.permissions.battery_export_allowed =
      false;
  battery(r).grid_charge_allowed.fill(false);
  battery(r).export_allowed.fill(false);
  const denied = compiled(r),
    c = { ...frame, pv_w: 5000, residual_load_w: 3000, energy_kwh: 5 };
  assertEquals(
    evaluateExecutionCurrent(
      denied,
      denied.operations.find((o) => o.id === "charge")!,
      c,
    ),
    { eligible: false, reason: "grid_charge_not_allowed" },
  );
  assertEquals(
    evaluateExecutionCurrent(
      denied,
      denied.operations.find((o) => o.id === "export")!,
      c,
    ),
    { eligible: false, reason: "battery_export_not_allowed" },
  );
  const solar = evaluateExecutionCurrent(
    denied,
    denied.operations.find((o) => o.id === "solar")!,
    c,
  );
  assert(solar.eligible);
  assertAlmostEquals(solar.energy_end_kwh, 5 + 2 * 0.2 * 0.95);
  p.permissions.export_price_eligible = false;
  assertEquals(
    evaluateExecutionCurrent(
      p,
      p.operations.find((o) => o.id === "export")!,
      c,
    ),
    { eligible: false, reason: "export_price_ineligible" },
  );
});

Deno.test("native source permissions narrow bridge domains while the idle family covers unchanged energy", () => {
  const r = executionFixtureRequest(2), b = battery(r);
  r.permissions.grid_charge_allowed =
    r.permissions.battery_export_allowed =
      false;
  b.grid_charge_allowed.fill(false);
  b.export_allowed.fill(false);
  r.problem.plant.pv_w[1] = 3000;
  r.problem.plant.residual_loads[0].power_w[1] = 2000;
  r.problem.plant.residual_loads[1].power_w[1] = 0;
  const p = compiled(r), paths = witnesses(r);
  for (
    const cell of p.continuation.cells.filter((c) => c.witness_id !== "idle")
  ) {
    const anchor = paths.get(cell.witness_id)!.anchor;
    for (const e of cell.domain.energy_kwh as number[]) {
      const charge = Math.max(0, anchor - e) / 0.25 / 0.95 * 1000;
      const discharge = Math.max(0, e - anchor) / 0.25 * 0.9 * 1000;
      assert(charge <= 1000 + 1e-7); // PV minus load, not PV attribution alone.
      assert(discharge <= 1e-7); // No discharge into existing PV surplus.
    }
  }
  assertEquals(evaluateExecutionContinuation(p, 2, 0)?.witness_id, "idle");
});

Deno.test("filter native-invalid optimized suffixes and ALL minimum-curtailment witnesses", () => {
  const r = executionFixtureRequest(3), b = battery(r);
  r.problem.plant.pv_w[2] = 20000;
  r.future_supply_bound_w[2] = 0;
  r.problem.plant.residual_loads[0].power_w[2] = 0;
  r.problem.plant.residual_loads[1].power_w[2] = 0;
  const raw = compileBatteryPolicy({
    problem: executionFutureProblem(r.problem, 5),
    reference_id: "hold",
    alternatives: [{
      id: "hold",
      current: { actions: [hold], pv_curtail_w: [0] },
    }],
    search: { ...r.search, pv_curtailment_fractions: [0] },
  });
  assert(raw.status === "compiled");
  assert(raw.alternatives[0].candidate.pv_curtail_w.some((w) => w > 0));
  assertEquals(compileBatteryExecutionPolicy(r), {
    status: "rejected",
    reason: "no_native_feasible_continuation",
  });
  r.problem.plant.pv_w[2] = 3000;
  r.problem.plant.residual_loads[0].power_w[2] = 3000;
  r.problem.economics.import_sek_per_kwh[2] = -100;
  r.permissions.grid_charge_allowed = false;
  b.grid_charge_allowed.fill(false);
  const p = compiled(r), paths = witnesses(r);
  for (
    const cell of p.continuation.cells.filter((c) => c.witness_id !== "idle")
  ) {
    const last = paths.get(cell.witness_id)!.candidate.actions[b.id][1];
    assert(last.kind === "battery");
    assertEquals(last.charge_w, 0); // Imposed scorer permits PV-first source allocation here; native model does not.
  }
});

Deno.test("projection requires real external demand, exact participant sets and durable revisions", () => {
  const r = executionFixtureRequest();
  const variants: unknown[] = [
    { ...r, projection: { ...r.projection, view: "conditional" } },
    {
      ...r,
      projection: {
        ...r.projection,
        participants: [
          { id: "base", basis: "hypothetical" },
          r.projection.participants[1],
        ],
      },
    },
    {
      ...r,
      projection: { ...r.projection, configured_participant_ids: ["base"] },
    },
    {
      ...r,
      projection: {
        ...r.projection,
        participants: [
          r.projection.participants[0],
          r.projection.participants[0],
        ],
      },
    },
    { ...r, projection: { ...r.projection, scope_revision: "stale" } },
    {
      ...r,
      projection: { ...r.projection, external_scenario_revision: "stale" },
    },
    { ...r, identity: { ...r.identity, battery_id: "another" } },
    {
      ...r,
      identity: { ...r.identity, response_model_revision: "grid-first" },
    },
    {
      ...r,
      operations: [{
        id: "bad",
        operation: "grid_first",
        charge_limit_w: 1000,
        discharge_limit_w: 0,
      }],
    },
  ];
  for (const variant of variants) {
    assertEquals(compileBatteryExecutionPolicy(variant).status, "rejected");
  }
});

Deno.test("reject subdivisions, aggregate work and AFTER-split bounds without truncation", () => {
  const r = executionFixtureRequest();
  r.search.max_interval_evaluations = 10;
  assertEquals(compileBatteryExecutionPolicy(r).status, "rejected");
  const excessive = executionFixtureRequest(288);
  excessive.search.max_interval_evaluations = 40_000_000;
  assertEquals(compileBatteryExecutionPolicy(excessive).status, "rejected");
  const subdivided = executionFixtureRequest();
  subdivided.problem.intervals[0].end = new Date(
    Date.parse(subdivided.problem.intervals[0].end) - 1000,
  ).toISOString();
  assertEquals(compileBatteryExecutionPolicy(subdivided).status, "rejected");
  const crowded = executionFixtureRequest(1);
  crowded.problem.economics.terminal[0].curve.points = Array.from({
    length: 64,
  }, (_, i) => ({ at: 1.1 + i * 8.8 / 63, sek_per_unit: 1 - i / 64 }));
  assertEquals(compileBatteryExecutionPolicy(crowded), {
    status: "rejected",
    reason: "after_split_cell_limit",
  });
  const tooManyOperations = executionFixtureRequest(1);
  tooManyOperations.operations = Array.from(
    { length: 13 },
    (_, i) => ({ ...tooManyOperations.operations[0], id: `hold-${i}` }),
  );
  assertEquals(
    compileBatteryExecutionPolicy(tooManyOperations).status,
    "rejected",
  );
});

Deno.test("generated cross-language fixtures are reproducible inner-wire artifacts", () => {
  const folder = new URL(
    "../../../docs/energy-optimisation/fixtures/battery-execution/",
    import.meta.url,
  );
  const generated = executionCurrentVectors();
  assertEquals(
    Deno.readTextFileSync(new URL("policy.json", folder)),
    JSON.stringify(generated.policy, null, 2) + "\n",
  );
  assertEquals(
    Deno.readTextFileSync(new URL("current-vectors.json", folder)),
    JSON.stringify(generated, null, 2) + "\n",
  );
  assertEquals(
    Deno.readTextFileSync(new URL("continuation-vectors.json", folder)),
    JSON.stringify(executionContinuationVectors(), null, 2) + "\n",
  );
  const native = executionFixtureRequest(1);
  native.permissions.grid_charge_allowed =
    native.permissions
      .battery_export_allowed =
      false;
  battery(native).grid_charge_allowed.fill(false);
  battery(native).export_allowed.fill(false);
  assertEquals(
    Deno.readTextFileSync(
      new URL("native-permissions-current-vectors.json", folder),
    ),
    JSON.stringify(executionCurrentVectors(native), null, 2) + "\n",
  );
});

Deno.test("forced-export bridge domains protect reserve; house supply may cross it", () => {
  const r = executionFixtureRequest(2), b = battery(r);
  r.problem.plant.pv_w[1] = 0;
  r.problem.plant.residual_loads[0].power_w[1] = 200;
  r.future_supply_bound_w[1] = 200;
  r.problem.plant.residual_loads[1].power_w[1] = 0;
  const p = compiled(r), paths = witnesses(r);
  let forced = 0, houseBelowReserve = 0;
  for (
    const cell of p.continuation.cells.filter((c) => c.witness_id !== "idle")
  ) {
    const anchor = paths.get(cell.witness_id)!.anchor;
    const [lo, hi] = cell.domain.energy_kwh;
    for (const e of [lo, hi, (lo + hi) / 2]) {
      const discharge = Math.max(0, e - anchor) / 0.25 *
        b.discharge_efficiency * 1000;
      if (discharge > 200 + 1e-7) {
        assert(anchor >= r.permissions.export_reserve_kwh);
        assert(e > r.permissions.export_reserve_kwh);
        forced++;
      } else if (discharge > 0 && anchor < r.permissions.export_reserve_kwh) {
        houseBelowReserve++;
      }
    }
  }
  assert(forced > 0 && houseBelowReserve > 0);
  // Current ineligibility must not remove a separately eligible future export.
  r.permissions.export_price_eligible = false;
  assertEquals(compiled(r).continuation, p.continuation);
  b.export_allowed[1] = false;
  const ineligible = compiled(r);
  for (
    const cell of ineligible.continuation.cells.filter((c) =>
      c.witness_id !== "idle"
    )
  ) {
    const anchor = paths.get(cell.witness_id)!.anchor;
    assert(
      (cell.domain.energy_kwh[1] - anchor) / 0.25 * b.discharge_efficiency *
          1000 <= 200 + 1e-7,
    );
  }
});

Deno.test("maximum 64 AFTER-split cells and 12 operations compile; larger byte payload rejects", () => {
  const r = executionFixtureRequest(1);
  r.search.max_interval_evaluations = 40_000_000;
  r.problem.economics.terminal[0].curve.points = Array.from(
    { length: 63 },
    (_, i) => ({ at: 1.1 + i * 8.8 / 62, sek_per_unit: 1 - i / 64 }),
  );
  r.operations.push(
    ...Array.from(
      { length: 6 },
      (_, i) => ({
        ...r.operations[4],
        id: `charge-extra-${i}`,
        charge_limit_w: 100 + i * 100,
      }),
    ),
  );
  const p = compiled(r);
  assertEquals(p.operations.length, 12);
  assertEquals(p.continuation.cells.length, 64);
  const large = structuredClone(p);
  const wideNumber = Number("1.1234567890123456e100");
  for (const [i, cell] of large.continuation.cells.entries()) {
    cell.id = `${i}-` + "x".repeat(120);
    cell.witness_id = "w".repeat(128);
    cell.domain.inequalities = Array.from(
      { length: 8 },
      () => ({
        energy: wideNumber,
        previous_import: wideNumber,
        maximum: 1.1234567890123456e110,
      }),
    );
    for (const cost of Object.values(cell.cost)) {
      cost.polynomial = [
        wideNumber,
        wideNumber,
        wideNumber,
      ];
    }
    cell.cost.ramp_sek.absolute_terms = Array.from(
      { length: 2 },
      () => ({
        weight: wideNumber,
        energy: wideNumber,
        previous_import: wideNumber,
        constant: wideNumber,
      }),
    );
  }
  assert(
    new TextEncoder().encode(JSON.stringify(large)).length >
      BATTERY_EXECUTION_LIMITS.policy_bytes,
  );
  assert(!batteryExecutionPolicySchema.safeParse(large).success);
});

Deno.test("terminal curve below first and above last knee remains exact", () => {
  const r = executionFixtureRequest(1);
  r.problem.economics.terminal[0].curve.points = [{ at: 2, sek_per_unit: 1 }, {
    at: 4,
    sek_per_unit: 0.5,
  }, { at: 6, sek_per_unit: 0 }];
  const p = compiled(r);
  for (const e of [1, 1.4, 2, 2.789, 4, 5.21, 6, 7.99, 10]) {
    const c = evaluateExecutionContinuation(p, e, 0);
    assert(c);
    assertAlmostEquals(
      c.objective.terminal_sek,
      totalUtility(r.problem.economics.terminal[0].curve, e),
    );
  }
});

Deno.test("malformed non-JSON requests reject explicitly and stable cell IDs break exact ties", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  for (
    const input of [undefined, null, [], 1n, circular, {
      ...executionFixtureRequest(),
      unknown: true,
    }]
  ) {
    assertEquals(compileBatteryExecutionPolicy(input).status, "rejected");
  }
  const p = compiled(executionFixtureRequest(1));
  const cell = structuredClone(p.continuation.cells[0]);
  cell.id = "z-last";
  const first = { ...structuredClone(cell), id: "a-first" };
  p.continuation.cells = [cell, first];
  assertEquals(
    evaluateExecutionContinuation(p, cell.domain.energy_kwh[0], 0)!.cell_id,
    "a-first",
  );
  assertEquals(evaluateExecutionContinuation(p, NaN, 0), null);
});

Deno.test("idle future is scored across continuous energy including sparse-anchor coverage gaps", () => {
  const r = executionFixtureRequest(), b = battery(r), p = compiled(r);
  const cells = p.continuation.cells.filter((c) => c.witness_id === "idle");
  assert(cells.length > 0);
  assertEquals(evaluateExecutionContinuation(p, 1.01, 0)?.witness_id, "idle");
  for (const cell of cells) {
    const [lo, hi] = cell.domain.energy_kwh;
    for (const energy of [lo, (lo + hi) / 2, hi]) {
      for (const previous of [0, 7213, p.plant.import_limit_w]) {
        const future = executionFutureProblem(r.problem, energy);
        future.economics.initial_import_w = previous;
        const candidate: HouseholdCandidate = {
          id: "idle-oracle",
          pv_curtail_w: future.intervals.map(() => 0),
          actions: {
            [b.id]: future.intervals.map(() => hold),
          },
        };
        const score = createHouseholdScorer(future).score(candidate);
        assert(score.status === "scored");
        assertObjective(cellObjective(cell, energy, previous), score.objective);
      }
    }
  }
});

Deno.test("bridge suffix seeding handles solar above export capacity without curtailment", () => {
  const r = executionFixtureRequest(2), b = battery(r);
  r.problem.plant.pv_w[1] = 12000;
  r.problem.plant.residual_loads.forEach((l) => l.power_w[1] = 0);
  const p = compiled(r);
  assert(p.continuation.cells.every((c) => c.witness_id !== "idle"));
  const anchors = [
    ...new Set([
      b.state_kwh.min,
      b.state_kwh.max,
      b.state_kwh.initial,
      ...r.search.energy_levels_kwh,
    ]),
  ].sort((a, b) => a - b);
  for (const cell of p.continuation.cells) {
    const anchor = anchors[Number(cell.witness_id.split("-")[1])];
    const [lo, hi] = cell.domain.energy_kwh;
    for (const energy of [lo, (lo + hi) / 2, hi]) {
      const future = executionFutureProblem(r.problem, energy);
      future.economics.initial_import_w = 3123;
      const charge = (anchor - energy) / b.charge_efficiency / 0.25 * 1000;
      assert(charge >= 2000 - 1e-7);
      const candidate: HouseholdCandidate = {
        id: "solar-bridge-oracle",
        pv_curtail_w: [0],
        actions: {
          [b.id]: [{ ...hold, charge_w: charge, solar_charge_w: charge }],
        },
      };
      const score = createHouseholdScorer(future).score(candidate);
      assert(score.status === "scored", JSON.stringify(score));
      assertObjective(cellObjective(cell, energy, 3123), score.objective);
    }
  }
  assert(evaluateExecutionContinuation(p, 4.5, 0));
  assertEquals(evaluateExecutionContinuation(p, 10, 0), null);
});

Deno.test("wire rejects semantic duplicates, zero ceilings and inconsistent quality; historical import remains valid", () => {
  const p = compiled();
  assertEquals(BATTERY_EXECUTION_LIMITS.policy_bytes, 128000);
  for (
    const malformed of [
      {
        ...p,
        operations: [...p.operations, {
          ...p.operations[0],
          id: "second-hold",
        }],
      },
      ...["solar", "house"].map((id) => ({
        ...p,
        operations: p.operations.map((o) =>
          o.id === id ? { ...o, charge_limit_w: 0, discharge_limit_w: 0 } : o
        ),
      })),
      { ...p, quality: { ...p.quality, numeric_tolerance_sek: 0.01 } },
      {
        ...p,
        quality: {
          ...p.quality,
          search_exhaustive_in_declared_graph: true,
          search_pruned_prefixes: 1,
        },
      },
      {
        ...p,
        quality: {
          ...p.quality,
          search_exhaustive_in_declared_graph: false,
          search_pruned_prefixes: 0,
        },
      },
    ]
  ) assert(!batteryExecutionPolicySchema.safeParse(malformed).success);
  const response = evaluateExecutionCurrent(p, p.operations[0], {
    at_ms: p.validity.from_ms,
    energy_kwh: 5,
    pv_w: 0,
    residual_load_w: 1000,
    previous_import_w: 25000,
  });
  assert(response.eligible);
  assertAlmostEquals(
    response.current.ramp_sek,
    24 * p.economics.ramp_sek_per_kw,
  );
});

Deno.test("continuation clips only numerical edge noise and resolves numerical ties by cell ID", () => {
  const p = compiled(executionFixtureRequest(1));
  const original = p.continuation.cells[0];
  const first = structuredClone(original), second = structuredClone(original);
  first.id = "a-first";
  second.id = "z-second";
  first.cost.import_sek.polynomial[0] += 5e-8;
  p.continuation.cells = [second, first];
  assertEquals(evaluateExecutionContinuation(p, 2, 0)?.cell_id, "a-first");
  assertObjective(
    evaluateExecutionContinuation(p, 1 - 5e-10, -5e-10)!.objective,
    evaluateExecutionContinuation(p, 1, 0)!.objective,
  );
  assertEquals(evaluateExecutionContinuation(p, 1 - 2e-9, 0), null);
  assertEquals(evaluateExecutionContinuation(p, 1, -2e-9), null);
  first.cost.import_sek.polynomial[0] = 2e-7;
  assertEquals(evaluateExecutionContinuation(p, 2, 0)?.cell_id, "z-second");
});

Deno.test("discharged-storage wear charges energy removed from storage, never charging throughput", () => {
  const r = executionFixtureRequest();
  const b = battery(r); b.wear_basis = "discharged_storage";
  for (const vector of executionCurrentVectors(r).cases) {
    if (vector.expected.eligible) {
      assertAlmostEquals(vector.expected.current.wear_sek,
        Math.max(0, vector.energy_kwh - vector.expected.energy_end_kwh) * b.wear_sek_per_kwh);
    }
  }
});

Deno.test("current grid-charge prohibition does not remove explicitly permitted future recovery", () => {
  const r = executionFixtureRequest(2), b = battery(r);
  b.grid_charge_allowed = [false, true];
  r.permissions.grid_charge_allowed = false;
  r.problem.economics.import_sek_per_kwh = [2.77, -1];
  r.problem.plant.pv_w = [0, 0];
  r.problem.plant.residual_loads[0].power_w = [2000, 2000];
  r.future_supply_bound_w = [2000, 2000];
  const p = compiled(r);
  const charge = p.operations.find(op => op.operation === "grid_charge");
  assert(charge);
  const current = evaluateExecutionCurrent(p, charge, {
    at_ms: p.validity.from_ms, energy_kwh: 5, pv_w: 0, residual_load_w: 2000, previous_import_w: 2000,
  });
  assertEquals(current, { eligible: false, reason: "grid_charge_not_allowed" });
  const permitted = evaluateExecutionContinuation(p, 4.5, 2000);
  b.grid_charge_allowed[1] = false;
  const prohibited = evaluateExecutionContinuation(compiled(r), 4.5, 2000);
  assert(permitted && prohibited);
  assert(permitted.objective.total_sek < prohibited.objective.total_sek);
});
