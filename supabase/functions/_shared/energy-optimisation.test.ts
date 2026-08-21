import {
  generateOptimisationPlan,
  type OptimisationSnapshot,
  validateSnapshot,
} from "./energy-optimisation.ts";
import { projectZoneTemperature } from "./thermal-model.ts";
import { assertEquals } from "jsr:@std/assert@1";

/** The captured_at the shared fixture uses, so a plan is always fresh. */
const NOW = "2026-08-10T07:55:00Z";

const assert: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const input = (
  overrides: Partial<OptimisationSnapshot> = {},
): OptimisationSnapshot => {
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
      battery_export_enabled: false,
      battery_export_reserve_soc: 0.8,
      battery_export_min_price_sek_per_kwh: 2.5,
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

/**
 * A realistic 72-hour horizon: three solar days, the first 24 hours priced and
 * the rest left to the modelled shape, as Nord Pool actually publishes.
 *
 * The default `input()` fixture is 32 slots, which is fine for contract checks
 * and actively misleading for planning ones. Two battery defects survived every
 * test written against it — a covering band sized over the whole horizon and a
 * double-counted wear cost — because neither is visible when the horizon is
 * shorter than a single night. Planner behaviour belongs here.
 */
const horizon = (
  overrides: Partial<OptimisationSnapshot> = {},
  { peakPvW = 9_000, baseLoadW = 1_000, pricedSlots = 96 } = {},
): OptimisationSnapshot => {
  const base = input();
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const slots = Array.from({ length: 288 }, (_value, index) => {
    // The fixture's first slot is 10:00 local, so a day's shape has to be
    // anchored to that rather than to the index.
    const hour = ((index / 4) + 10) % 24;
    const pv = hour >= 6 && hour <= 18
      ? Math.round(peakPvW * Math.sin(((hour - 6) / 12) * Math.PI))
      : 0;
    const priced = index < pricedSlots;
    return {
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: pv,
      base_load_forecast_w: baseLoadW,
      base_load_p10_w: Math.round(baseLoadW * 0.8),
      base_load_p90_w: Math.round(baseLoadW * 1.4),
      // A dear evening against an ordinary day, which is what makes storing and
      // spending distinguishable at all.
      import_price_sek_per_kwh: priced ? (hour >= 17 ? 2.4 : 1.6) : null,
      export_price_sek_per_kwh: priced ? 0.99 : null,
    };
  });
  return input({
    schema_version: 6,
    slots,
    outdoor_temperature_c: slots.map(() => 22),
    battery: base.battery,
    services: [],
    service_requirement_sample_days: {},
    ...overrides,
  });
};

/** A routed charger remains a control contract even when required_kwh is zero. */
const routedEvService = (snapshot: OptimisationSnapshot) => ({
  id: "ev:horizon",
  device: "ev" as const,
  earliest_start: snapshot.slots[0].start,
  deadline: new Date(
    Date.parse(snapshot.slots.at(-1)!.start) + 15 * 60_000,
  ).toISOString(),
  required_kwh: 0,
  control: {
    type: "discrete_current" as const,
    min_current_a: 5,
    max_current_a: 16,
    current_step_a: 1,
    phase_count: 3,
    voltage_v: 230,
  },
  min_run_slots: 2,
  priority: 3,
});

Deno.test("the unpriced tail prefers the hours the shape says are cheap", () => {
  // Before §1.4 every unpriced slot scored `gridW / 100`, so 03:00 and 18:00
  // were indistinguishable and a deferrable load landed on the tie-break.
  const base = input();
  // Raw archive rather than a hand-built shape: there is one estimator and the
  // planner owns it, so a test cannot assert against rules the planner does not
  // use. Fourteen days, expensive 06:00-09:00 and cheap otherwise.
  const archive = Array.from(
    { length: 14 },
    (_day, offset) =>
      Array.from({ length: 96 }, (_quarter, quarter) => ({
        start_ts: new Date(
          Date.parse("2026-07-27T00:00:00+02:00") + offset * 86_400_000 +
            quarter * 900_000,
        ).toISOString(),
        import_price_sek_per_kwh: quarter >= 24 && quarter < 36 ? 3 : 0.5,
      })),
  ).flat();
  const snapshot = input({
    slots: base.slots.map((slot, index) => ({
      ...slot,
      pv_forecast_w: 0,
      // Only the first slot is published, so the level is set and everything
      // after it is priced by the shape.
      import_price_sek_per_kwh: index === 0 ? 1 : null,
      export_price_sek_per_kwh: index === 0 ? 0.1 : null,
    })),
  });

  const prepared = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
    archive,
  );
  const expensive = prepared.plans.priority.slots.filter((slot) => {
    const hour = new Date(slot.start).getUTCHours();
    return hour >= 4 && hour < 7; // 06:00-09:00 Stockholm in summer
  });
  const cheap = prepared.plans.priority.slots.filter((slot) => {
    const hour = new Date(slot.start).getUTCHours();
    return hour >= 22 || hour < 3;
  });
  const mean = (slots: typeof expensive) =>
    slots.reduce((total, slot) => total + slot.grid_import_w, 0) /
    Math.max(1, slots.length);
  assert(
    mean(cheap) >= mean(expensive),
    `the shape should push load out of the expensive band: cheap ${
      mean(cheap).toFixed(0)
    } W vs expensive ${mean(expensive).toFixed(0)} W`,
  );
});

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
    battery_export_enabled: false,
    battery_export_reserve_soc: 0,
    battery_export_min_price_sek_per_kwh: 0,
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

