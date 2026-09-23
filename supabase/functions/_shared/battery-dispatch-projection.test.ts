import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "@std/assert";
import {
  projectBatteryDispatch,
  type ResolvedBatterySource,
} from "./battery-dispatch-projection.ts";
import { createHouseholdScorer } from "./household-score.ts";
import { type HouseholdCandidate } from "./household-case.ts";
import {
  type DispatchAuctionSolver,
  dispatchAuctionSteps,
  scoreDispatch,
} from "./dispatch-plan.ts";
import {
  generateOptimisationPlan,
  generateOptimisationPlanWithBatteryProjection,
} from "./energy-optimisation.ts";
import {
  batterySnapshot,
  mixedModeSnapshot,
} from "../../../scripts/generate-ha-plan-fixture.ts";
import { commandSnapshot } from "../../../scripts/generate-ha-device-plan-fixture.ts";
import { replanReference } from "./replan-continuity.ts";

function source(load = [1100.123456, 600, 2500, 2000]): ResolvedBatterySource {
  const hours = [1 / 8, 1 / 4, 1 / 4, 1 / 4];
  const start = Date.parse("2026-09-15T12:00:00Z");
  return {
    identity: {
      snapshot_id: "capture-1",
      model_version: "resolved-test",
      issued_at: new Date(start).toISOString(),
      branch: "priority",
      operating_scope: null,
    },
    rows: load.map((house_w, i) => ({
      start: new Date(start + (i * 900000) + (i ? 0 : 450000)).toISOString(),
      end: new Date(start + (i + 1) * 900000).toISOString(),
      house_w,
      residual_w: house_w - 500,
      device_loads_w: { fixed_device: 500 },
      charge_w: 0,
      discharge_w: 0,
      export_w: 0,
      curtailed_w: 0,
      unserved_w: 0,
    })),
    slots: load.map((fixed_load_w, i) => ({
      fixed_load_w,
      duration_hours: hours[i],
      pv_w: [0, 3000, 0, 500][i],
      import_price_sek_per_kwh: [-0.3, 1.4, 2.77, 0.9][i],
      export_price_sek_per_kwh: [-0.8, .2, 1.2, -.1][i],
      binding: true,
      published_price: true,
    })),
    store: {
      key: "battery",
      curve: {
        unit: "kwh",
        points: [{ at: 3, sek_per_unit: 2 }, { at: 8, sek_per_unit: .4 }, {
          at: 10,
          sek_per_unit: 0,
        }],
      },
      initial_state: 5,
      min_state: 0,
      max_state: 10,
      max_power_w: 4000,
      retention_per_slot: 1,
      usage_weight: [0, 0, 0, 0],
      terminal_weight: 1,
      units_per_kwh: () => .93,
      drift: (state) => state,
      slot_hours: hours,
      discharge: {
        max_power_w: 4000,
        state_per_kwh_out: () => 1 / .89,
        cycling_cost_sek_per_unit: .137,
        export_allowed: true,
        export_allowed_by_slot: [false, true, true, false],
        export_min_state: 0,
      },
    },
    limits: {
      grid_import_limit_w: 10000,
      grid_export_limit_w: 10000,
      grid_import_shaping_w: 0,
      peak_shaping_sek_per_kwh_per_kw: .1,
      grid_ramp_sek_per_kw: .05,
    },
  };
}

