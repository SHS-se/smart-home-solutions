import {
  generateOptimisationPlan,
  type OptimisationSnapshotV5,
  validateSnapshot,
} from "./energy-optimisation.ts";

const assert: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const input = (
  overrides: Partial<OptimisationSnapshotV5> = {},
): OptimisationSnapshotV5 => {
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
    schema_version: 5,
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
    ev_battery: null,
    grid: { import_limit_w: 10_000, export_limit_w: 10_000 },
    policy: {
      battery_end_of_solar_target_soc: 0.65,
      battery_target_is_hard: true,
      terminal_soc_min: 0.05,
      terminal_energy_value_sek_per_kwh: 1,
    },
    device_models: [],
    services: [
      {
        id: "boiler:2026-08-10",
        device: "boiler",
        earliest_start: slots[0].start,
        deadline: new Date(start + 8 * 60 * 60_000).toISOString(),
        required_kwh: 2.8,
        control: {
          type: "duty_cycle",
          rated_power_w: 3_000,
          expected_power_w_by_slot: slots.map(() => 350),
          max_consecutive_inhibit_slots: 4,
        },
        priority: 1,
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
      assert(slot.boiler_expected_w >= 0, "boiler expectation is negative");
      assert(
        slot.boiler_permitted || slot.boiler_expected_w === 0,
        "inhibited boiler still has expected draw",
      );
    }
    for (const [serviceId, indices] of Object.entries(plan.service_slots)) {
      if (serviceId.startsWith("boiler:")) continue;
      assert(
        indices.every((value, index) =>
          index === 0 || value === indices[index - 1] + 1
        ),
        "service is fragmented",
      );
    }
  }
});

Deno.test("duty-cycle boiler is inhibited around planned loads without invented on blocks", () => {
  const result = generateOptimisationPlan(
    input(),
    new Date("2026-08-10T07:55:00Z"),
  );
  const baseline = result.plans.baseline;
  const planned = result.plans.priority;
  const inhibited = planned.service_inhibited_slots["boiler:2026-08-10"];
  assert(
    inhibited.length > 0,
    "boiler was never inhibited around a planned load",
  );
  assert(
    baseline.service_inhibited_slots["boiler:2026-08-10"].length === 0,
    "unplanned boiler was inhibited",
  );
  let consecutive = 0;
  for (const [index, slot] of planned.slots.entries()) {
    if (inhibited.includes(index)) {
      consecutive += 1;
      assert(!slot.boiler_permitted, "inhibit slot remained permitted");
      assert(
        slot.boiler_expected_w === 0,
        "inhibit slot retained expected draw",
      );
    } else {
      consecutive = 0;
    }
    assert(consecutive <= 4, "maximum safe inhibit interval was exceeded");
    assert(slot.boiler_expected_w <= 3_000, "expected draw exceeded rating");
  }
  assert(
    baseline.slots.some((slot) =>
      slot.boiler_expected_w > 0 && slot.boiler_expected_w < 3_000
    ),
    "baseline still models the thermostat as exact full-power blocks",
  );
});

Deno.test("empirical device forecasts participate in the energy balance", () => {
  const snapshot = input();
  snapshot.capabilities = {
    pv: false,
    battery: false,
    pool: false,
    boiler: false,
    ev: false,
  };
  snapshot.battery = null;
  snapshot.sources = { ...snapshot.sources, pv: null, battery: null };
  snapshot.policy = {
    battery_end_of_solar_target_soc: 0,
    battery_target_is_hard: false,
    terminal_soc_min: 0,
    terminal_energy_value_sek_per_kwh: 0,
  };
  snapshot.slots = snapshot.slots.map((slot) => ({
    ...slot,
    pv_forecast_w: 0,
  }));
  snapshot.services = [];
  snapshot.service_requirement_sample_days = {};
  snapshot.device_models = [{
    key: "sensor-fridge-energy",
    name: "Fridge",
    statistic_id: "sensor.fridge_energy",
    category: "appliances",
    suggested_load_type: "duty_cycle",
    load_type: "duty_cycle",
    planning_role: "controllable",
    control_type: "permit_inhibit",
    active_power_w: 120,
    profile_sample_count: 960,
    forecast_w_by_slot: snapshot.slots.map(() => 800),
  }];

  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  const slot = result.plans.cost.slots[0];
  assert(slot.base_w === 500, "residual base load changed");
  assert(
    slot.device_loads_w["sensor-fridge-energy"] === 800,
    "empirical device forecast was not published in the plan",
  );
  assert(slot.load_w === 1_300, "empirical device load was not simulated");
  assert(
    slot.grid_import_w === 1_300,
    "grid balance ignored the empirical device load",
  );
});