Deno.test("a room heater sharing a service's meter category keeps the service whole", () => {
  // The pool room's floor heater is metered as pool_heating but planned as a
  // room. Sharing the pool service across it left part of the pool's load
  // unaccounted for, because the thermal pass overwrites that meter.
  const base = input();
  const slotCount = base.slots.length;
  const snapshot = input({
    device_models: [
      {
        key: "pool-heater",
        name: "Pool heater",
        statistic_id: "sensor.pool_heater_energy",
        category: "pool_heating",
        suggested_load_type: "fixed_full_load",
        load_type: "fixed_full_load",
        planning_role: "controllable",
        control_type: "switch_schedule",
        active_power_w: 2_000,
        profile_sample_count: 1_000,
        forecast_w_by_slot: base.slots.map(() => 400),
      },
      {
        key: "pool-room-floor-heater",
        name: "Pool room floor heater",
        statistic_id: "sensor.pool_room_floor_heater_energy",
        category: "pool_heating",
        suggested_load_type: "fixed_full_load",
        load_type: "fixed_full_load",
        planning_role: "controllable",
        control_type: "setpoint",
        active_power_w: 800,
        profile_sample_count: 1_000,
        forecast_method: "thermal_comfort_schedule_v1",
        forecast_w_by_slot: base.slots.map(() => 400),
      },
    ],
    outdoor_temperature_c: new Array(slotCount).fill(5),
    thermal_zones: [{
      key: "basement-bathroom",
      name: "Basement bathroom",
      device_keys: ["pool-room-floor-heater"],
      model: {
        gain_c_per_wh: 0.001,
        cooling_constant_per_h: 0.1,
        background_gain_c_per_h: 0,
        thermal_capacity_wh_per_c: 1_000,
        heat_loss_w_per_c: 10,
        time_constant_h: 100,
        heating_rate_c_per_h: 2,
        r2: 0.95,
        residual_std_c: 0.05,
        sample_count: 1_000,
      },
      start_temperature_c: 21,
      rated_power_w: 800,
      comfort_min_c: new Array(slotCount).fill(20),
      target_c: new Array(slotCount).fill(21),
      comfort_max_c: new Array(slotCount).fill(22),
      maximum_power_w_by_slot: new Array(slotCount).fill(800),
      unplanned_power_w: new Array(slotCount).fill(400),
    }],
  });

  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  for (const slot of result.plans.baseline.slots) {
    assert(
      slot.device_loads_w["pool-heater"] === slot.pool_w,
      "the pool service was diluted across a meter planned as a room",
    );
    assert(
      slot.device_loads_w["pool-room-floor-heater"] ===
        (slot.room_heating_w["basement-bathroom"] ?? 0),
      "the room heater did not carry its room's planned power",
    );
  }
});