function parity(s: ResolvedBatterySource) {
  const projection = projectBatteryDispatch(s);
  assert(projection.status === "ready", JSON.stringify(projection));
  const scorer = createHouseholdScorer(projection.problem);
  let firstDispatch: number | undefined, firstHousehold: number | undefined;
  for (
    const [charge, discharge] of [
      [[0, 0, 0, 0], [0, 0, 0, 0]],
      [[1800, 1400, 0, 0], [0, 0, 1200, 0]],
      [[0, 0, 0, 400], [400, 0, 3300, 0]],
    ]
  ) {
    const candidate: HouseholdCandidate = {
      id: "counterfactual",
      pv_curtail_w: [0, 0, 0, 0],
      actions: {
        battery: charge.map((charge_w, i) => ({
          kind: "battery",
          charge_w,
          discharge_w: discharge[i],
          solar_charge_w: Math.min(
            charge_w,
            Math.max(0, s.slots[i].pv_w - s.rows[i].house_w),
          ),
          export_w: Math.max(
            0,
            discharge[i] - Math.max(0, s.rows[i].house_w - s.slots[i].pv_w),
          ),
        })),
      },
    };
    const household = scorer.score(candidate);
    assert(household.status === "scored", JSON.stringify(household));
    // Conditional scorer: freeze the FINAL demand, not the auction's earlier one.
    const dispatch = scoreDispatch(
      s.slots.map((slot, i) => ({ ...slot, fixed_load_w: s.rows[i].house_w })),
      [s.store],
      s.limits,
      { power_w: { battery: charge }, discharge_w: { battery: discharge } },
    );
    assertEquals(dispatch.infeasibilities, []);
    const h = household.objective;
    assertAlmostEquals(
      dispatch.total_sek,
      h.total_sek + projection.dispatch_total_offset_sek,
      1e-9,
    );
    assertAlmostEquals(dispatch.import_sek, h.import_sek, 1e-9);
    assertAlmostEquals(dispatch.export_sek, h.export_sek, 1e-9);
    assertAlmostEquals(dispatch.wear_sek, h.wear_sek, 1e-9);
    assertAlmostEquals(dispatch.peak_sek, h.shaping_sek, 1e-9);
    assertAlmostEquals(dispatch.continuity_sek, h.ramp_sek, 1e-9);
    firstDispatch ??= dispatch.total_sek;
    firstHousehold ??= h.total_sek;
    assertAlmostEquals(
      dispatch.total_sek - firstDispatch,
      h.total_sek - firstHousehold,
      1e-9,
    );
  }
  assertEquals(projection.problem.economics.initial_import_w, null);
  assert(projection.dispatch_total_offset_sek > 0);
  assertEquals(projection.problem.plant.equipment[0].kind, "battery");
}

Deno.test("conditional battery projection preserves costs and rankings across two final device schedules", () => {
  parity(source());
  const changed = source([1900.123456, 2900, 3700, 3200]);
  // Simulate thermal loads added after the auction; pricing must follow final H.
  changed.slots.forEach((s) => s.fixed_load_w -= 750);
  parity(changed);
});

Deno.test("resolved projection rejects unsupported constraints instead of approximating", () => {
  const cases: [string, (s: ResolvedBatterySource) => void][] = [
    ["nonzero_shaping_threshold", (s) => s.limits.grid_import_shaping_w = 1000],
    ["curtailment_or_unserved_energy", (s) => s.rows[0].curtailed_w = 1],
    ["curtailment_or_unserved_energy", (s) => s.rows[0].unserved_w = 1],
    ["positive_export_reserve", (s) => s.store.discharge!.export_min_state = 1],
    [
      "missing_resolved_permissions_or_wear",
      (s) => delete s.store.discharge!.export_allowed_by_slot,
    ],
    [
      "missing_resolved_permissions_or_wear",
      (s) => delete s.store.discharge!.cycling_cost_sek_per_unit,
    ],
    ["unsupported_battery_objective", (s) => s.store.usage_weight[1] = .1],
    ["capture_duration_mismatch", (s) => s.rows[0].start = s.rows[1].start],
    ["capture_length_mismatch", (s) => s.rows.pop()],
    ["invalid_household_partition", (s) => s.rows[1].house_w += 1],
    ["invalid_household_partition", (s) => s.rows[1].residual_w = NaN],
    [
      "nonconstant_battery_physics",
      (s) => s.store.units_per_kwh = (state) => state > 8 ? .8 : .93,
    ],
    // No capacity to model; its missing ceiling is not probed as a state.
    ["unbounded_battery_state", (s) => delete s.store.max_state],
  ];
  for (const [reason, change] of cases) {
    const s = source();
    change(s);
    const result = projectBatteryDispatch(s);
    assert(result.status === "unsupported");
    assert(result.reasons.includes(reason), JSON.stringify(result));
  }
  const s = source();
  s.rows[0].discharge_w = 5000;
  assertEquals(projectBatteryDispatch(s), {
    status: "unsupported",
    reasons: ["selected_conditional_schedule_infeasible"],
  });
});