Deno.test("a controlled empirical device is replaced rather than double counted", () => {
  const snapshot = input();
  snapshot.device_models = [{
    key: "water-boiler",
    name: "Water boiler",
    statistic_id: "sensor.water_boiler_energy",
    category: "hot_water",
    suggested_load_type: "duty_cycle",
    load_type: "duty_cycle",
    planning_role: "controllable",
    control_type: "permit_inhibit",
    active_power_w: 3_100,
    profile_sample_count: 1_920,
    forecast_w_by_slot: snapshot.slots.map(() => 350),
  }];

  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  for (const slot of result.plans.baseline.slots) {
    assert(
      slot.device_loads_w["water-boiler"] === slot.boiler_expected_w,
      "controlled boiler was not represented by its empirical device series",
    );
    assert(
      slot.load_w === slot.base_w + slot.pool_w + slot.boiler_expected_w,
      "controlled empirical device was counted twice",
    );
  }
});

Deno.test("snapshot device series must be explicitly controllable", () => {
  const snapshot = input();
  snapshot.device_models = [{
    key: "reviewed-load",
    name: "Reviewed load",
    statistic_id: "sensor.reviewed_load_energy",
    category: "household",
    suggested_load_type: "variable_full_load",
    load_type: "variable_full_load",
    planning_role: "controllable",
    control_type: "switch_schedule",
    active_power_w: 1_000,
    profile_sample_count: 960,
    forecast_w_by_slot: snapshot.slots.map(() => 250),
  }];
  assert(validateSnapshot(snapshot).length === 0, "controllable model was rejected");

  (snapshot.device_models[0] as unknown as { planning_role: string })
    .planning_role = "base_load";
  assert(
    validateSnapshot(snapshot).some((error) => error.includes("device_models[0]")),
    "base-load device leaked into the explicit model list",
  );
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
    ev_battery: {
      name: "Test EV",
      connected: true,
      capacity_kwh: 75,
      soc: 0.6,
      departure_target_soc: 0.7,
      charge_efficiency: 0.94,
      available_from: base.slots[0].start,
      departure: base.slots[48].start,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.ev_connected",
        soc: "sensor.ev_soc",
        target_soc: "number.ev_target_soc",
        energy_remaining: "sensor.ev_energy_remaining",
        charge_current: "number.ev_charge_current",
      },
    },
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
  assert(result.schema_version === 5, "wrong plan schema");
  assert(result.status === "ready", "feasible EV plan was rejected");
  assert(result.ev_battery?.soc === 0.6, "vehicle state was not retained");
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
      assert(slot.ev_soc !== null, "EV SOC projection is missing");
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
    assert(
      (plan.slots.at(-1)?.ev_soc ?? 0) >= 0.7,
      "EV SOC did not reach the requested departure target",
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

Deno.test("existing EV snapshots remain executable while telemetry rolls forward", () => {
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
      id: "ev:legacy",
      device: "ev",
      earliest_start: base.slots[0].start,
      deadline: base.slots[24].start,
      required_kwh: 2,
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
  delete snapshot.ev_battery;

  assert(validateSnapshot(snapshot).length === 0, "legacy EV snapshot was rejected");
  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  assert(result.status === "ready", "legacy EV service stopped planning");
  assert(result.ev_battery === null, "missing telemetry was not normalized");
  assert(
    Object.values(result.plans).every((plan) =>
      plan.slots.every((slot) => slot.ev_soc === null)
    ),
    "legacy EV plan invented battery SOC",
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

  assert(
    validateSnapshot(snapshot).length === 0,
    "optional capabilities rejected",
  );
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

Deno.test("ingestion snapshots are live and never synthetic", () => {
  const demo = input() as unknown as {
    mode: string;
    sources: OptimisationSnapshotV5["sources"];
  };
  demo.mode = "demo";
  demo.sources.base_load.quality = "synthetic";

  const errors = validateSnapshot(demo as OptimisationSnapshotV5);
  assert(errors.includes("mode must be live"), "demo snapshot was accepted");
  assert(
    errors.some((error) => error.includes("sources.base_load is incomplete")),
    "synthetic source was accepted",
  );
});

Deno.test("a truncated final local day is not labelled end-of-solar", () => {
  const snapshot = input();
  snapshot.slots = snapshot.slots.slice(0, 32).map((slot) => ({
    ...slot,
    pv_forecast_w: 0,
  }));
  snapshot.services = [];
  snapshot.capabilities = {
    ...snapshot.capabilities,
    pool: false,
    boiler: false,
  };
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
      id: "pool:first",
      device: "pool",
      earliest_start: snapshot.slots[0].start,
      deadline,
      required_kwh: 1.5,
      control: { type: "fixed_power", power_w: 3_000 },
      min_run_slots: 2,
      priority: 1,
    },
    {
      id: "pool:second",
      device: "pool",
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
    result.plans.priority.slots.every((slot) => slot.pool_w <= 3_000),
    "one pool load was scheduled at two simultaneous power levels",
  );
  assert(
    result.plans.priority.validation_errors.some((error) =>
      error.includes("no feasible contiguous")
    ),
    "the conflicting commitment was not explained",
  );
});