Deno.test("room comfort is reached by the first comfort quarter and preheat is staggered", () => {
  const base = input();
  const thermalModel = {
    gain_c_per_wh: 0.001,
    cooling_constant_per_h: 0,
    background_gain_c_per_h: 0,
    thermal_capacity_wh_per_c: 1_000,
    heat_loss_w_per_c: 0,
    time_constant_h: 1_000,
    heating_rate_c_per_h: 4,
    r2: 0.95,
    residual_std_c: 0.05,
    sample_count: 1_000,
  };
  const slotCount = base.slots.length;
  const minimum = Array.from(
    { length: slotCount },
    (_, index) => index < 4 ? 18 : 20,
  );
  const unplanned = Array.from(
    { length: slotCount },
    (_, index) => index === 2 || index === 3 ? 4_000 : 0,
  );
  const device = (key: string, name: string) => ({
    key,
    name,
    statistic_id: `sensor.${key}_energy`,
    category: "heating",
    suggested_load_type: "duty_cycle" as const,
    load_type: "duty_cycle" as const,
    planning_role: "controllable" as const,
    control_type: "setpoint" as const,
    active_power_w: 4_000,
    profile_sample_count: 1_000,
    forecast_method: "thermal_comfort_schedule_v1" as const,
    forecast_w_by_slot: [...unplanned],
  });
  const zone = (key: string, name: string, deviceKey: string) => ({
    key,
    name,
    device_keys: [deviceKey],
    model: thermalModel,
    start_temperature_c: 18,
    rated_power_w: 4_000,
    comfort_min_c: [...minimum],
    target_c: [...minimum],
    comfort_max_c: new Array(slotCount).fill(20.5),
    maximum_power_w_by_slot: new Array(slotCount).fill(4_000),
    unplanned_power_w: [...unplanned],
  });
  const snapshot = input({
    capabilities: {
      pv: false,
      battery: false,
      pool: false,
      boiler: false,
      ev: false,
    },
    battery: null,
    sources: { ...base.sources, pv: null, battery: null },
    policy: {
      battery_end_of_solar_target_soc: 0,
      battery_target_is_hard: false,
      terminal_soc_min: 0,
      terminal_energy_value_sek_per_kwh: 0,
      battery_export_enabled: false,
      battery_export_reserve_soc: 0,
      battery_export_min_price_sek_per_kwh: 0,
    },
    slots: base.slots.map((slot) => ({ ...slot, pv_forecast_w: 0 })),
    device_models: [
      device("office-heater", "Office heater"),
      {
        ...device("bedroom-heater", "Bedroom heat pump"),
        category: "cooling",
        control_type: "switch_schedule" as const,
      },
    ],
    services: [],
    service_requirement_sample_days: {},
    outdoor_temperature_c: new Array(slotCount).fill(0),
    thermal_zones: [
      zone("office", "Office", "office-heater"),
      zone("bedroom", "Bedroom", "bedroom-heater"),
    ],
  });

  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  const baseline = result.plans.baseline.slots;
  const priority = result.plans.priority.slots;
  assert(
    baseline.slice(0, 4).some((slot) =>
      Object.values(slot.room_heating_w).some((watts) => watts > 0)
    ),
    "the rooms did not preheat during setback",
  );
  for (const roomKey of ["office", "bedroom"]) {
    const powers = baseline.map((slot) => slot.room_heating_w[roomKey] ?? 0);
    const temperatures = projectZoneTemperature(
      thermalModel,
      18,
      snapshot.outdoor_temperature_c as number[],
      powers,
    );
    assert(
      temperatures[4] >= 19.99,
      `${roomKey} was ${temperatures[4]} C when Comfort began`,
    );
  }
  const peak = (slots: typeof baseline) =>
    Math.max(
      ...slots.map((slot) =>
        Object.values(slot.room_heating_w).reduce(
          (sum, watts) => sum + watts,
          0,
        )
      ),
    );
  assert(
    peak(priority) < peak(baseline),
    `priority did not spread the room peak (${peak(priority)} vs ${
      peak(baseline)
    } W)`,
  );
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
  assert(
    validateSnapshot(snapshot).length === 0,
    "controllable model was rejected",
  );

  (snapshot.device_models[0] as unknown as { planning_role: string })
    .planning_role = "base_load";
  assert(
    validateSnapshot(snapshot).some((error) =>
      error.includes("device_models[0]")
    ),
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
      battery_export_enabled: false,
      battery_export_reserve_soc: 0,
      battery_export_min_price_sek_per_kwh: 0,
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

  const horizonBound = structuredClone(snapshot);
  horizonBound.ev_battery!.departure = null;
  horizonBound.services[0].id = "ev:horizon";
  horizonBound.services[0].deadline = new Date(
    Date.parse(base.slots.at(-1)!.start) + 15 * 60_000,
  ).toISOString();
  assert(
    validateSnapshot(horizonBound).length === 0,
    "connected EV without a departure timestamp was rejected",
  );
  const horizonResult = generateOptimisationPlan(
    horizonBound,
    new Date("2026-08-10T07:55:00Z"),
  );
  assert(
    horizonResult.status === "ready" &&
      Object.values(horizonResult.plans).every((plan) =>
        plan.slots.every((slot) => slot.ev_connected)
      ),
    "horizon-bound EV planning lost its connection window",
  );

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
      battery_export_enabled: false,
      battery_export_reserve_soc: 0,
      battery_export_min_price_sek_per_kwh: 0,
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

  assert(
    validateSnapshot(snapshot).length === 0,
    "legacy EV snapshot was rejected",
  );
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

Deno.test("high-price battery export respects the configured SOC reserve", () => {
  const base = input();
  const snapshot = input({
    capabilities: {
      pv: false,
      battery: true,
      pool: false,
      boiler: false,
      ev: false,
    },
    battery: {
      ...base.battery!,
      soc: 1,
      charge_max_w: 0,
      discharge_max_w: 4_000,
    },
    sources: { ...base.sources, pv: null },
    pv_calibration: {
      correction_factor_by_lead_day: [1, 1, 1, 1],
      sample_count_by_lead_day: [0, 0, 0, 0],
    },
    slots: base.slots.map((slot, index) => ({
      ...slot,
      pv_forecast_w: 0,
      // A spike, then cheap energy to refill from. Export is only worth making
      // when it beats the cost of putting the kWh back (§1.4.5), so the window
      // has to be followed by something cheaper or the planner is right to
      // refuse it — see the companion test below.
      import_price_sek_per_kwh: index < 20 ? (index < 6 ? 3 : 0.5) : null,
      export_price_sek_per_kwh: index < 20
        ? index === 4 || index === 5 ? 2.6 : 1
        : null,
    })),
    policy: {
      ...base.policy,
      battery_end_of_solar_target_soc: 0.05,
      battery_target_is_hard: false,
      battery_export_enabled: true,
      battery_export_reserve_soc: 0.8,
      battery_export_min_price_sek_per_kwh: 2.5,
    },
    device_models: [],
    services: [],
    service_requirement_sample_days: {},
  });

  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  const baseline = result.plans.baseline;
  const planned = result.plans.priority;
  const exportSlots = planned.slots.filter((slot) => slot.battery_export_w > 0);

  assert(result.status === "ready", "battery export made the plan infeasible");
  assert(exportSlots.length === 2, "battery exported outside the price window");
  assert(
    exportSlots.every((slot) =>
      slot.export_price_sek_per_kwh === 2.6 &&
      slot.grid_export_w === slot.battery_export_w &&
      slot.battery_soc + 1e-6 >= 0.8
    ),
    "battery export crossed the configured reserve",
  );
  assert(
    baseline.slots.every((slot) => slot.battery_export_w === 0),
    "the without-plan scenario deliberately exported storage",
  );
  assert(
    planned.summary.net_cost_sek < baseline.summary.net_cost_sek,
    "high-price export did not improve the priced plan",
  );
});

Deno.test("export is refused when refilling costs more than the spike pays", () => {
  // Same shape as the test above, but nothing cheap follows the spike. Selling
  // at 2.6 to buy back at 3 / round-trip loses money on every kWh, and a fixed
  // battery_export_min_price threshold cannot see that (§1.4.5).
  const base = input();
  const snapshot = input({
    capabilities: {
      pv: false,
      battery: true,
      pool: false,
      boiler: false,
      ev: false,
    },
    battery: {
      ...base.battery!,
      soc: 1,
      charge_max_w: 0,
      discharge_max_w: 4_000,
    },
    sources: { ...base.sources, pv: null },
    pv_calibration: {
      correction_factor_by_lead_day: [1, 1, 1, 1],
      sample_count_by_lead_day: [0, 0, 0, 0],
    },
    slots: base.slots.map((slot, index) => ({
      ...slot,
      pv_forecast_w: 0,
      import_price_sek_per_kwh: index < 20 ? 3 : null,
      export_price_sek_per_kwh: index < 20
        ? index === 4 || index === 5 ? 2.6 : 1
        : null,
    })),
    policy: {
      ...base.policy,
      battery_end_of_solar_target_soc: 0.05,
      battery_target_is_hard: false,
      battery_export_enabled: true,
      battery_export_reserve_soc: 0.8,
      // Low enough that the old fixed threshold would have exported.
      battery_export_min_price_sek_per_kwh: 2.5,
    },
    device_models: [],
    services: [],
    service_requirement_sample_days: {},
  });

  const planned = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  ).plans.priority;
  assert(
    planned.slots.every((slot) => slot.battery_export_w === 0),
    "sold stored energy below the cost of replacing it",
  );
});

Deno.test("surplus solar makes stored energy free to replace", () => {
  // The mirror case: the same unprofitable-looking spike becomes worth taking
  // when tomorrow's forecast will refill the battery anyway, because that
  // energy would otherwise have been exported or curtailed regardless.
  const base = input();
  const snapshot = input({
    battery: {
      ...base.battery!,
      soc: 1,
      charge_max_w: 0,
      discharge_max_w: 4_000,
    },
    slots: base.slots.map((slot, index) => ({
      ...slot,
      // Far more surplus than the battery can hold, later in the horizon.
      pv_forecast_w: index > 30 ? 20_000 : 0,
      import_price_sek_per_kwh: index < 20 ? 3 : null,
      export_price_sek_per_kwh: index < 20
        ? index === 4 || index === 5 ? 2.6 : 1
        : null,
    })),
    policy: {
      ...base.policy,
      battery_end_of_solar_target_soc: 0.05,
      battery_target_is_hard: false,
      battery_export_enabled: true,
      battery_export_reserve_soc: 0.8,
      battery_export_min_price_sek_per_kwh: 2.5,
    },
    device_models: [],
    services: [],
    service_requirement_sample_days: {},
  });

  const planned = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  ).plans.priority;
  assert(
    planned.slots.some((slot) => slot.battery_export_w > 0),
    "refused a spike the sun was going to refill for free",
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
      battery_export_enabled: false,
      battery_export_reserve_soc: 0,
      battery_export_min_price_sek_per_kwh: 0,
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
    sources: OptimisationSnapshot["sources"];
  };
  demo.mode = "demo";
  demo.sources.base_load.quality = "synthetic";

  const errors = validateSnapshot(demo as OptimisationSnapshot);
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

Deno.test("a schema 5 snapshot keeps the planner it was built for", () => {
  // The rollout rule: an installation that cannot send pool state is never
  // handed a plan that assumes it. Both planners are live at once.
  const plan = generateOptimisationPlan(input(), new Date(NOW));

  assertEquals(plan.schema_version, 5);
  assertEquals(plan.model_version, "thermal-room-planner-v8");
});

Deno.test("schema 6 with pool state dispatches by temperature, not by budget", () => {
  const base = input();
  const snapshot = input({
    schema_version: 6,
    // Cold water: worth heating. The daily `required_kwh` below is deliberately
    // left at 2 kWh to prove it is no longer what sizes the load.
    pool: { water_temperature_c: 23, volume_m3: 55 },
    outdoor_temperature_c: base.slots.map(() => 22),
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));

  assertEquals(plan.schema_version, 6);
  assertEquals(plan.model_version, "marginal-value-planner-v11");
  // Asserted explicitly: an earlier version of this test checked the pool
  // energy but not the status, and so passed while every schema 6 plan was
  // reported infeasible by validations that still assumed fixed blocks.
  assertEquals(plan.validation_errors, []);
  assertEquals(plan.status, "ready");
  const priority = plan.plans.priority;
  const poolKwh = priority.slots.reduce(
    (total, slot) => total + slot.pool_w / 1_000 * 0.25,
    0,
  );
  assert(
    poolKwh > 2.5,
    `a 23 °C pool needs far more than its old 2 kWh budget, got ${poolKwh}`,
  );
  // And there are no per-service blocks any more, because there are no blocks.
  assertEquals(priority.service_slots["pool:2026-08-10"], []);
});

Deno.test("schema 6 leaves an already-warm pool alone", () => {
  const base = input();
  const snapshot = input({
    schema_version: 6,
    pool: { water_temperature_c: 31, volume_m3: 55 },
    outdoor_temperature_c: base.slots.map(() => 22),
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.status, "ready");
  const poolW = plan.plans.priority.slots.reduce(
    (total, slot) => total + slot.pool_w,
    0,
  );

  assertEquals(
    poolW,
    0,
    "the old planner demanded its daily kWh whatever the water temperature",
  );
});

Deno.test("schema 6 without pool state falls back rather than guessing", () => {
  const snapshot = input({ schema_version: 6 });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));

  // No measured state means no store, so the whole plan stays on the model it
  // can actually support rather than mixing a temperature with a budget.
  assertEquals(
    plan.plans.priority.service_slots["pool:2026-08-10"].length > 0,
    true,
  );
});

Deno.test("schema 6 lets the dispatch own the battery, and simulate follows", () => {
  // The 72-hour fixture, because the battery is sized against one night's draw
  // and a horizon shorter than a night has no night in it to measure.
  const snapshot = horizon({
    pool: { water_temperature_c: 29, volume_m3: 55 },
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));

  assertEquals(plan.status, "ready");
  // Conservation is still checked every slot; an unfollowed schedule would
  // show up here as an energy-balance error rather than passing quietly.
  assertEquals(plan.validation_errors, []);
  const priority = plan.plans.priority;
  for (const slot of priority.slots) {
    assert(
      slot.battery_soc >= snapshot.battery!.min_soc - 1e-6 &&
        slot.battery_soc <= snapshot.battery!.max_soc + 1e-6,
      `SOC ${slot.battery_soc} left its bounds`,
    );
  }
  assert(
    priority.slots.some((slot) => slot.battery_charge_w > 0),
    "surplus should still reach the battery once the sinks are satisfied",
  );
});

Deno.test("a hard battery target is not enforced once the curve prices it", () => {
  const base = input();
  const snapshot = input({
    schema_version: 6,
    pool: { water_temperature_c: 23, volume_m3: 55 },
    outdoor_temperature_c: base.slots.map(() => 22),
    policy: { ...base.policy, battery_target_is_hard: true },
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));

  // §8.4 deletes the setting rather than answering it. Enforcing a target on
  // top of the marginal-value comparison would override the thing that
  // replaced it.
  assertEquals(
    plan.validation_errors.filter((error) => error.includes("battery target")),
    [],
  );
});

Deno.test("a full battery spends into a dear evening and refills from surplus", () => {
  // A 72-hour horizon, which is where both of these defects lived and where a
  // 32-slot fixture cannot see them:
  //
  //  - `expectedDrawKwh` summed the draw over the whole horizon, so the
  //    covering band swallowed the entire pack and every stored kWh was priced
  //    at the dearest import in three days. The battery hoarded charge through
  //    expensive evenings and imported instead.
  //  - degradation was subtracted from the derived curve *and* charged again as
  //    a flow cost, so charging was unprofitable at any price the curve would
  //    accept. Once discharged the battery never refilled, and surplus was
  //    exported past a half-empty pack.
  const base = input();
  const snapshot = horizon({
    pool: { water_temperature_c: 26, volume_m3: 55 },
    battery: { ...base.battery!, soc: 1.0 },
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.status, "ready");
  const planned = plan.plans.priority.slots;
  const total = (read: (slot: typeof planned[number]) => number) =>
    planned.reduce((sum, slot) => sum + read(slot), 0) / 4_000;

  assert(
    total((slot) => slot.battery_discharge_w) > 5,
    "a full battery must spend into a 2.4 SEK evening, not import beside it",
  );
  assert(
    total((slot) => slot.battery_charge_w) > 5,
    "and must refill from surplus rather than sit flat while it is exported",
  );
  // The symptom as it appeared in a real plan: state of charge pinned at 100%
  // straight through an expensive evening while grid import rose beside it.
  // Ending the horizon full is *not* a defect — with surplus to spare, the
  // terminal value says a full pack is worth having — so the assertion is about
  // the evening, not the edge.
  const firstEvening = planned.slice(28, 48);
  assert(
    Math.min(...firstEvening.map((slot) => slot.battery_soc)) < 0.9,
    "the pack must be spent through the dear evening, not held at full",
  );
  assert(
    firstEvening.every((slot) =>
      slot.grid_import_w < 1 || slot.battery_soc <= 0.66
    ),
    "importing while a nearly full battery sits idle is the defect",
  );
});

Deno.test("the battery only grid-charges the import spike and leaves room for solar", () => {
  // One expensive quarter sits inside a long cheap deficit run before the next
  // solar day. The old two-level curve valued the whole run at that quarter's
  // price: it filled the pack from the grid, then had no room for the sun. The
  // merit-order curve should buy only the energy needed for the spike and stop.
  const base = horizon();
  const firstSolarSlot = 80;
  const spikeSlot = 40;
  const slots = base.slots.map((slot, index) => ({
    ...slot,
    pv_forecast_w: index < firstSolarSlot ? 0 : slot.pv_forecast_w,
    import_price_sek_per_kwh: index === spikeSlot ? 2.4 : 0.6,
    export_price_sek_per_kwh: 0.1,
  }));
  const snapshot = horizon({
    slots,
    pool: { water_temperature_c: 31, volume_m3: 55 },
    battery: { ...base.battery!, soc: base.battery!.min_soc },
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.status, "ready");
  assertEquals(plan.validation_errors, []);
  const planned = plan.plans.priority.slots;
  const kwh = (values: number[]) =>
    values.reduce((sum, watts) => sum + watts, 0) / 4_000;
  const gridChargeKwh = kwh(
    planned.slice(0, firstSolarSlot).map((slot) => slot.battery_charge_w),
  );
  const solarChargeKwh = kwh(
    planned.slice(firstSolarSlot).map((slot) =>
      Math.min(slot.battery_charge_w, Math.max(0, slot.pv_w - slot.load_w))
    ),
  );

  assert(
    gridChargeKwh > 0 && gridChargeKwh <= 0.35,
    `the 0.25 kWh spike caused ${
      gridChargeKwh.toFixed(2)
    } kWh of grid charging`,
  );
  assert(
    solarChargeKwh > 5,
    `only ${
      solarChargeKwh.toFixed(2)
    } kWh of the following surplus reached the battery`,
  );
});

Deno.test("a half-charged car takes surplus rather than letting it be exported", () => {
  // Observed in a real plan: a Model Y at 55% declined every kWh of a sunny
  // 72-hour forecast and 30 kWh a day was exported instead. The car was not
  // being outbid — its curve valued the middle of its own range at less than
  // the export price, so nothing could have won it.
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 31, volume_m3: 55 },
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Model Y",
      connected: true,
      capacity_kwh: 75,
      soc: 0.55,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      available_from: base.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.charge_cable",
        soc: "sensor.battery_level",
        target_soc: "number.charge_limit",
        energy_remaining: null,
        charge_current: "number.charge_current",
      },
    },
    services: [routedEvService(base)],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.validation_errors, []);
  const charged = plan.plans.priority.slots.reduce(
    (total, slot) => total + slot.ev_w,
    0,
  ) / 4_000;

  assert(
    charged > 2,
    `a car below its own charge limit must take free surplus, got ${charged} kWh`,
  );
});

