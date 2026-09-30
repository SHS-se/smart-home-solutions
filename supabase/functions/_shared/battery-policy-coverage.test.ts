import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  batteryPolicyRequestSchema,
  compileBatteryPolicy,
} from "./battery-policy.ts";
import { parseHouseholdProblem } from "./planner/household-case.ts";
import {
  compileBatteryPolicyCoverage,
  evaluateBatteryPolicyCoverage,
} from "./battery-policy-coverage.ts";

function fixture() {
  const source = batteryPolicyRequestSchema.parse(
    JSON.parse(Deno.readTextFileSync(
      new URL(
        "../../../docs/energy-optimisation/fixtures/battery-policy/negative-price-recovery.json",
        import.meta.url,
      ),
    )),
  );
  const problem = parseHouseholdProblem(source.problem);
  const start = Date.parse(problem.intervals[0].start);
  return {
    source: { ...source, problem },
    axes: { at_ms: [start, start + 300000], energy_kwh: [0, 0.01] },
    acceptance: { max_component_error_sek: 1e-7, max_ranking_regret_sek: 1e-7 },
  };
}
type Input = ReturnType<typeof fixture>;
function battery(input: Input) {
  const b = input.source.problem.plant.equipment[0];
  assert(b.kind === "battery");
  return b;
}
function point(input: Input, at_ms: number, energy: number) {
  const p = structuredClone(input.source.problem);
  const b = p.plant.equipment[0];
  assert(b.kind === "battery");
  b.state_kwh.initial = energy;
  p.intervals[0].start = new Date(at_ms).toISOString();
  p.identity.actuals_watermark = p.intervals[0].start;
  return p;
}
function compiled(input: Input) {
  const result = compileBatteryPolicyCoverage(input);
  assert(result.status === "compiled", JSON.stringify(result));
  return result;
}

Deno.test("coverage provides continuous time/state estimates with fresh held-out economic evidence", () => {
  const input = fixture(), result = compiled(input);
  assertEquals(result.cells.map((c) => c.status), ["accepted_empirical"]);
  assertEquals(result.samples.length, 9);
  assertEquals(result.cells[0].evidence.length, 5);
  assertEquals(result.execution, "diagnostic_only");
  assertEquals(result.certified_error_bound_sek, null);
  assertEquals(
    result.source.problem.identity.actuals_watermark,
    input.source.problem.identity.actuals_watermark,
  );
  assert(result.work.solver_calls <= result.work.max_solver_calls);
  // An unsampled point, not an anchor or a held-out midpoint.
  const p = point(input, input.axes.at_ms[0] + 123456, 0.00321);
  const estimate = evaluateBatteryPolicyCoverage(result, p);
  assert(estimate.status === "estimated");
  assertEquals(estimate.ranking[0], "charge");
  const exact = compileBatteryPolicy({ ...input.source, problem: p });
  assert(exact.status === "compiled");
  for (const v of estimate.values) {
    const solved = exact.alternatives.find((a) => a.id === v.id)!;
    assertAlmostEquals(v.total_delta_sek, solved.total_delta_sek, 1e-7);
    const ref = estimate.values.find((a) => a.id === estimate.reference_id)!;
    for (const key of Object.keys(v.current) as (keyof typeof v.current)[]) {
      assertAlmostEquals(
        v.current[key] - ref.current[key] + v.future_delta[key],
        v.full[key] - ref.full[key],
        1e-7,
      );
      assertEquals(ref.future_delta[key], 0);
    }
  }
  assertEquals(compiled(input), result);
});