Deno.test("projection is detached and immutable and candidate limits still reject curtailment", () => {
  const s = source();
  const p = projectBatteryDispatch(s);
  assert(p.status === "ready");
  s.rows[0].house_w = 9999;
  s.store.curve.points[0].sek_per_unit = 99;
  assertEquals(p.provenance.final_demand[0].house_w, 1100.123456);
  assertEquals(p.problem.economics.terminal[0].curve.points[0].sek_per_unit, 2);
  assertThrows(() => p.problem.plant.pv_w[0] = 9999, TypeError);
  const limited = structuredClone(p.problem);
  limited.plant.grid.export_limit_w = 1;
  assertEquals(
    createHouseholdScorer(limited).score(p.selected_candidate).status,
    "physically_infeasible",
  );
});

const solve: DispatchAuctionSolver = (slots, stores, limits, options) => {
  const steps = dispatchAuctionSteps(slots, stores, limits, options);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
};

Deno.test("production captures exact execution demand and partial interval without another solve or wire changes", () => {
  const s = mixedModeSnapshot();
  s.slots[0].base_load_forecast_w = 700.123456;
  const before = structuredClone(s);
  let calls = 0;
  const counting: DispatchAuctionSolver = (...args) => {
    calls++;
    return solve(...args);
  };
  const now = new Date(s.captured_at);
  const normal = generateOptimisationPlan(
    s,
    now,
    [],
    undefined,
    null,
    counting,
  );
  const normalCalls = calls;
  calls = 0;
  const { plan, battery_projection: p } =
    generateOptimisationPlanWithBatteryProjection(
      s,
      now,
      [],
      undefined,
      null,
      counting,
    );
  assertEquals(calls, normalCalls);
  assertEquals(calls, 1);
  // One authoritative auction supplies both presentation and execution.
  assertEquals(plan, normal);
  assertEquals(s, before);
  assert(p.status === "ready", JSON.stringify(p));
  assertEquals(p.provenance.branch, "execution");
  assertEquals(p.provenance.operating_scope, s.operating_scope);
  assertEquals(p.problem.intervals[0].start, s.captured_at);
  assertEquals(p.problem.intervals[0].end, s.slots[1].start);
  assertAlmostEquals(
    p.problem.plant.residual_loads[0].power_w[0],
    2800.123456,
    1e-9,
  );
  assertEquals(plan.execution_plan!.plans.priority.slots[0].load_w, 2800.12);
  assertEquals(p.problem.plant.residual_loads[0].power_w[1], 2800);
  assertEquals(JSON.parse(JSON.stringify(plan)), plan);
  const battery = p.problem.plant.equipment[0];
  assert(battery.kind === "battery");
  assertEquals(
    battery.state_kwh.initial,
    (s.battery!.soc - s.battery!.min_soc) * s.battery!.capacity_kwh,
  );
  assertEquals(battery.grid_charge_allowed, s.slots.map(() => true));
});

Deno.test("production projection includes final thermal demand installed after the auction", () => {
  const s = commandSnapshot();
  const b = batterySnapshot();
  s.schema_version = 8;
  s.capabilities.battery = true;
  s.battery = b.battery;
  s.policy = b.policy;
  s.sources.battery = b.sources.battery;
  let auctionDemand: number[] = [];
  let captured: Parameters<DispatchAuctionSolver>;
  const capture: DispatchAuctionSolver = (...args) => {
    captured = args;
    auctionDemand = args[0].map((s) => s.fixed_load_w);
    return solve(...args);
  };
  const { plan, battery_projection: p } =
    generateOptimisationPlanWithBatteryProjection(
      s,
      new Date(s.captured_at),
      [],
      undefined,
      null,
      capture,
    );
  assert(p.status === "ready", JSON.stringify(p));
  const final = p.problem.plant.residual_loads[0].power_w;
  assert(final.some((w, i) => Math.abs(w - auctionDemand[i]) > 1));
  assertEquals(
    final.map((w) => Math.round(w * 100) / 100),
    plan.plans.priority.slots.map((s) => s.load_w),
  );
  const [slots, stores, limits] = captured!;
  const store = stores.find((s) => s.key === "battery")!;
  const actions = p.selected_candidate.actions.battery;
  const dispatch = scoreDispatch(
    slots.map((s, i) => ({ ...s, fixed_load_w: final[i] })),
    [store],
    limits,
    {
      power_w: {
        battery: actions.map((a) => a.kind === "battery" ? a.charge_w : 0),
      },
      discharge_w: {
        battery: actions.map((a) => a.kind === "battery" ? a.discharge_w : 0),
      },
    },
  );
  const household = createHouseholdScorer(p.problem).score(
    p.selected_candidate,
  );
  assert(household.status === "scored");
  assertEquals(dispatch.infeasibilities, []);
  assertAlmostEquals(
    dispatch.total_sek,
    household.objective.total_sek + p.dispatch_total_offset_sek,
    1e-9,
  );
  assertEquals(store.curve, p.problem.economics.terminal[0].curve);
});