Deno.test("schema 6 never invents a charger control for a connected EV", () => {
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 31, volume_m3: 55 },
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Legacy EV",
      connected: true,
      capacity_kwh: 75,
      soc: 0.55,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      available_from: base.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.charge_cable",
        soc: "sensor.battery_level",
        target_soc: "number.charge_limit",
        energy_remaining: null,
        charge_current: "number.charge_current",
      },
    },
    services: [],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));

  assertEquals(plan.status, "ready");
  for (const scenario of Object.values(plan.plans)) {
    assertEquals(scenario.dispatched_devices.includes("ev"), false);
    assertEquals(scenario.slots.some((slot) => slot.ev_w > 0), false);
    assertEquals(
      scenario.slots.some((slot) =>
        slot.ev_min_current_a > 0 || slot.ev_max_current_a > 0
      ),
      false,
    );
  }
});

Deno.test("the car's own charge limit caps what the plan buys for it", () => {
  // Observed at 160% planned SOC across three consecutive replays: the store
  // had no ceiling, so `chargeRoomW` returned Infinity and the auction kept
  // buying range the car will refuse. `ev_soc` clamps at 1 in the energy
  // balance, so the fault was invisible in the published series — only the
  // km state and the charging power showed it.
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 31, volume_m3: 55 },
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Model Y",
      connected: true,
      capacity_kwh: 75,
      soc: 0.55,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      available_from: base.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.charge_cable",
        soc: "sensor.battery_level",
        target_soc: "number.charge_limit",
        energy_remaining: null,
        charge_current: "number.charge_current",
      },
    },
    services: [routedEvService(base)],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.validation_errors, []);
  const charged = plan.plans.priority.slots.reduce(
    (total, slot) => total + slot.ev_w,
    0,
  ) / 4_000;
  // Wall energy that reaches 80% from 55%: 0.25 * 75 / 0.92.
  const deliverable = 0.25 * 75 / 0.92;

  assert(
    charged <= deliverable + 1e-6,
    `the car stops accepting charge at its limit, so the plan must not buy past ${
      deliverable.toFixed(2)
    } kWh, got ${charged.toFixed(2)} kWh`,
  );
  assert(
    charged > deliverable - 1,
    `a limit is a ceiling, not a reason to decline cheap energy, got ${
      charged.toFixed(2)
    } kWh`,
  );
});

