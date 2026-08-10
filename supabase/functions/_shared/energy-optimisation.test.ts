import {
  generateOptimisationPlan,
  type OptimisationSnapshotV3,
  validateSnapshot,
} from "./energy-optimisation.ts";

const assert: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const input = (
  overrides: Partial<OptimisationSnapshotV3> = {},
): OptimisationSnapshotV3 => {
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const slots = Array.from({ length: 64 }, (_, index) => ({
    start: new Date(start + index * 15 * 60_000).toISOString(),
    pv_forecast_w: index >= 8 && index < 24 ? 4_000 : 0,
    base_load_forecast_w: 500,
    base_load_p10_w: 350,
    base_load_p90_w: 900,
    import_price_sek_per_kwh: index < 20 ? 1 + index / 100 : null,
    export_price_sek_per_kwh: index < 20 ? 0.2 + index / 200 : null,
  }));
  return {
    schema_version: 3,
    mode: "live",
    capabilities: {
      pv: true,
      battery: true,
      pool: true,
      boiler: true,
      ev: false,
    },
    snapshot_id: "00000000-0000-4000-8000-000000000001",
    captured_at: "2026-08-10T07:55:00.000Z",
    timezone: "Europe/Stockholm",
    slot_minutes: 15,
    slots,
    sources: {
      pv: {
        provider: "test-pv",
        entity_ids: ["sensor.pv"],
        issued_at: "2026-08-10T07:50:00Z",
        valid_until: "2026-08-10T16:00:00Z",
        quality: "calibrated",
        sample_count: 30,
        location: { latitude: 59.3, longitude: 18.1 },
      },
      base_load: {
        provider: "recorder",
        entity_ids: ["sensor.load"],
        issued_at: "2026-08-10T07:55:00Z",
        valid_until: "2026-08-10T10:00:00Z",
        quality: "measured",
        sample_count: 960,
      },
      import_price: {
        provider: "test-import",
        entity_ids: ["sensor.buy"],
        issued_at: "2026-08-10T07:50:00Z",
        valid_until: "2026-08-10T13:00:00Z",
        quality: "provider_raw",
        location: { market_area: "SE3" },
      },
      export_price: {
        provider: "test-export",
        entity_ids: ["sensor.sell"],
        issued_at: "2026-08-10T07:50:00Z",
        valid_until: "2026-08-10T13:00:00Z",
        quality: "provider_raw",
        location: { market_area: "SE3" },
      },
      battery: {
        provider: "home-assistant-state",
        entity_ids: ["sensor.battery_soc"],
        issued_at: "2026-08-10T07:54:00Z",
        valid_until: "2026-08-10T09:10:00Z",
        quality: "measured",
        sample_count: 1,
      },
    },
    pv_calibration: {
      correction_factor_by_lead_day: [0.8, 0.75, 0.7, 0.65],
      sample_count_by_lead_day: [30, 20, 10, 5],
    },
    battery: {
      capacity_kwh: 10,
      soc: 0.4,
      min_soc: 0.05,
      max_soc: 1,
      charge_max_w: 5_000,
      discharge_max_w: 5_000,
      charge_efficiency: 0.95,
      discharge_efficiency: 0.95,
    },
    grid: { import_limit_w: 10_000, export_limit_w: 10_000 },
    policy: {
      battery_end_of_solar_target_soc: 0.65,
      battery_target_is_hard: true,
      terminal_soc_min: 0.05,
      terminal_energy_value_sek_per_kwh: 1,
    },
    services: [
      {
        id: "boiler:2026-08-10",
        device: "boiler",
        earliest_start: slots[0].start,
        deadline: new Date(start + 8 * 60 * 60_000).toISOString(),
        required_kwh: 1.5,
        control: { type: "fixed_power", power_w: 3_000 },
        min_run_slots: 2,
        priority: 1,
        baseline_preferred_start: slots[0].start,
      },
      {
        id: "pool:2026-08-10",
        device: "pool",
        earliest_start: slots[0].start,
        deadline: new Date(start + 8 * 60 * 60_000).toISOString(),
        required_kwh: 2,
        control: { type: "fixed_power", power_w: 2_000 },
        min_run_slots: 4,
        priority: 2,
        baseline_preferred_start: slots[12].start,
      },
    ],
    service_requirement_sample_days: { hot_water: 17, pool_heating: 17 },
    ...overrides,
  };
};

Deno.test("all scenarios use equal discrete contiguous service workloads", () => {
  const result = generateOptimisationPlan(
    input(),
    new Date("2026-08-10T07:55:00Z"),
  );
  const workloads = Object.values(result.plans).map((plan) =>
    plan.summary.flexible_load_kwh
  );
  assert(new Set(workloads).size === 1, "scenario workloads differ");
  assert(
    result.plans.priority.status === "ready",
    "feasible priority plan was rejected",
  );
  assert(
    Object.values(result.plans.priority.summary.battery_end_of_solar_soc).every(
      (soc) => soc >= input().policy.battery_end_of_solar_target_soc,
    ),
    "priority plan missed the hard battery target",
  );
  for (const plan of Object.values(result.plans)) {
    for (const slot of plan.slots) {
      assert([0, 2_000].includes(slot.pool_w), "pool power is fractional");
      assert([0, 3_000].includes(slot.boiler_w), "boiler power is fractional");
    }
    for (const indices of Object.values(plan.service_slots)) {
      assert(
        indices.every((value, index) =>
          index === 0 || value === indices[index - 1] + 1
        ),
        "service is fragmented",
      );
    }
  }
});