Deno.test("projection follows accepted continuity materialization and rejects hard target authority", () => {
  const s = batterySnapshot();
  s.captured_at = s.slots[0].start;
  s.slots.forEach((slot, i) => {
    slot.pv_forecast_w = i < 8 ? 4753.18 : 0;
    slot.base_load_forecast_w = 1835.72;
    slot.import_price_sek_per_kwh = 1;
    slot.export_price_sek_per_kwh = .01;
  });
  s.policy.battery_export_enabled = true;
  s.policy.battery_export_reserve_soc = .05;
  s.policy.battery_export_min_price_sek_per_kwh = 0;
  s.slots[0].pv_forecast_w = s.slots[0].base_load_forecast_w;
  const now = new Date(s.captured_at);
  const reference = generateOptimisationPlan(s, now).battery_value_curve!.automatic_curve;
  s.value_curves = { battery: reference };
  const previous = generateOptimisationPlan(s, now);
  s.snapshot_id = "00000000-0000-4000-8000-000000000002";
  s.slots[0].pv_forecast_w += 100;
  s.replan_reference = replanReference(previous, s, now);
  const { plan, battery_projection: p } =
    generateOptimisationPlanWithBatteryProjection(s, now);
  assert(p.status === "ready", JSON.stringify(p));
  assert(plan.plans.priority.continuity);
  assertEquals(plan.plans.priority.continuity.selected, "direct");
  assertEquals(
    p.selected_candidate.actions.battery.map((a) =>
      a.kind === "battery" ? Math.round(a.discharge_w * 100) / 100 : null
    ),
    plan.plans.priority.slots.map((s) => s.battery_discharge_w),
  );
  s.policy.battery_target_is_hard = true;
  const rejected =
    generateOptimisationPlanWithBatteryProjection(s, now).battery_projection;
  assert(rejected.status === "unsupported");
  assert(rejected.reasons.includes("hard_battery_target"));
});

Deno.test("delayed production capture trims scope provenance with the economic horizon", () => {
  const s = mixedModeSnapshot();
  s.captured_at = new Date(Date.parse(s.slots[0].start) + 14 * 60_000)
    .toISOString();
  s.sources.battery!.issued_at = s.captured_at;
  const now = new Date(Date.parse(s.slots[1].start) + 30_000);
  const { plan, battery_projection: p } =
    generateOptimisationPlanWithBatteryProjection(s, now);
  assert(p.status === "ready", JSON.stringify(p));
  assertEquals(p.provenance.operating_scope, plan.operating_scope);
  assertEquals(p.problem.intervals.length, 15);
  assertEquals(p.problem.intervals[0].start, now.toISOString());
  for (
    const demand of Object.values(
      p.provenance.operating_scope!.external_demands,
    )
  ) {
    assertEquals(demand.forecast_w_by_slot.length, p.problem.intervals.length);
    assertEquals(demand.recent_observation, null);
  }
});

Deno.test("invalid resolved battery bounds are unsupported rather than breaking ordinary plan generation", () => {
  const s = source();
  s.store.initial_state = s.store.max_state + .1;
  assertEquals(projectBatteryDispatch(s), {
    status: "unsupported",
    reasons: ["invalid_resolved_model"],
  });
});

Deno.test("decimal battery flows remain exact before non-export feasibility checks", () => {
  const s = batterySnapshot();
  s.policy.battery_export_enabled = false;
  s.slots.forEach((slot) =>
    Object.assign(slot, {
      base_load_forecast_w: 1279.009,
    })
  );
  const { battery_projection: p } =
    generateOptimisationPlanWithBatteryProjection(s, new Date(s.captured_at));
  assert(p.status === "ready", JSON.stringify(p));
  assert(p.provenance.final_demand.some((r) => r.discharge_w > 0));
  for (const row of p.provenance.final_demand) assert(row.export_w < 1e-7);
});