Deno.test("a car past its charge limit leaves the surplus alone", () => {
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 31, volume_m3: 55 },
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Model Y",
      connected: true,
      capacity_kwh: 75,
      soc: 0.99,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      available_from: base.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.charge_cable",
        soc: "sensor.battery_level",
        target_soc: "number.charge_limit",
        energy_remaining: null,
        charge_current: "number.charge_current",
      },
    },
    services: [routedEvService(base)],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  const charged = plan.plans.priority.slots.reduce(
    (total, slot) => total + slot.ev_w,
    0,
  ) / 4_000;

  assert(
    charged < 0.5,
    `a car already past its limit has no room left to sell into, got ${charged} kWh`,
  );
});

Deno.test("every allocation is priced where it lands, and none of them loses", () => {
  // The auction values each move against the trajectory as it stood when that
  // move won, and every later allocation shifts the trajectory underneath it.
  // Two things must hold once the plan is settled: the state an allocation
  // records is the state the plan executes, and nothing survives that does not
  // pay for itself there. Observed failing: a battery charge booked at
  // 1.648 SEK/kWh against a projected 1.01 kWh state, executed at 6.09 kWh
  // where the same energy is worth 0.695, bought at 1.169.
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 28.4, volume_m3: 55 },
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Tesla Model Y",
      connected: true,
      capacity_kwh: 77.25,
      soc: 0.56,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      available_from: base.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.cable",
        soc: "sensor.level",
        target_soc: "number.limit",
        energy_remaining: null,
        charge_current: "number.current",
      },
    },
    services: [routedEvService(base)],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.validation_errors, []);

  const losing: string[] = [];
  const misstated: string[] = [];
  let allocations = 0;
  for (const slot of plan.plans.priority.slots) {
    const battery = slot.decision.battery;
    for (const part of slot.decision.store_allocations) {
      allocations += 1;
      // A minimum-run block clears its cost as a block: a heat pump that must
      // run four quarters cannot stop three in, so the run is the unit that
      // has to pay, not every quarter inside it.
      if (part.run_net_value_sek < -1e-6) {
        losing.push(
          `${part.store_key} ${part.direction} run from ${part.run_start_index}: ${
            part.run_net_value_sek.toFixed(4)
          } SEK`,
        );
      }
      // The battery publishes the executed trajectory beside the allocation's
      // own record, so the two disagreeing is the defect made visible.
      if (
        part.store_key === "battery" && battery &&
        Math.abs(part.state_before - battery.state_before) > 1e-6
      ) {
        misstated.push(
          `${slot.start}: booked at ${part.state_before.toFixed(4)} kWh, ran at ${
            battery.state_before.toFixed(4)
          } kWh`,
        );
      }
    }
  }

  assert(allocations > 20, `expected a busy plan, got ${allocations} allocations`);
  assertEquals(
    misstated.slice(0, 3),
    [],
    "an allocation must record the state the plan executes",
  );
  assertEquals(
    losing.slice(0, 3),
    [],
    "a settled plan holds nothing that loses money where it lands",
  );
});