Deno.test("EV charging is planned as valid discrete current setpoints", () => {
  const base = input();
  const snapshot = input({
    capabilities: {
      pv: true,
      battery: false,
      pool: false,
      boiler: false,
      ev: true,
    },
    battery: null,
    sources: { ...base.sources, battery: null },
    policy: {
      battery_end_of_solar_target_soc: 0,
      battery_target_is_hard: false,
      terminal_soc_min: 0,
      terminal_energy_value_sek_per_kwh: 0,
    },
    services: [{
      id: "ev:departure",
      device: "ev",
      earliest_start: base.slots[0].start,
      deadline: base.slots[48].start,
      required_kwh: 8,
      control: {
        type: "discrete_current",
        min_current_a: 5,
        max_current_a: 16,
        current_step_a: 1,
        phase_count: 3,
        voltage_v: 230,
      },
      min_run_slots: 2,
      priority: 3,
      baseline_preferred_start: base.slots[0].start,
    }],
    service_requirement_sample_days: { ev_charging: 1 },
  });

  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  assert(result.schema_version === 3, "wrong plan schema");
  assert(result.status === "ready", "feasible EV plan was rejected");
  for (const plan of Object.values(result.plans)) {
    const positive = plan.slots.filter((slot) => slot.ev_target_current_a > 0);
    assert(positive.length === 9, "EV was not spread across the expected run");
    assert(
      new Set(positive.map((slot) => slot.ev_target_current_a)).size > 1,
      "EV current was flattened to one fixed power",
    );
    for (const slot of plan.slots) {
      const current = slot.ev_target_current_a;
      assert(
        current === 0 ||
          (current >= 5 && current <= 16 && Number.isInteger(current)),
        "EV current is outside the charger steps",
      );
      assert(
        Math.abs(slot.ev_w - current * 3 * 230) < 1e-6,
        "EV power does not match its planned current",
      );
      assert(
        slot.ev_min_current_a <= current && current <= slot.ev_max_current_a,
        "EV target is outside its reactive envelope",
      );
    }
    const delivered = plan.slots.reduce(
      (sum, slot) => sum + slot.ev_w / 1_000 * 0.25,
      0,
    );
    assert(delivered >= 8, "EV requirement was under-delivered");
    assert(delivered < 8 + 0.173, "EV quantisation over-delivered by too much");
    assert(
      plan.service_currents_a["ev:departure"].length === positive.length,
      "EV service current schedule is incomplete",
    );
    assert(
      plan.slots.slice(0, 48).every((slot) => slot.ev_max_current_a === 16),
      "the reactive controller lost recovery headroom before departure",
    );
  }

  const infeasible = structuredClone(snapshot);
  infeasible.services[0].deadline = base.slots[2].start;
  const infeasibleResult = generateOptimisationPlan(
    infeasible,
    new Date("2026-08-10T07:55:00Z"),
  );
  assert(
    infeasibleResult.status === "infeasible" &&
      Object.values(infeasibleResult.plans).every((plan) =>
        plan.status === "infeasible"
      ),
    "an EV requirement above the departure-window capacity was accepted",
  );
  assert(
    Object.values(infeasibleResult.plans).every((plan) =>
      plan.slots.every((slot) =>
        slot.ev_target_current_a === 0 && slot.ev_min_current_a === 0 &&
        slot.ev_max_current_a === 0
      )
    ),
    "an infeasible EV plan exposed an actionable current envelope",
  );

  const service = snapshot.services[0];
  if (service.control.type !== "discrete_current") {
    throw new Error("invalid test fixture");
  }
  service.control.max_current_a = 16.5;
  assert(
    validateSnapshot(snapshot).some((error) =>
      error.includes("discrete current control")
    ),
    "misaligned charger current range was accepted",
  );
});

Deno.test("prices stay directional and PV calibration is applied", () => {
  const snapshot = input();
  snapshot.battery = { ...snapshot.battery!, soc: 1, charge_max_w: 0 };
  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  const slot = result.plans.cost.slots[8];
  assert(slot.import_price_sek_per_kwh === 1.08, "wrong import price");
  assert(
    Math.abs((slot.export_price_sek_per_kwh ?? 0) - 0.24) < 1e-9,
    "wrong export price",
  );
  assert(
    slot.pv_raw_w === 4_000 && slot.pv_w === 3_200,
    "PV correction missing",
  );
  const exportSlot = result.plans.cost.slots.find((candidate) =>
    candidate.binding && candidate.grid_export_w > 0
  );
  assert(exportSlot !== undefined, "fixture did not exercise export valuation");
  assert(
    Math.abs(
      (exportSlot.export_revenue_sek ?? 0) -
        exportSlot.grid_export_w / 1_000 * 0.25 *
          (exportSlot.export_price_sek_per_kwh ?? 0),
    ) < 1e-5,
    "export revenue did not use the export price",
  );
});