Deno.test("coverage refuses extrapolation and all changed frozen conditions", () => {
  const input = fixture(), result = compiled(input);
  const p = point(input, input.axes.at_ms[0] + 100000, 0.005);
  const changes = [
    (q: typeof p) => {
      q.economics.initial_import_w = 123;
    },
    (q: typeof p) => {
      q.economics.import_sek_per_kwh[1] += 0.1;
    },
    (q: typeof p) => {
      q.plant.pv_w[1] += 1;
    },
    (q: typeof p) => {
      q.plant.residual_loads[0].power_w[0] += 1;
    },
    (q: typeof p) => {
      q.identity.model_revision = "new-model";
    },
    (q: typeof p) => {
      q.identity.intent_revision = "new-intent";
    },
    (q: typeof p) => {
      q.identity.actuals_watermark =
        input.source.problem.identity.actuals_watermark;
    },
    (q: typeof p) => {
      const b = q.plant.equipment[0];
      assert(b.kind === "battery");
      b.grid_charge_allowed[1] = false;
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(p);
    change(changed);
    assertEquals(
      evaluateBatteryPolicyCoverage(result, changed).status,
      "outside_coverage",
    );
  }
  for (
    const [time, energy] of [[input.axes.at_ms[0] + 300001, 0.005], [
      input.axes.at_ms[0],
      0.010001,
    ]]
  ) {
    assertEquals(
      evaluateBatteryPolicyCoverage(result, point(input, time, energy)).status,
      "outside_coverage",
    );
  }
});

Deno.test("coverage handles exact knots and shared cell edges deterministically", () => {
  const input = fixture();
  input.axes.at_ms.splice(1, 0, input.axes.at_ms[0] + 150000);
  input.axes.energy_kwh.splice(1, 0, 0.005);
  const result = compiled(input);
  assert(result.cells.every((c) => c.status === "accepted_empirical"));
  const r = evaluateBatteryPolicyCoverage(
    result,
    point(input, input.axes.at_ms[1], 0.005),
  );
  assert(r.status === "estimated");
  assertEquals(r.cell_id, "t0-e0");
  for (const t of input.axes.at_ms) {
    for (const e of input.axes.energy_kwh) {
      assertEquals(
        evaluateBatteryPolicyCoverage(result, point(input, t, e)).status,
        "estimated",
      );
    }
  }
});

Deno.test("SOC-crossing cells cannot omit a competitor or replace an infeasible reference", () => {
  for (const reference of ["hold", "charge"]) {
    const input = fixture();
    input.axes.energy_kwh = [0, 0.02];
    input.source.reference_id = reference;
    const result = compiled(input);
    assertEquals(result.cells[0].status, "excluded");
    assert(result.cells[0].reasons.includes("unavailable_corner"));
    assert(result.samples.some((s) => s.status === "unavailable"));
    assertEquals(
      evaluateBatteryPolicyCoverage(result, input.source.problem).status,
      "outside_coverage",
    );
  }
});

Deno.test("idle witness exclusion does not claim physical infeasibility", () => {
  const input = fixture();
  input.source.problem.plant.grid.import_limit_w = 500;
  input.source.problem.plant.residual_loads[0].power_w = [0, 600];
  input.source.alternatives = input.source.alternatives.filter((a) =>
    a.id === "hold"
  );
  input.axes.energy_kwh = [0.05, 0.06];
  const exact = compileBatteryPolicy({
    ...input.source,
    problem: point(input, input.axes.at_ms[0], 0.05),
  });
  assert(exact.status === "compiled" && exact.omitted.length === 0);
  const result = compiled(input);
  assertEquals(result.cells[0].reasons, ["idle_suffix_witness_failed"]);
  assert(result.samples.every((s) => s.status === "available"));
});

Deno.test("fixed suffix witness handles future PV overproduction with explicit curtailment", () => {
  const input = fixture();
  input.source.problem.plant.pv_w[1] = 9000;
  input.source.problem.plant.grid.export_limit_w = 500;
  input.acceptance.max_component_error_sek = 10;
  input.acceptance.max_ranking_regret_sek = 10;
  const result = compiled(input);
  assertEquals(result.cells[0].status, "accepted_empirical");
});

Deno.test("thermal models, multiple current intervals and unknown axes are rejected", () => {
  const input = fixture();
  assertEquals(
    compileBatteryPolicyCoverage({
      ...input,
      axes: { ...input.axes, pv_w: [0, 100] },
    }).status,
    "rejected",
  );
  input.source.problem.intervals[0].end = new Date(input.axes.at_ms[0] + 300000)
    .toISOString();
  assertEquals(compileBatteryPolicyCoverage(input).status, "rejected");
});

Deno.test("coverage rejects invalid or degenerate axes and preflights the aggregate work cap", () => {
  for (const times of [[0, 900000], [0, 1], [10, 0], [0, NaN]]) {
    const input = fixture();
    input.axes.at_ms = times.map((v) => input.axes.at_ms[0] + v);
    assertEquals(compileBatteryPolicyCoverage(input).status, "rejected");
  }
  for (const energy of [[0.01, 0], [0, 0], [-1, 0.01], [0, 0.3]]) {
    const input = fixture();
    input.axes.energy_kwh = energy;
    assertEquals(compileBatteryPolicyCoverage(input).status, "rejected");
  }
  const input = fixture();
  input.source.search.max_interval_evaluations = 40000000;
  const result = compileBatteryPolicyCoverage(input);
  assert(result.status === "rejected" && result.detail.includes("worst-case"));
});

Deno.test("terminal curve knees produce empirical error and excluded cells retain failing capsules", () => {
  const input = fixture();
  input.source.problem.economics.terminal = [{
    id: "closing",
    store_id: "battery",
    model_id: "terminal-v1",
    coverage_from: input.source.problem.intervals.at(-1)!.end,
    event_ids: [],
    curve: {
      unit: "kwh",
      points: [{ at: 0.15, sek_per_unit: 10 }, { at: 0.25, sek_per_unit: 0 }],
    },
  }];
  // Prevent recovery so the closing state spans the utility knee.
  battery(input).available[1] = false;
  input.source.problem.economics.import_sek_per_kwh = [0, 0];
  input.acceptance.max_component_error_sek = 0;
  const result = compiled(input);
  assertEquals(result.cells[0].status, "excluded");
  assert(result.cells[0].reasons.includes("component_error_exceeded"));
  assert(
    result.cells[0].evidence.some((e) => e.max_component_error_sek > 0.001),
  );
  assertEquals(result.cells[0].held_out_indices.length, 5);
  input.acceptance.max_component_error_sek = 10;
  input.acceptance.max_ranking_regret_sek = 10;
  assertEquals(compiled(input).cells[0].status, "accepted_empirical");
});

Deno.test("pruned graph results never become accepted empirical coverage", () => {
  const input = fixture();
  const p = input.source.problem, b = battery(input);
  p.intervals.push({
    start: p.intervals[1].end,
    end: new Date(Date.parse(p.intervals[1].end) + 900000).toISOString(),
  });
  p.plant.pv_w.push(0);
  p.plant.residual_loads[0].power_w.push(1000);
  b.available.push(true);
  b.grid_charge_allowed.push(true);
  b.export_allowed.push(false);
  p.economics.import_sek_per_kwh.push(2);
  p.economics.export_sek_per_kwh.push(0);
  p.plant.pv_w[1] = 500;
  p.economics.ramp_sek_per_kw = 0.25;
  input.source.search.retained_per_level = 1;
  input.source.search.energy_levels_kwh = [0, 0.05, 0.1, 0.15, 0.2, 0.25];
  const result = compiled(input);
  assertEquals(result.cells[0].status, "excluded");
  assert(
    result.samples.some((s) =>
      s.status === "unavailable" && s.reason === "incomplete_search"
    ),
  );
});

Deno.test("coverage public boundaries reject malformed JSON and battery-free households without throwing", () => {
  const input = fixture(), result = compiled(input);
  const equivalent = structuredClone(input.source.problem);
  equivalent.intervals[0].start = equivalent.intervals[0].start.replace(
    ".000Z",
    "Z",
  );
  equivalent.identity.actuals_watermark = equivalent.intervals[0].start;
  assertEquals(
    evaluateBatteryPolicyCoverage(result, equivalent).status,
    "estimated",
  );
  const p = structuredClone(input.source.problem);
  p.plant.equipment = [];
  assertEquals(
    evaluateBatteryPolicyCoverage(result, p).status,
    "outside_coverage",
  );
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const invalid of [undefined, cycle, { value: 1n }]) {
    assertEquals(compileBatteryPolicyCoverage(invalid).status, "rejected");
  }
});