Deno.test("the plan explains why each store bought what it did", () => {
  // A pool one degree above the top of its own curve is right to do nothing.
  // Establishing that previously meant querying the database for the snapshot
  // and re-running the planner locally, because the plan said only that it was
  // valid. It now carries the comparison that produced the outcome.
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 30.15, volume_m3: 55 },
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Tesla Model Y",
      connected: true,
      capacity_kwh: 77.25,
      soc: 0.56,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      available_from: base.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.cable",
        soc: "sensor.level",
        target_soc: "number.limit",
        energy_remaining: null,
        charge_current: "number.current",
      },
    },
    services: [routedEvService(base)],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  const byKey = new Map(
    plan.plans.priority.store_diagnostics.map((entry) => [entry.key, entry]),
  );

  const pool = byKey.get("pool")!;
  assertEquals(pool.planned_kwh, 0);
  assertEquals(pool.unit, "celsius");
  assertEquals(pool.state, 30.15);
  // Just past the top breakpoint the pool is worth a little rather than
  // nothing — the interpolated curve declines to zero at 31 °C instead of
  // falling off a step at 30 — so the honest reason is that what it is worth
  // does not clear the price, not that it is full.
  assertEquals(pool.reason, "value_below_price");
  assert(
    pool.marginal_value_sek_per_kwh > 0,
    "a pool just past its band is worth a little, not nothing",
  );
  assert(
    pool.marginal_value_sek_per_kwh < pool.cheapest_energy_sek_per_kwh,
    "a store declines when the cheapest energy costs more than it values",
  );

  // And a car below its own charge limit says the opposite, in the same units.
  const ev = byKey.get("ev")!;
  assertEquals(ev.reason, "scheduled");
  assert(ev.planned_kwh > 0, "a car below its charge limit takes energy");
  assert(
    ev.marginal_value_sek_per_kwh > ev.cheapest_energy_sek_per_kwh,
    "a store buys when its value beats the cheapest energy it could have used",
  );
});