Deno.test("homes without PV or a battery still receive a valid price-led plan", () => {
  const snapshot = input({
    capabilities: {
      pv: false,
      battery: false,
      pool: true,
      boiler: true,
      ev: false,
    },
    battery: null,
    sources: {
      ...input().sources,
      pv: null,
      battery: null,
    },
    policy: {
      battery_end_of_solar_target_soc: 0,
      battery_target_is_hard: false,
      terminal_soc_min: 0,
      terminal_energy_value_sek_per_kwh: 0,
    },
    slots: input().slots.map((slot) => ({ ...slot, pv_forecast_w: 0 })),
    pv_calibration: {
      correction_factor_by_lead_day: [1, 1, 1, 1],
      sample_count_by_lead_day: [0, 0, 0, 0],
    },
  });

  assert(validateSnapshot(snapshot).length === 0, "optional capabilities rejected");
  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  assert(result.battery === null, "a battery was invented");
  assert(
    result.plans.priority.slots.every((slot) =>
      slot.battery_charge_w === 0 && slot.battery_discharge_w === 0
    ),
    "a disabled battery exchanged power",
  );
});

Deno.test("an impossible hard battery target is reported", () => {
  const base = input();
  const result = generateOptimisationPlan(
    input({
      policy: { ...base.policy, battery_end_of_solar_target_soc: 1 },
      slots: base.slots.map((slot, index) => ({
        ...slot,
        pv_forecast_w: index === 8 ? 100 : 0,
      })),
    }),
    new Date("2026-08-10T07:55:00Z"),
  );
  assert(result.status === "infeasible", "impossible plan was published ready");
  assert(
    Object.values(result.plans).every((plan) => plan.status === "infeasible"),
    "a comparison scenario silently ignored the hard target",
  );
  assert(
    result.plans.priority.validation_errors.join(" ").includes(
      "battery target",
    ),
    "target failure was not explained",
  );
});

Deno.test("the binding horizon stops at the first price gap", () => {
  const snapshot = input();
  snapshot.slots[5].import_price_sek_per_kwh = null;
  snapshot.slots[5].export_price_sek_per_kwh = null;
  assert(
    validateSnapshot(snapshot).length === 0,
    "schema unexpectedly invalid",
  );
  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  assert(
    result.binding_until === snapshot.slots[5].start,
    "binding boundary crossed a gap",
  );
  assert(
    !result.plans.cost.slots[6].binding,
    "later price silently became binding",
  );
});

Deno.test("stale snapshots and unpriced first slots fail closed", () => {
  let staleError = "";
  try {
    generateOptimisationPlan(input(), new Date("2026-08-10T08:11:00Z"));
  } catch (error) {
    staleError = error instanceof Error ? error.message : String(error);
  }
  assert(staleError.includes("fresh snapshot"), "stale snapshot was accepted");

  const unpriced = input();
  unpriced.slots[0].import_price_sek_per_kwh = null;
  unpriced.slots[0].export_price_sek_per_kwh = null;
  assert(
    validateSnapshot(unpriced).some((error) =>
      error.includes("first forecast slot")
    ),
    "an immediately advisory plan was accepted for execution",
  );
});

Deno.test("a truncated final local day is not labelled end-of-solar", () => {
  const snapshot = input();
  snapshot.slots = snapshot.slots.slice(0, 32).map((slot) => ({
    ...slot,
    pv_forecast_w: 0,
  }));
  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  assert(
    Object.keys(result.plans.priority.summary.battery_end_of_solar_soc)
      .length === 0,
    "partial day received a fabricated end-of-solar result",
  );
  assert(
    !result.plans.priority.validation_errors.some((error) =>
      error.includes("battery target")
    ),
    "partial-day solar was treated as a failed daily target",
  );
});

Deno.test("overlapping commitments cannot double-book one physical device", () => {
  const snapshot = input();
  const deadline = snapshot.slots[2].start;
  snapshot.services = [
    {
      id: "boiler:first",
      device: "boiler",
      earliest_start: snapshot.slots[0].start,
      deadline,
      required_kwh: 1.5,
      control: { type: "fixed_power", power_w: 3_000 },
      min_run_slots: 2,
      priority: 1,
    },
    {
      id: "boiler:second",
      device: "boiler",
      earliest_start: snapshot.slots[0].start,
      deadline,
      required_kwh: 1.5,
      control: { type: "fixed_power", power_w: 3_000 },
      min_run_slots: 2,
      priority: 1,
    },
  ];

  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );

  assert(result.status === "infeasible", "double booking was accepted");
  assert(
    result.plans.priority.slots.every((slot) => slot.boiler_w <= 3_000),
    "one boiler was scheduled at two simultaneous power levels",
  );
  assert(
    result.plans.priority.validation_errors.some((error) =>
      error.includes("no feasible contiguous")
    ),
    "the conflicting commitment was not explained",
  );
});