Deno.test("ranking regret has an independent acceptance gate even when component error is allowed", () => {
  const input = fixture(), p = input.source.problem;
  battery(input).available[1] = false;
  p.economics.import_sek_per_kwh = [0, 0];
  p.economics.terminal = [{
    id: "closing",
    store_id: "battery",
    model_id: "terminal-v1",
    coverage_from: p.intervals.at(-1)!.end,
    event_ids: [],
    curve: {
      unit: "kwh",
      points: [{ at: 0.15, sek_per_unit: 10 }, { at: 0.25, sek_per_unit: 0 }],
    },
  }];
  input.acceptance = {
    max_component_error_sek: 10,
    max_ranking_regret_sek: 10,
  };
  const midpoint = point(input, input.axes.at_ms[0] + 150000, 0.005);
  const estimate = evaluateBatteryPolicyCoverage(compiled(input), midpoint);
  const exact = compileBatteryPolicy({ ...input.source, problem: midpoint });
  assert(estimate.status === "estimated" && exact.status === "compiled");
  const estimatedDelta =
    estimate.values.find((v) => v.id === "charge")!.total_delta_sek;
  const exactDelta =
    exact.alternatives.find((v) => v.id === "charge")!.total_delta_sek;
  assert(Math.abs(estimatedDelta - exactDelta) > 0.001);
  // Move a known interpolation discrepancy across the charge/hold decision boundary.
  const currentKwh = (Date.parse(midpoint.intervals[0].end) -
    Date.parse(midpoint.intervals[0].start)) / 3600000;
  p.economics.import_sek_per_kwh[0] = -(estimatedDelta + exactDelta) / 2 /
    currentKwh;
  input.acceptance.max_ranking_regret_sek = 0;
  const result = compiled(input);
  assertEquals(result.cells[0].status, "excluded");
  assertEquals(result.cells[0].reasons, ["ranking_regret_exceeded"]);
  assert(result.cells[0].evidence.some((e) => e.ranking_regret_sek > 0.001));
});