Deno.test("a fitted pool model replaces the seeded loss and COP", () => {
  const base = horizon({ pool: { water_temperature_c: 27, volume_m3: 55 } });
  // A leakier pool with a worse pump than the seeded assumption. If the fit
  // were ignored the two plans would be identical.
  const fitted = horizon({
    pool: { water_temperature_c: 27, volume_m3: 55 },
    pool_model: { loss_kw_per_k: 1.2, rated_cop: 2.4, cop_per_air_c: 0.045 },
  });

  const seededPlan = generateOptimisationPlan(base, new Date(NOW));
  const fittedPlan = generateOptimisationPlan(fitted, new Date(NOW));
  assertEquals(fittedPlan.status, "ready");

  const poolKwh = (plan: typeof seededPlan) =>
    plan.plans.priority.slots.reduce((total, slot) => total + slot.pool_w, 0) /
    4_000;

  assert(
    Math.abs(poolKwh(fittedPlan) - poolKwh(seededPlan)) > 0.5,
    "a measured pool must not be planned as though it were the assumed one",
  );
  // A worse COP means each kWh buys less warmth, so the same degree is worth
  // fewer SEK per kWh of electricity.
  const value = (plan: typeof seededPlan) =>
    plan.plans.priority.store_diagnostics
      .find((entry) => entry.key === "pool")!.marginal_value_sek_per_kwh;
  assert(
    value(fittedPlan) < value(seededPlan),
    "a poorer pump lowers what a kWh is worth to the pool",
  );
});

Deno.test("a store the planner never saw says so instead of vanishing", () => {
  // The failure this exists to stop: a car connected below its own charge
  // limit, whose meter the website left in base load. `capabilities.ev` goes
  // false, no store is built, no bid is made, and the plan reports "ready"
  // with no errors — indistinguishable from a household that owns no car.
  const snapshot = horizon({
    capabilities: {
      pv: true,
      battery: true,
      pool: true,
      boiler: false,
      ev: false,
    },
    pool: { water_temperature_c: 26.5, volume_m3: 55 },
    ev_battery: {
      name: "Model Y",
      connected: true,
      capacity_kwh: 76.87,
      soc: 0.67,
      departure_target_soc: 0.8,
      charge_efficiency: 0.9,
      available_from: "2026-08-10T08:00:00.000Z",
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.cable",
        soc: "sensor.soc",
        target_soc: "number.limit",
        energy_remaining: null,
        charge_current: null,
      },
    },
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  const byKey = new Map(
    plan.plans.priority.store_diagnostics.map((entry) => [entry.key, entry]),
  );

  const ev = byKey.get("ev");
  assert(
    ev !== undefined,
    "a connected vehicle must appear in the diagnostics",
  );
  assertEquals(ev.reason, "not_controllable");
  assertEquals(ev.planned_kwh, 0);
  // Null rather than zero: never considered is not the same claim as worth
  // nothing, and only one of them points at a setting to change.
  assertEquals(ev.marginal_value_sek_per_kwh, null);
  assert(
    ev.state !== null && ev.state > 0,
    "range is reported in the curve's units",
  );

  // The pool is routed, so it still reports a real comparison alongside it.
  const pool = byKey.get("pool")!;
  assertEquals(pool.reason, "scheduled");
  assert(
    pool.marginal_value_sek_per_kwh !== null,
    "a routed store reports what it was worth",
  );
});

Deno.test("an unplugged car is reported as unplugged, not as unwanted", () => {
  const snapshot = horizon({
    capabilities: {
      pv: true,
      battery: true,
      pool: false,
      boiler: false,
      ev: true,
    },
    ev_battery: {
      name: "Model Y",
      connected: false,
      capacity_kwh: 76.87,
      soc: 0.4,
      departure_target_soc: 0.8,
      charge_efficiency: 0.9,
      available_from: null,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.cable",
        soc: "sensor.soc",
        target_soc: "number.limit",
        energy_remaining: null,
        charge_current: null,
      },
    },
  });

  const ev = generateOptimisationPlan(snapshot, new Date(NOW))
    .plans.priority.store_diagnostics.find((entry) => entry.key === "ev")!;
  assertEquals(ev.reason, "disconnected");
});

Deno.test("a home without the equipment stays silent about it", () => {
  // Evidence, not capability: no pool state and no vehicle means no rows, so
  // the table never invents services a household does not own.
  const keys = generateOptimisationPlan(
    horizon({
      capabilities: {
        pv: true,
        battery: true,
        pool: false,
        boiler: false,
        ev: false,
      },
      pool: null,
      ev_battery: null,
    }),
    new Date(NOW),
  ).plans.priority.store_diagnostics.map((entry) => entry.key);
  assertEquals(keys.includes("pool"), false);
  assertEquals(keys.includes("ev"), false);
});

Deno.test("a single-phase charger is planned at the power its cable delivers", () => {
  // The defect this pins: the planner assumed three 230 V phases regardless of
  // what the installation declared, so a single-phase 16 A charger — 3.7 kW —
  // was dispatched as an 11 kW load. Nothing failed; the plan was simply wrong
  // about how fast the car could fill, and confidently so.
  const vehicle = {
    name: "Model Y",
    connected: true,
    capacity_kwh: 76.87,
    soc: 0.3,
    departure_target_soc: 0.8,
    charge_efficiency: 0.9,
    available_from: "2026-08-10T08:00:00.000Z",
    departure: null,
    priority: 3,
    source_entity_ids: {
      connected: "binary_sensor.cable",
      soc: "sensor.soc",
      target_soc: "number.limit",
      energy_remaining: null,
      charge_current: "number.current",
    },
  };
  const service = (phases: number) => ({
    id: "ev:2026-08-12",
    device: "ev" as const,
    earliest_start: "2026-08-10T08:00:00.000Z",
    deadline: "2026-08-12T08:00:00.000Z",
    required_kwh: 25,
    control: {
      type: "discrete_current" as const,
      min_current_a: 6,
      max_current_a: 16,
      current_step_a: 1,
      phase_count: phases,
      voltage_v: 230,
    },
    min_run_slots: 1,
    priority: 3,
  });
  const peak = (phases: number) => {
    const plan = generateOptimisationPlan(
      horizon({
        capabilities: {
          pv: true,
          battery: true,
          pool: false,
          boiler: false,
          ev: true,
        },
        pool: null,
        ev_battery: vehicle,
        services: [service(phases)],
      }),
      new Date(NOW),
    );
    return Math.max(...plan.plans.priority.slots.map((slot) => slot.ev_w));
  };

  const single = peak(1);
  const three = peak(3);
  assert(single > 0, "a single-phase charger must still charge");
  assert(
    single <= 230 * 16 + 1,
    `a single-phase 16 A cable delivers 3.7 kW, planned ${single} W`,
  );
  assert(
    three > single * 2,
    `three phases must plan more power than one: ${single} vs ${three}`,
  );
});

Deno.test("the vehicle's own consumption decides what its charge is worth", () => {
  // kWh/km converts state of charge into the range the curve is defined over,
  // so a seeded figure is a guess about somebody else's car. A thirstier car
  // has less range at the same SOC, which is worth more, not less.
  const base = {
    name: "Model Y",
    connected: true,
    capacity_kwh: 76.87,
    soc: 0.5,
    departure_target_soc: 0.8,
    charge_efficiency: 0.9,
    available_from: "2026-08-10T08:00:00.000Z",
    departure: null,
    priority: 3,
    source_entity_ids: {
      connected: "binary_sensor.cable",
      soc: "sensor.soc",
      target_soc: "number.limit",
      energy_remaining: null,
      charge_current: null,
    },
  };
  const stateFor = (kwhPerKm: number) =>
    generateOptimisationPlan(
      horizon({
        capabilities: {
          pv: true,
          battery: true,
          pool: false,
          boiler: false,
          ev: true,
        },
        pool: null,
        ev_battery: { ...base, kwh_per_km: kwhPerKm },
      }),
      new Date(NOW),
    ).plans.priority.store_diagnostics.find((entry) => entry.key === "ev")!;

  const efficient = stateFor(0.14);
  const thirsty = stateFor(0.24);
  assert(
    efficient.state! > thirsty.state!,
    `the same charge is more range in the efficient car: ${efficient.state} vs ${thirsty.state}`,
  );
});

Deno.test("the live EV dispatch uses the configured demand-value curve", () => {
  const vehicle = {
    name: "Model Y",
    connected: true,
    capacity_kwh: 76.87,
    soc: 0.2,
    departure_target_soc: 0.8,
    charge_efficiency: 0.9,
    kwh_per_km: 0.18,
    available_from: "2026-08-10T08:00:00.000Z",
    departure: null,
    priority: 3,
    source_entity_ids: {
      connected: "binary_sensor.cable",
      soc: "sensor.soc",
      target_soc: "number.limit",
      energy_remaining: null,
      charge_current: "number.current",
    },
  };
  const base = horizon({
    capabilities: {
      pv: true,
      battery: true,
      pool: false,
      boiler: false,
      ev: true,
    },
    pool: null,
    ev_battery: vehicle,
  });
  const service = routedEvService(base);
  const scheduled = (value_curves?: OptimisationSnapshot["value_curves"]) =>
    generateOptimisationPlan(
      { ...base, services: [service], value_curves },
      new Date(NOW),
    ).plans.priority.slots.reduce((sum, slot) => sum + slot.ev_w, 0);

  assert(
    scheduled() > 0,
    "the default curve must charge an empty connected car",
  );
  assertEquals(
    scheduled({
      ev: {
        unit: "km",
        points: [{ at: 1_000, sek_per_unit: 0 }],
      },
    }),
    0,
  );
});

Deno.test("every planned quarter records decision evidence and exact grid arithmetic", () => {
  const snapshot = horizon({
    capabilities: {
      pv: true,
      battery: true,
      pool: false,
      boiler: false,
      ev: false,
    },
    pool: null,
  });
  const archiveStart = Date.parse("2026-08-08T22:00:00.000Z");
  const archive = Array.from({ length: 96 }, (_value, index) => ({
    start_ts: new Date(archiveStart + index * 15 * 60_000).toISOString(),
    import_price_sek_per_kwh: index >= 68 && index < 80 ? 4.2 : 0.7,
  }));
  const plan = generateOptimisationPlan(snapshot, new Date(NOW), archive);
  const slots = plan.plans.priority.slots;

  assertEquals(plan.decision_diagnostics_version, 2);
  const batteryCurve = plan.battery_value_curve;
  assert(batteryCurve !== null, "the derived battery curve must be published");
  assertEquals(batteryCurve.schema_version, 1);
  assertEquals(batteryCurve.state_basis, "usable_kwh_above_min_soc");
  assertEquals(batteryCurve.curve.unit, "kwh");
  assert(batteryCurve.curve.points.length > 2, "curve breakpoints are required");
  assert(
    Math.abs(
      batteryCurve.covering_window.reduce(
        (sum, slice) => sum + slice.battery_energy_kwh,
        0,
      ) - batteryCurve.curve_input.expected_draw_kwh,
    ) < 1e-6,
    "published covering slices must reproduce the curve input",
  );
  assertEquals(
    generateOptimisationPlan(snapshot, new Date(NOW), [], plan.price_outlook),
    plan,
    "snapshot, solve time and resolved outlook must replay bit for bit",
  );
  assert(
    slots.some((slot) => slot.decision.store_allocations.length > 0),
    "the fixture must expose at least one accepted curve allocation",
  );
  for (const slot of slots) {
    assertEquals(slot.decision.schema_version, 1);
    assert(slot.decision.battery !== null, "battery evidence is required");
    const balance = slot.decision.grid_balance;
    const residual = balance.load_w + balance.battery_charge_w - balance.pv_w -
      balance.battery_discharge_w;
    assert(
      Math.abs(residual - balance.residual_w) < 0.05,
      `${slot.start}: recorded residual does not match its operands`,
    );
  }
});
