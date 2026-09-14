import {
  generateOptimisationPlan,
  dispatchWorkbench,
  type OptimisationSnapshot,
  validateSnapshot,
} from "./energy-optimisation.ts";
import { projectZoneTemperature } from "./thermal-model.ts";
import { DEFAULT_VALUE_SETTINGS } from "./value-curves.ts";
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";

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
/**
 * A wear cost pinned by the fixture rather than inherited.
 *
 * Three tests below turn on the battery declining a round trip, and the shipped
 * default is a product figure that moves with the packs being sold (it fell
 * from 0.45 to 0.05 when the first calendar-limited pack was measured). A
 * behavioural test that reads it silently changes what it asserts, so each of
 * them states the wear it means.
 */
const PRICED_WEAR = { battery_degradation_sek_per_kwh: 0.45 } as const;

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

  priority: 3,
});

Deno.test("a new pool is dispatched at its declared power without a historical budget", () => {
  const snapshot = horizon({
    capabilities: { pv: true, battery: true, pool: true, boiler: false, ev: false },
    pool: { water_temperature_c: 24, volume_m3: 55 },
  });
  snapshot.services = [{
    id: "pool:horizon",
    device: "pool",
    earliest_start: snapshot.slots[0].start,
    deadline: new Date(Date.parse(snapshot.slots.at(-1)!.start) + 15 * 60_000)
      .toISOString(),
    required_kwh: 0,
    control: { type: "fixed_power", power_w: 772 },
    priority: 2,
  }];
  snapshot.device_models = [{
    key: "pool-heater", name: "Pool heater", statistic_id: "sensor.pool_energy",
    category: "pool_heating", planning_service: "pool", suggested_load_type: "fixed_full_load",
    load_type: "fixed_full_load", planning_role: "controllable",
    control_type: "switch_schedule", active_power_w: 772,
    profile_sample_count: 0,
    forecast_w_by_slot: snapshot.slots.map(() => 0),
  }];
  // A new meter makes residual subtraction estimated. The household source
  // is still measured recorder data, not a synthetic/demo source.
  snapshot.sources.base_load = {
    ...snapshot.sources.base_load,
    quality: "measured",
    sample_count: 960,
    estimated_sample_count: 960,
  };
  assertEquals(validateSnapshot(snapshot), []);
  const generated = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(generated.sources.base_load.estimated_sample_count, 960);
  const plan = generated.plans.priority;
  assertEquals(plan.status, "ready");
  assert(plan.slots.some((slot) => slot.pool_w === 772), "new pool was never scheduled");
  assert(plan.slots.every((slot) => slot.pool_w === 0 || slot.pool_w === 772),
    "the declared relay power was lost");
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

Deno.test("hot water stays permitted beside planned loads when the connection has room", () => {
  const result = generateOptimisationPlan(
    input(),
    new Date("2026-08-10T07:55:00Z"),
  );
  const baseline = result.plans.baseline;
  const planned = result.plans.priority;
  const inhibited = planned.service_inhibited_slots["boiler:2026-08-10"];
  assert(
    inhibited.length === 0,
    "spare connection capacity must not trigger thermostat interruptions",
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

Deno.test("the battery covers the boiler too, not just the base load", () => {
  // The battery sized every discharge against `fixed_load_w + occupiedW - pv`,
  // and the duty-cycle boiler is in none of those terms — it is written into
  // the schedule after the auction has closed. So the battery covered the
  // house and stopped, and the grid covered the hot water at any price. One
  // observed quarter discharged 149 W (exactly base minus PV) while importing
  // the boiler's 1969 W at 3.281 SEK/kWh with 14.4 kWh in the battery.
  const base = input();
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const slots = Array.from({ length: 288 }, (_value, index) => ({
    start: new Date(start + index * 15 * 60_000).toISOString(),
    pv_forecast_w: 0,
    base_load_forecast_w: 800,
    base_load_p10_w: 600,
    base_load_p90_w: 1_100,
    // Dear now against a cheap replacement later, which is what makes the
    // stored energy worth spending rather than holding.
    import_price_sek_per_kwh: index < 96 ? (index < 40 ? 3.3 : 0.5) : null,
    export_price_sek_per_kwh: index < 96 ? (index < 40 ? 0.4 : 0.1) : null,
  }));
  const snapshot = input({
    schema_version: 6,
    slots,
    outdoor_temperature_c: slots.map(() => 22),
    capabilities: {
      pv: false,
      battery: true,
      pool: false,
      boiler: true,
      ev: false,
    },
    battery: { ...base.battery, soc: 0.95 },
    pool: null,
    sources: { ...base.sources, pv: null },
    pv_calibration: {
      correction_factor_by_lead_day: [1, 1, 1, 1],
      sample_count_by_lead_day: [0, 0, 0, 0],
    },
    service_requirement_sample_days: {},
    services: [
      {
        id: "boiler:horizon",
        device: "boiler" as const,
        earliest_start: slots[0].start,
        deadline: new Date(start + 96 * 15 * 60_000).toISOString(),
        required_kwh: 6,
        priority: 1,
        control: {
          type: "duty_cycle" as const,
          rated_power_w: 3_000,
          expected_power_w_by_slot: slots.map(() => 900),
          max_consecutive_inhibit_slots: 20,
        },
      },
    ],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.validation_errors, []);

  // A battery may stop part way through a quarter because the charge it still
  // holds is worth more than the price — that is the curve doing its job. What
  // it may not do is stop exactly at the base load every time, which is the
  // fingerprint of sizing against a deficit the boiler was never in.
  const cappedAtBase: string[] = [];
  let coversBoiler = 0;
  for (const slot of plan.plans.priority.slots) {
    if (slot.boiler_expected_w <= 1 || slot.battery_discharge_w <= 1) continue;
    const houseOnlyW = slot.base_w - slot.pv_w;
    if (Math.abs(slot.battery_discharge_w - houseOnlyW) < 1) {
      cappedAtBase.push(
        `${slot.start}: discharged ${slot.battery_discharge_w.toFixed(0)} W, ` +
          `exactly base minus PV, while importing the boiler's ${
            slot.grid_import_w.toFixed(0)
          } W`,
      );
    }
    if (slot.battery_discharge_w > houseOnlyW + 1) coversBoiler += 1;
  }
  assertEquals(
    cappedAtBase.slice(0, 3),
    [],
    "a discharge must not stop at the base load while the grid takes the boiler",
  );
  assert(
    coversBoiler > 0,
    "no quarter had the battery reach past the base load into the boiler",
  );
});

Deno.test("the stores leave the connection the services still need", () => {
  // The auction spends the grid import limit before the duty-cycle pass runs,
  // so a service that arrives afterwards can find nothing left. One observed
  // quarter filled the connection to the watt — pool, then car, then the
  // battery topping up last — and dropped the boiler's demand as unserved.
  const base = input();
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const slots = Array.from({ length: 288 }, (_value, index) => ({
    start: new Date(start + index * 15 * 60_000).toISOString(),
    pv_forecast_w: 0,
    base_load_forecast_w: 800,
    base_load_p10_w: 600,
    base_load_p90_w: 1_100,
    // Cheap enough that every store wants all of it at once.
    import_price_sek_per_kwh: index < 96 ? 0.35 : null,
    export_price_sek_per_kwh: index < 96 ? 0.1 : null,
  }));
  const snapshot = input({
    schema_version: 6,
    slots,
    outdoor_temperature_c: slots.map(() => 22),
    capabilities: {
      pv: false,
      battery: true,
      pool: true,
      boiler: true,
      ev: true,
    },
    battery: { ...base.battery, soc: 0.1 },
    pool: { water_temperature_c: 26, volume_m3: 55 },
    sources: { ...base.sources, pv: null },
    pv_calibration: {
      correction_factor_by_lead_day: [1, 1, 1, 1],
      sample_count_by_lead_day: [0, 0, 0, 0],
    },
    // A connection barely wider than the car alone.
    grid: { import_limit_w: 12_000, export_limit_w: 12_000 },
    ev_battery: {
      name: "Tesla Model Y",
      connected: true,
      capacity_kwh: 77.25,
      soc: 0.3,
      departure_target_soc: 0.9,
      charge_efficiency: 0.92,
      available_from: slots[0].start,
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
    service_requirement_sample_days: {},
    services: [
      {
        id: "boiler:horizon",
        device: "boiler" as const,
        earliest_start: slots[0].start,
        deadline: new Date(start + 96 * 15 * 60_000).toISOString(),
        required_kwh: 6,
        priority: 1,
        control: {
          type: "duty_cycle" as const,
          rated_power_w: 3_000,
          expected_power_w_by_slot: slots.map(() => 900),
          max_consecutive_inhibit_slots: 20,
        },
      },
      routedEvService(input({ slots })),
    ],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  // Every scenario, not only the dispatched one: baseline never inhibits the
  // boiler, so it is where an unreserved connection shows first.
  for (const key of ["baseline", "cost", "priority"] as const) {
    const scenario = plan.plans[key];
    const starved = scenario.slots
      .filter((slot) => slot.unserved_w > 1)
      .map((slot) =>
        `${key} ${slot.start}: ${slot.unserved_w.toFixed(1)} W unserved, ${
          slot.battery_charge_w.toFixed(0)
        } W went to the battery`
      );
    assertEquals(
      starved.slice(0, 3),
      [],
      "a store may not spend connection a service needs",
    );
    assertEquals(scenario.validation_errors, []);
  }
});

Deno.test("deferred hot water comes back at the cheapest hours, not the quietest", () => {
  // The recovery ranking sorted on residual load with no price term, so the
  // catch-up landed in the quietest quarter — quiet precisely because PV was
  // covering the base load, which is also when the evening price peaks. One
  // observed plan parked 1690 W into the single dearest quarter of its window
  // at 3.281 SEK/kWh while 2.07 SEK/kWh quarters sat idle later that night.
  //
  // The shape below is that trap in miniature: quarter 20 is all but silent
  // and the dearest hour of the day; quarters 30-45 draw a full kilowatt from
  // the grid and cost a third as much.
  const base = input();
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const quiet = 20;
  const slots = Array.from({ length: 288 }, (_value, index) => {
    // A heavy stretch up front is what defers the water in the first place:
    // the boiler is inhibited whenever the rest of the house is already
    // drawing enough to exceed the connection once hot water is added.
    const heavy = index < 12;
    const priced = index < 96;
    const price = index === quiet ? 3.3 : heavy ? 2.0 : 1.2;
    return {
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: index === quiet ? 990 : 0,
      base_load_forecast_w: heavy ? 9_000 : 1_000,
      base_load_p10_w: heavy ? 7_000 : 800,
      base_load_p90_w: heavy ? 11_000 : 1_400,
      import_price_sek_per_kwh: priced ? price : null,
      export_price_sek_per_kwh: priced ? 0.4 : null,
    };
  });
  const snapshot = input({
    schema_version: 6,
    slots,
    outdoor_temperature_c: slots.map(() => 22),
    capabilities: {
      pv: true,
      battery: false,
      pool: false,
      boiler: true,
      ev: false,
    },
    battery: null,
    pool: null,
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
    service_requirement_sample_days: {},
    services: [
      {
        id: "boiler:horizon",
        device: "boiler" as const,
        earliest_start: slots[0].start,
        deadline: new Date(start + 96 * 15 * 60_000).toISOString(),
        required_kwh: 6,
        priority: 1,
        control: {
          type: "duty_cycle" as const,
          rated_power_w: 3_000,
          expected_power_w_by_slot: slots.map(() => 400),
          max_consecutive_inhibit_slots: 20,
        },
      },
    ],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.validation_errors, []);
  const priority = plan.plans.priority;
  assert(
    priority.service_inhibited_slots["boiler:horizon"].length > 0,
    "nothing was deferred, so nothing recovered",
  );

  // Recovery is whatever priority runs above the untouched baseline shape.
  const recovered = priority.slots.slice(0, 96)
    .map((slot, index) =>
      slot.boiler_expected_w -
      plan.plans.baseline.slots[index].boiler_expected_w
    );
  const total = recovered.reduce(
    (sum, extraW) => sum + Math.max(0, extraW),
    0,
  );
  assert(total > 100, `expected a real catch-up, got ${total} W`);

  assertEquals(
    recovered[quiet] > 1e-6,
    false,
    `the quietest quarter is the dearest one here, so nothing belongs in it: ${
      recovered[quiet].toFixed(0)
    } W landed at ${priority.slots[quiet].shadow_import_sek_per_kwh} SEK/kWh`,
  );

  // And what did come back must be at the cheap end of what was available.
  let cost = 0;
  let kwh = 0;
  for (const [index, extraW] of recovered.entries()) {
    if (extraW <= 1e-6) continue;
    const slotKwh = extraW / 1_000 * 0.25;
    kwh += slotKwh;
    cost += slotKwh * priority.slots[index].shadow_import_sek_per_kwh;
  }
  assert(
    cost / kwh < 1.3,
    `deferred energy must come back at the 1.2 SEK quarters, paid ${
      (cost / kwh).toFixed(3)
    } SEK/kWh`,
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

Deno.test("a device is never credited with more power than it can draw", () => {
  // The per-device breakdown splits a controlled service across the meters in
  // its category by their share of the empirical forecast. In a quarter where
  // one meter's history is zero and the other's is not, the whole dispatched
  // load lands on whichever one happens to have run before — a deployed plan
  // showed 3500 W against a pool pump whose measured draw is 412 W, eight and
  // a half times what it can take, for fourteen quarters.
  const snapshot = input();
  // Pump: switched, so its measured draw is a ceiling. It ran overnight in the
  // history; the heater did not, which is the whole trap.
  snapshot.device_models = [
    {
      key: "pool-pump",
      name: "Pool pump",
      statistic_id: "sensor.pool_pump_energy",
      planning_service: "pool",
      category: "pool_heating",
      suggested_load_type: "fixed_full_load",
      load_type: "fixed_full_load",
      planning_role: "controllable",
      control_type: "switch_schedule",
      active_power_w: 412,
      profile_sample_count: 828,
      forecast_w_by_slot: snapshot.slots.map(() => 66),
    },
    {
      key: "pool-heater",
      name: "Pool heater",
      statistic_id: "sensor.pool_heater_energy",
      planning_service: "pool",
      category: "pool_heating",
      suggested_load_type: "duty_cycle",
      load_type: "duty_cycle",
      planning_role: "controllable",
      control_type: "switch_schedule",
      active_power_w: 3_439,
      profile_sample_count: 960,
      forecast_w_by_slot: snapshot.slots.map(() => 0),
    },
  ];

  const poolService = snapshot.services.find(service => service.device === "pool")!;
  poolService.control = { type: "fixed_power", power_w: 412 + 3439 };

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  const overdrawn: string[] = [];
  const miscounted: string[] = [];
  for (const slot of plan.plans.priority.slots) {
    if (slot.pool_w <= 1) continue;
    const pump = slot.device_loads_w["pool-pump"] ?? 0;
    const heater = slot.device_loads_w["pool-heater"] ?? 0;
    if (pump > 412 + 1e-6) {
      overdrawn.push(
        `${slot.start}: pump credited ${pump.toFixed(0)} W of a ${
          slot.pool_w.toFixed(0)
        } W run, against 412 W of measured draw`,
      );
    }
    // The split may never change what the house is using.
    if (Math.abs(pump + heater - slot.pool_w) > 0.05) {
      miscounted.push(
        `${slot.start}: ${pump.toFixed(1)} + ${heater.toFixed(1)} != ${
          slot.pool_w.toFixed(1)
        }`,
      );
    }
  }

  assertEquals(
    miscounted.slice(0, 3),
    [],
    "the breakdown must still sum to the run",
  );
  assertEquals(
    overdrawn.slice(0, 3),
    [],
    "a switched device cannot be credited past its measured draw",
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
        planning_service: "pool",
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
      priority: 1,
    },
    {
      id: "pool:second",
      device: "pool",
      earliest_start: snapshot.slots[0].start,
      deadline,
      required_kwh: 1.5,
      control: { type: "fixed_power", power_w: 3_000 },
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
  assertEquals(plan.model_version, "thermal-room-planner-v10");
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
  assertEquals(plan.model_version, "marginal-value-planner-v32");
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

Deno.test("EV charging has no planner minimum runtime", () => {
  const base = horizon();
  const jagged = base.slots.map((slot, index) => ({
    ...slot,
    import_price_sek_per_kwh: slot.import_price_sek_per_kwh === null
      ? null
      : (index % 2 === 0 ? 1.1 : 2.3),
  }));
  const evService = routedEvService(base);
  const snapshot = horizon({
    slots: jagged,
    pool: { water_temperature_c: 28.4, volume_m3: 55 },
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Tesla Model Y",
      connected: true,
      capacity_kwh: 77.25,
      soc: 0.4,
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
    services: [evService],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.validation_errors, []);

  const short: string[] = [];
  let block = 0;
  let charged = 0;
  for (const [index, slot] of plan.plans.priority.slots.entries()) {
    if (slot.ev_w > 0) {
      block += 1;
      charged += slot.ev_w;
      continue;
    }
    if (block > 0 && block < 4) short.push(`${block} slots ending at ${index}`);
    block = 0;
  }
  if (block > 0 && block < 4) short.push(`${block} slots at the horizon end`);

  assert(charged > 0, "the car never charged, so nothing was tested");
  assert(short.length > 0, "a short economic charging run is permitted");
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

  // And not merely in total: no quarter may leave the car above the limit it
  // will refuse past. The block bound used to be measured from the state
  // standing in a block's first slot rather than from the highest the
  // trajectory already reached, so two quarters placed *earlier* than work
  // already scheduled each fitted the room and together did not — `project`
  // clamped the state and the schedule kept power the car cannot take.
  const overshoot = plan.plans.priority.slots.filter((slot) =>
    slot.ev_soc > 0.8 + 1e-6
  );
  assertEquals(
    overshoot.length,
    0,
    `no quarter may plan past the charge limit, ${overshoot.length} do`,
  );
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
  // And it says which of the two silences this is. `outbid` claims the car
  // competed and lost; it never entered, because there was nothing to bid for.
  // Reporting a contest a store could not take part in is §8.12.2's complaint
  // one level in, where "considered and declined" and "could not participate"
  // are made to look alike.
  const ev = plan.plans.priority.store_diagnostics.find((store) =>
    store.key === "ev"
  );
  assertEquals(ev?.reason, "at_state_cap");
});

Deno.test("no allocation is charged for more solar than the quarter had", () => {
  // `recostSlot` divides a quarter's spare PV between the stores charging in
  // it, and it counted a *discharging* store's output as spare. That is not
  // spare energy: it is a transfer the discharging store was already paid for
  // through its own allocation, so the charging store got a discount nobody
  // funded. One observed quarter had the pool book its whole 3.5 kW at the
  // 1.09 SEK/kWh export price while PV was under 1.2 kW and the import price
  // was 2.15 — the four dearest quarters of that day, made to look cheapest.
  //
  // The over-credit only appears where a discharging store puts out *more* than
  // the quarter's residual load, because only then is there a phantom surplus
  // to divide. So: no sun, a light house, a full battery whose top-of-curve
  // energy is worth little, and a cold pool drawing hard beside it.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: 1_000,
      base_load_p10_w: 800,
      base_load_p90_w: 1_300,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 16 && hour < 20 ? 2.4 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const plan = generateOptimisationPlan(
    horizon({
      slots: dark,
      outdoor_temperature_c: dark.map(() => 15),
      pool: { water_temperature_c: 24, volume_m3: 55 },
      battery: { ...base.battery!, capacity_kwh: 18.08, soc: 1 },
    }),
    new Date(NOW),
  );

  assertEquals(plan.status, "ready");
  const priority = plan.plans.priority;
  assert(
    priority.slots.some((slot) =>
      slot.battery_discharge_w > Math.max(0, slot.base_w - slot.pv_w) + 1 &&
      (slot.decision.store_allocations ?? []).some((part) =>
        part.direction === "charge"
      )
    ),
    "the fixture has to put a discharge beside a charge, or nothing is tested",
  );
  for (const slot of priority.slots) {
    const bookedSolarW = (slot.decision.store_allocations ?? [])
      .filter((part) => part.direction === "charge")
      .reduce((total, part) => total + part.solar_w, 0);
    const spareW = Math.max(0, slot.pv_w - slot.base_w);
    assert(
      bookedSolarW <= spareW + 1,
      `${slot.start}: ${bookedSolarW.toFixed(0)} W booked as solar against ` +
        `${spareW.toFixed(0)} W of surplus`,
    );
  }
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
      // A continuous heat-pump run repays its startup cost together. A mildly
      // losing quarter can be worth keeping when removing it adds a restart;
      // this is an economic trade-off, not a minimum runtime.
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
          `${slot.start}: booked at ${
            part.state_before.toFixed(4)
          } kWh, ran at ${battery.state_before.toFixed(4)} kWh`,
        );
      }
    }
  }

  assert(
    allocations > 20,
    `expected a busy plan, got ${allocations} allocations`,
  );
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
  //
  // The air is held at the water temperature so the pool neither gains nor
  // loses, which is what isolates the subject. Over the fixture's 72 hours a
  // pool losing heat to 22 °C air falls about 3.4 °C — well into the steep part
  // of its curve — and buying cheap surplus now to prevent that is correct, not
  // a defect. It only looked like one while `retentionBySlot` discounted the
  // far end of the horizon to nothing (§8.13). What is under test here is the
  // marginal-value comparison, not the decay, so the fixture removes the decay.
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 30.15, volume_m3: 55 },
    outdoor_temperature_c: base.slots.map(() => 30.15),
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

Deno.test("an unplugged car without charger controls reports missing planning state", () => {
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
  assertEquals(ev.reason, "state_unavailable");
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
    three > 0 && three <= 3 * 230 * 16 + 1 && three % (3 * 230) === 0,
    `three-phase charging must use supported currents within its limit: ${three}`,
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
  assert(
    batteryCurve.curve.points.length > 2,
    "curve breakpoints are required",
  );
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

/**
 * The two tests below pin air-source physics reaching the *schedule*, which
 * §8.12.1 records as the gap: heuristic 5 is reproduced against
 * `store-models.ts` at the unit level and nowhere in a whole plan. They are
 * also the behaviours most likely to be lost quietly when `PoolHeatPumpModel`
 * tiers into air and ground variants (§8.14), because a ground-source unit has
 * neither a cut-out nor an air term and a careless refactor can drop both from
 * the air path while every ground test still passes.
 */
Deno.test("below the cut-out no price makes pool heat schedulable", () => {
  const base = input();
  // As cold a pool as the curve values at all, so willingness to pay is at its
  // maximum and only the physics can refuse.
  const cold = (airC: number) =>
    input({
      schema_version: 6,
      pool: { water_temperature_c: 23, volume_m3: 55 },
      outdoor_temperature_c: base.slots.map(() => airC),
    });

  const warmDay = generateOptimisationPlan(cold(22), new Date(NOW));
  const frozenDay = generateOptimisationPlan(cold(4), new Date(NOW));

  const poolKwh = (plan: ReturnType<typeof generateOptimisationPlan>) =>
    plan.plans.priority.slots.reduce(
      (total, slot) => total + slot.pool_w / 1_000 * 0.25,
      0,
    );

  assertEquals(warmDay.status, "ready");
  assertEquals(frozenDay.status, "ready");
  assert(
    poolKwh(warmDay) > 2.5,
    `the same pool at 22 °C air must heat, got ${poolKwh(warmDay)}`,
  );
  assertEquals(
    poolKwh(frozenDay),
    0,
    "below cutout_air_c the pump delivers nothing, so buying power is waste",
  );

  // And it says so rather than going quiet. The exact reason code is not
  // asserted: `StoreDiagnostic.reason` has no case for a store whose hardware
  // cannot run and falls through to one about the curve (§8.13), so only the
  // claim that it did not run is stable here.
  const pool = frozenDay.plans.priority.store_diagnostics.find((store) =>
    store.key === "pool"
  );
  assert(pool !== undefined, "a store that cannot run still has to report");
  assertEquals(pool.planned_kwh, 0);
  assert(
    pool.reason !== "scheduled",
    `a pool that bought nothing must not report scheduled, got ${pool.reason}`,
  );
});

Deno.test("the plan prices pool heat at COP(air), not at the meter", () => {
  const base = input();
  const atAir = (airC: number) =>
    generateOptimisationPlan(
      input({
        schema_version: 6,
        pool: { water_temperature_c: 23, volume_m3: 55 },
        outdoor_temperature_c: base.slots.map(() => airC),
      }),
      new Date(NOW),
    );

  const poolValue = (plan: ReturnType<typeof generateOptimisationPlan>) =>
    plan.plans.priority.store_diagnostics.find((store) => store.key === "pool")
      ?.marginal_value_sek_per_kwh ?? 0;

  // Same water, same curve, same prices: the only difference is the air the
  // pump is working against, so the ratio of what a kilowatt-hour is worth to
  // the pool is exactly the ratio of the two COPs.
  const cool = poolValue(atAir(12));
  const warm = poolValue(atAir(24));

  assert(cool > 0 && warm > 0, "both days are above the cut-out");
  const seededCop = (airC: number) =>
    4.5 * (1 + 0.045 * (airC - 20)) * (1 - 0.02 * (23 - 27));
  assertAlmostEquals(
    warm / cool,
    seededCop(24) / seededCop(12),
    1e-3,
    "a warm day must buy proportionally more pool heat per kilowatt-hour",
  );
});

/**
 * A dear, sunless first day followed by two cheap sunny ones, with the pool
 * carrying the reference home's *stored* curve — the one the editor anchored at
 * 2.51 SEK/kWh, whose urgent threshold is 7.52 and whose comfortable threshold
 * is 2.51, both above every price in this horizon.
 *
 * That curve is the point. Left as stored it outbids the whole board and the
 * pool heats through the dearest quarters available; re-anchored to what cheap
 * energy actually costs here, the same three thresholds and the same
 * `URGENT_MULTIPLE` put urgent at 3.0 and the dear day stops clearing.
 */
const splitHorizon = (
  dearFirstDaySekPerKwh: number,
  overrides: Partial<OptimisationSnapshot> = {},
  exportSekPerKwh = 0.5,
): OptimisationSnapshot => {
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const slots = Array.from({ length: 288 }, (_value, index) => {
    const hour = ((index / 4) + 10) % 24;
    const firstDay = index < 96;
    const pv = !firstDay && hour >= 6 && hour <= 18
      ? Math.round(9_000 * Math.sin(((hour - 6) / 12) * Math.PI))
      : 0;
    return {
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: pv,
      base_load_forecast_w: 1_000,
      base_load_p10_w: 800,
      base_load_p90_w: 1_400,
      import_price_sek_per_kwh: firstDay ? dearFirstDaySekPerKwh : 1.0,
      export_price_sek_per_kwh: exportSekPerKwh,
    };
  });
  return input({
    schema_version: 6,
    slots,
    outdoor_temperature_c: slots.map(() => 20),
    services: [],
    service_requirement_sample_days: {},
    pool: { water_temperature_c: 27, volume_m3: 55 },
    value_curves: {
      pool: {
        unit: "celsius",
        points: [
          { at: 28, sek_per_unit: 104.56 },
          { at: 30, sek_per_unit: 34.85 },
          { at: 32, sek_per_unit: 0 },
        ],
      },
    },
    ...overrides,
  });
};

const poolKwhBetween = (
  plan: ReturnType<typeof generateOptimisationPlan>,
  from: number,
  to: number,
) =>
  plan.plans.priority.slots.slice(from, to).reduce(
    (total, slot) => total + slot.pool_w / 1_000 * 0.25,
    0,
  );

// §8.12 acceptance test 8.
Deno.test("a dear day is skipped when the forecast carries the sun to replace it", () => {
  const plan = generateOptimisationPlan(splitHorizon(3.5), new Date(NOW));

  assertEquals(plan.status, "ready");
  assertEquals(plan.validation_errors, []);
  const dearDay = poolKwhBetween(plan, 0, 96);
  const sunnyDays = poolKwhBetween(plan, 96, 288);

  assert(sunnyDays > 5, `the pool still has to heat, got ${sunnyDays} kWh`);
  assert(
    dearDay < sunnyDays * 0.05,
    `a 3.5 SEK/kWh day with two sunny 1.0 SEK/kWh days behind it must be ` +
      `skipped, took ${dearDay} kWh against ${sunnyDays}`,
  );
});

// §8.12 acceptance test 9, and the other direction of the same comparison: the
// pool is not being asked to want heat less, only to want it where it is cheap.
//
// The contrast is the export price, because that is the actual question. A pool
// inside its band values a kilowatt-hour of heat at about 1.9 SEK here, so
// surplus at 0.5 is worth banking and surplus at 3.0 is worth selling, and the
// planner has to reach opposite conclusions from the same physics. Contrasting
// a warm pool against a full one does not work: over 72 hours against 20 °C air
// a pool at 32 °C loses 4.7 °C and is hungry again well before the horizon ends,
// which is a fact about the store rather than about the price.
Deno.test("surplus is banked while the pool values it above what it would fetch", () => {
  const warmPool = { pool: { water_temperature_c: 29, volume_m3: 55 } };
  const cheapExport = generateOptimisationPlan(
    splitHorizon(1.0, warmPool, 0.5),
    new Date(NOW),
  );
  const dearExport = generateOptimisationPlan(
    splitHorizon(1.0, warmPool, 3.0),
    new Date(NOW),
  );

  const poolKwh = (plan: ReturnType<typeof generateOptimisationPlan>) =>
    poolKwhBetween(plan, 0, plan.plans.priority.slots.length);

  assert(
    poolKwh(cheapExport) > 5,
    `surplus worth 0.5 belongs in the pool, got ${poolKwh(cheapExport)} kWh`,
  );
  assert(
    poolKwh(dearExport) < poolKwh(cheapExport),
    `surplus worth 3.0 is worth more sold: ${
      poolKwh(dearExport)
    } kWh against ` +
      `${poolKwh(cheapExport)}`,
  );
  assert(
    cheapExport.plans.priority.summary.grid_export_kwh <
      dearExport.plans.priority.summary.grid_export_kwh,
    "and the energy the pool kept is energy that was not sold",
  );
});

Deno.test("a dispatched battery is not failed against a floor it was never given", () => {
  // The live plan behind this: a battery starting at 15.9% against a 20%
  // terminal reserve. The plan raised it to 17.9% and reported itself
  // infeasible for the improvement, because `terminal_soc_min` reaches the
  // dispatch nowhere — the store's floor is `min_soc` — so the auction was
  // free to end anywhere above 5% and was then judged against 20%. No plan
  // could have passed except one that force-charged at any price, which is the
  // hard target §8.4 deleted.
  //
  // Power here is cheap enough that `batteryValueCurve` values stored energy
  // at nothing once wear is subtracted, so the battery correctly ends low. At
  // ordinary prices it grid-charges to full even across a sunless horizon,
  // which is why this went unnoticed for so long. The wear is stated rather
  // than inherited, because it is that subtraction that sets the scene here.
  const base = horizon();
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const cheapSlots = base.slots.map((slot, index) => ({
    ...slot,
    start: new Date(start + index * 15 * 60_000).toISOString(),
    import_price_sek_per_kwh: index < 96 ? 0.35 : null,
    export_price_sek_per_kwh: index < 96 ? 0.1 : null,
  }));
  const withFloor = (
    floor: number,
    overrides: Partial<OptimisationSnapshot> = {},
  ) =>
    horizon({
      // Pool state is what makes the dispatch buildable at all: it refuses to
      // mix a measured store with a budgeted one, so a fixture without it is
      // never dispatched and would test nothing here.
      pool: { water_temperature_c: 30.9, volume_m3: 55 },
      outdoor_temperature_c: base.slots.map(() => 30.9),
      slots: cheapSlots,
      policy: { ...base.policy, terminal_soc_min: floor },
      value_settings: { ...PRICED_WEAR, vehicle_fallback_sek_per_km: null },
      ...overrides,
    });

  const dispatched = generateOptimisationPlan(withFloor(0.2), new Date(NOW));

  assertEquals(
    dispatched.plans.priority.dispatched_devices.includes("battery"),
    true,
  );
  assert(
    dispatched.plans.priority.summary.battery_soc_end < 0.2,
    `the floor has to bind, got ${dispatched.plans.priority.summary.battery_soc_end}`,
  );
  assertEquals(dispatched.validation_errors, []);
  assertEquals(dispatched.status, "ready");
  // The comparison stays legible: both numbers are published, so a reader that
  // wants to show "below the reserve" has them. What it is not is a verdict.
  assertEquals(dispatched.policy.terminal_soc_min, 0.2);

  // And the exemption is scoped to the store that prices its own terminal
  // state. A battery the dispatch never took is still planned by the block
  // model, which was given no terminal value either, so there the floor is the
  // only thing that says the plan ended low. Its own floor, because the block
  // model settles higher on the same prices.
  const blockModel = generateOptimisationPlan(
    withFloor(0.8, { schema_version: 5, pool: null }),
    new Date(NOW),
  );
  assertEquals(
    blockModel.plans.priority.dispatched_devices.includes("battery"),
    false,
  );
  assert(
    blockModel.validation_errors.some((error) =>
      error.includes("terminal SOC")
    ),
    `an undispatched battery still reports the floor, got ${
      JSON.stringify(blockModel.validation_errors)
    }`,
  );
});

Deno.test("a battery that charges in winter also discharges", () => {
  // No sun for the whole horizon, so every quarter is a deficit and the
  // covering window is the entire three days. Under the round-trip valuation
  // this plan charged 15 kWh and discharged in none of 288 quarters: a battery
  // that only ever accumulates, bought at prices it could never pay back.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: hour >= 16 && hour < 21 ? 5_000 : 2_500,
      base_load_p10_w: 2_000,
      base_load_p90_w: 6_500,
      // A real day/night spread, which is the only thing a battery can trade.
      import_price_sek_per_kwh: index < 96
        ? (hour >= 6 && hour < 9 ? 3.2 : hour >= 16 && hour < 20 ? 2.9 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const plan = generateOptimisationPlan(
    horizon({
      slots: dark,
      outdoor_temperature_c: dark.map(() => -8),
      pool: { water_temperature_c: 30.9, volume_m3: 55 },
    }),
    new Date(NOW),
  );

  assertEquals(plan.status, "ready");
  const priority = plan.plans.priority;
  assertEquals(priority.dispatched_devices.includes("battery"), true);
  const charged = priority.slots.reduce(
    (total, slot) => total + slot.battery_charge_w / 1_000 * 0.25,
    0,
  );
  const returned = priority.slots.reduce(
    (total, slot) => total + slot.battery_discharge_w / 1_000 * 0.25,
    0,
  );
  assert(charged > 1, `a cheap night is worth storing, charged ${charged} kWh`);
  assert(
    returned > 1,
    `and a dear morning is what it was stored for, returned ${returned} kWh`,
  );
});

Deno.test("a shaped peak spreads a charge instead of concentrating it", () => {
  // Compare explicit shaping rates so this regression does not follow a
  // changed default. Charging must spread while still doing useful arbitrage.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: hour >= 16 && hour < 21 ? 5_000 : 2_500,
      base_load_p10_w: 2_000,
      base_load_p90_w: 6_500,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 6 && hour < 9 ? 3.2 : hour >= 16 && hour < 20 ? 2.9 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const at = (rate: number) => {
    const plan = generateOptimisationPlan(
      horizon({
        slots: dark,
        outdoor_temperature_c: dark.map(() => -8),
        pool: { water_temperature_c: 30.9, volume_m3: 55 },
        // A pack whose charger can outrun the shaping, so the power it settles
        // at is a decision rather than the hardware limit.
        battery: { ...base.battery!, capacity_kwh: 18.08, charge_max_w: 8_800 },
        policy: {
          ...base.policy,
          peak_shaping_sek_per_kwh_per_kw: rate,
        } as OptimisationSnapshot["policy"],
      }),
      new Date(NOW),
    );
    const slots = plan.plans.priority.slots;
    const charging = slots.filter((slot) => slot.battery_charge_w > 1);
    return {
      status: plan.status,
      quarters: charging.length,
      peakChargeW: Math.max(...charging.map((slot) => slot.battery_charge_w)),
      peakImportW: Math.max(...slots.map((slot) => slot.grid_import_w)),
      kwh: charging.reduce(
        (total, slot) => total + slot.battery_charge_w / 1_000 * 0.25,
        0,
      ),
    };
  };

  const flat = at(0);
  const shaped = at(0.1);

  assertEquals(flat.status, "ready");
  assertEquals(shaped.status, "ready");
  assert(
    shaped.quarters > flat.quarters,
    `shaping spreads the charge: ${flat.quarters} quarters became ${shaped.quarters}`,
  );
  assert(
    shaped.peakChargeW < flat.peakChargeW,
    `and lowers the power it is drawn at: ${flat.peakChargeW} W became ${shaped.peakChargeW} W`,
  );
  assert(
    shaped.peakImportW < flat.peakImportW,
    `which is the point — the grid peak: ${flat.peakImportW} W became ${shaped.peakImportW} W`,
  );
  // Power moved, energy did not: this is not simply buying less.
  assert(
    shaped.kwh > flat.kwh * 0.8,
    `the same charge is still bought, ${flat.kwh} against ${shaped.kwh} kWh`,
  );
});

Deno.test("§8.12 #12 — a winter covering window is the dear stretch, not the horizon", () => {
  // The window ends where the battery can next be refilled. A surplus was the
  // only thing that counted as a refill, so a horizon with no sun had none: the
  // run was all 288 quarters and 273 kWh, the whole pack was priced against the
  // dearest hours in three days, and the curve said *full* under nearly every
  // condition (§8.16 requirement 3).
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: hour >= 16 && hour < 21 ? 5_000 : 2_500,
      base_load_p10_w: 2_000,
      base_load_p90_w: 6_500,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 6 && hour < 9 ? 3.2 : hour >= 16 && hour < 20 ? 2.9 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const plan = generateOptimisationPlan(
    horizon({
      slots: dark,
      outdoor_temperature_c: dark.map(() => -8),
      pool: { water_temperature_c: 30.9, volume_m3: 55 },
      battery: { ...base.battery!, capacity_kwh: 18.08, charge_max_w: 8_800 },
    }),
    new Date(NOW),
  );

  assertEquals(plan.status, "ready");
  const curve = plan.battery_value_curve;
  assert(curve !== null, "a dispatched battery publishes its curve");
  const window = curve.covering_window;
  assert(
    window.length < dark.length / 4,
    `the window is one stretch, not the horizon: ${window.length} of ${dark.length} quarters`,
  );
  // And it is a *dear* stretch, which is the half of the requirement a
  // longest-run rule gets wrong once a cheap hour also ends a run: the longest
  // gap between two refills is frequently a lull rather than the peak the
  // battery exists for. Every quarter in it must beat the horizon's typical
  // price, or the pack is being valued against ordinary hours again.
  const horizonPrices = plan.plans.priority.slots
    .map((slot) =>
      slot.import_price_sek_per_kwh ?? slot.shadow_import_sek_per_kwh
    )
    .sort((left, right) => left - right);
  const median = horizonPrices[Math.floor(horizonPrices.length / 2)];
  const cheapestCovered = Math.min(
    ...window.map((quarter) => quarter.import_price_sek_per_kwh),
  );
  assert(
    cheapestCovered > median,
    `even the cheapest covered quarter (${cheapestCovered}) beats the median ${median}`,
  );
  // Covering-window value is capped by ordinary replacement cost. The dear
  // in-horizon load is priced separately by the joint transaction search.
  const dearestCovered = Math.max(
    ...window.map((quarter) => quarter.import_price_sek_per_kwh),
  );
  const battery = plan.battery!;
  // Against the wear the plan actually used, which it publishes. Reading the
  // shipped default back would assert nothing when that default moves.
  assertAlmostEquals(
    curve.curve.points[0].sek_per_unit,
    Math.min(
      curve.terminal_replacement_sek_per_kwh,
      dearestCovered * battery.discharge_efficiency -
        curve.curve_input.degradation_sek_per_kwh,
    ),
    0.02,
  );
});

Deno.test("§8.12 #11 — charge power gives way to the load already in the quarter", () => {
  // The envelope is the whole home's, not the battery's own (§8.16 requirement
  // 2). A per-device cap could not express this: it would leave the same peak
  // reachable by two other loads, and the figure a fuse and a tariff both care
  // about is the sum.
  //
  // Two plans differing only in how busy the house is during the charging
  // window, because a single plan cannot show it: with quiet quarters available
  // the battery simply charges in those, which is correct and tells us nothing.
  // Raising the whole window leaves it nowhere to escape to, so what it does
  // with its power is the only thing left to observe.
  //
  // The connection is widened to 20 kW so that the fuse can never be what backs
  // the charger off: at 4 kW of house it still leaves 16 kW against an 8.8 kW
  // charger. Two earlier versions of this test passed with shaping switched
  // off because `headroomW` was clipping against the *physical* limit — which
  // is precisely the envelope §8.16 requirement 2 says is not enough, so a test
  // that cannot tell the two apart is testing the wrong one.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const atHouseLoad = (houseW: number) => {
    const slots = base.slots.map((slot, index) => {
      const load = index < 48 ? houseW : 3_000;
      return {
        ...slot,
        start: new Date(start + index * 15 * 60_000).toISOString(),
        pv_forecast_w: 0,
        // Twelve cheap hours to charge in, then a dear evening to have charged
        // for. The price is flat across the window on purpose: if the battery
        // backed off because a quarter were dearer, this would be measuring the
        // energy objective it already had.
        base_load_forecast_w: load,
        base_load_p10_w: Math.round(load * 0.8),
        base_load_p90_w: Math.round(load * 1.3),
        import_price_sek_per_kwh: index < 96 ? (index < 48 ? 0.8 : 3.0) : null,
        export_price_sek_per_kwh: index < 96 ? 0.2 : null,
      };
    });
    const plan = generateOptimisationPlan(
      horizon({
        slots,
        outdoor_temperature_c: slots.map(() => -8),
        pool: { water_temperature_c: 30.9, volume_m3: 55 },
        grid: { import_limit_w: 20_000, export_limit_w: 20_000 },
        // Its own rate rather than the shipped default, so the test says what
        // it depends on. At the default this fixture's overshoot is small
        // enough that crossing the threshold genuinely is worth it — the cost
        // of 2.8 kW over is 0.59 SEK against 1.04 SEK of extra value — and
        // full power is then the right answer, not a defect.
        policy: {
          ...base.policy,
          peak_shaping_sek_per_kwh_per_kw: 0.1,
        } as OptimisationSnapshot["policy"],
        battery: {
          ...base.battery!,
          capacity_kwh: 18.08,
          soc: 0.05,
          charge_max_w: 8_800,
        },
      }),
      new Date(NOW),
    );
    const window = plan.plans.priority.slots.slice(0, 48);
    const charging = window.filter((slot) => slot.battery_charge_w > 1);
    return {
      status: plan.status,
      peakChargeW: charging.length === 0
        ? 0
        : Math.max(...charging.map((slot) => slot.battery_charge_w)),
      peakImportW: Math.max(...window.map((slot) => slot.grid_import_w)),
      kwh: charging.reduce(
        (total, slot) => total + slot.battery_charge_w / 1_000 * 0.25,
        0,
      ),
    };
  };

  const quiet = atHouseLoad(500);
  const busy = atHouseLoad(4_000);

  assertEquals(quiet.status, "ready");
  assertEquals(busy.status, "ready");
  assert(quiet.peakChargeW > 0, "the battery has to charge in the quiet house");
  assert(busy.peakChargeW > 0, "and in the busy one");
  assert(
    busy.peakChargeW < quiet.peakChargeW,
    `a busier house leaves the battery less power at the same price: ` +
      `${busy.peakChargeW} W against ${quiet.peakChargeW} W`,
  );
  // Which is the point: what it gives way to is the total, so the busy home's
  // grid peak does not simply rise by the whole extra 3.5 kW of house.
  assert(
    busy.peakImportW - quiet.peakImportW < 3_500,
    `the peak absorbs some of the extra house load rather than all of it: ` +
      `${busy.peakImportW} W against ${quiet.peakImportW} W`,
  );
});

Deno.test("a soft battery reserve cannot inflate terminal value beyond replacement cost", () => {
  // A sunless horizon isolates the reserve from free capacity-filling solar.
  // Starting below a soft reserve stays feasible, and a requested reserve may
  // not invent a worst-hour premium on energy left after the horizon.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: hour >= 16 && hour < 21 ? 5_000 : 2_500,
      base_load_p10_w: 2_000,
      base_load_p90_w: 6_500,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 6 && hour < 9 ? 3.2 : hour >= 16 && hour < 20 ? 2.9 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const at = (reserve: number) => {
    const plan = generateOptimisationPlan(
      horizon({
        slots: dark,
        pool: { water_temperature_c: 30.9, volume_m3: 55 },
        outdoor_temperature_c: dark.map(() => -8),
        battery: { ...base.battery!, capacity_kwh: 18.08, soc: 0.1 },
        policy: { ...base.policy, terminal_soc_min: reserve },
        value_settings: { ...PRICED_WEAR, vehicle_fallback_sek_per_km: null },
      }),
      new Date(NOW),
    );
    return {
      status: plan.status,
      errors: plan.validation_errors,
      end: plan.plans.priority.summary.battery_soc_end,
      curve: plan.battery_value_curve,
    };
  };

  const none = at(0.05);
  const held = at(0.4);

  assertEquals(none.status, "ready");
  assertEquals(held.status, "ready");
  // Starting under the reserve is not a fault, and never was the plan's doing.
  assertEquals(held.errors, []);
  assert(
    held.end >= none.end - 1e-6,
    `a soft reserve may preserve energy without an artificial spike premium`,
  );

  // Publish both the requested reserve and the effective replacement cap.
  const curve = held.curve!;
  assert(
    curve.curve_input.reserve_kwh > 0,
    "the reserve reaches the curve in its own units",
  );
  assertAlmostEquals(
    curve.curve.points[0].sek_per_unit,
    curve.terminal_replacement_sek_per_kwh,
    0.02,
  );
  assertEquals(none.curve!.curve_input.reserve_kwh, 0);
});

Deno.test("§8.19 — the home's own wear cost reaches the curve", () => {
  // The column existed, the resolver existed, and `deriveBatteryValueCurve`
  // read the shipped constant instead — so the setting was configurable and
  // inert, and every home was priced against a figure nobody had chosen.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  // A night trough and an evening peak: the shape wear is a threshold on.
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: 1_500,
      base_load_p10_w: 1_000,
      base_load_p90_w: 2_500,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 17 && hour < 21 ? 1.35 : 0.9)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const at = (settings?: { battery_degradation_sek_per_kwh: number }) =>
    generateOptimisationPlan(
      horizon({
        slots: dark,
        pool: { water_temperature_c: 30.9, volume_m3: 55 },
        outdoor_temperature_c: dark.map(() => 12),
        battery: { ...base.battery!, capacity_kwh: 18.08, soc: 0.1 },
        value_settings: settings
          ? { ...settings, vehicle_fallback_sek_per_km: null }
          : undefined,
      }),
      new Date(NOW),
    );

  const priced = at({ battery_degradation_sek_per_kwh: 0.45 });
  const cheap = at({ battery_degradation_sek_per_kwh: 0.05 });

  // What the home asked for is what the curve was built from, and it says so.
  assertEquals(
    priced.battery_value_curve!.curve_input.degradation_sek_per_kwh,
    0.45,
  );
  assertEquals(
    cheap.battery_value_curve!.curve_input.degradation_sek_per_kwh,
    0.05,
  );

  // And it is a decision, not a label. A 1.35 against 0.9 evening is a 50%
  // spread: through 0.45 of wear the round trip needs 66% and this evening is
  // refused, through 0.05 it needs 17% and the evening is taken. The dear plan
  // is not quite idle — the shaped prior past the published window is dearer
  // than anything quoted, and a little trades against that — so what is
  // asserted is the size of the gap and not a zero.
  const cycled = (plan: ReturnType<typeof generateOptimisationPlan>) =>
    plan.plans.priority.slots.reduce(
      (total, slot) => total + slot.battery_discharge_w,
      0,
    );
  assert(
    cycled(cheap) > cycled(priced) * 10,
    `lowering the threshold must open the evening up: ` +
      `${cycled(priced)} against ${cycled(cheap)}`,
  );

  // A home that has never had a row keeps whatever the product ships.
  assertEquals(
    at().battery_value_curve!.curve_input.degradation_sek_per_kwh,
    DEFAULT_VALUE_SETTINGS.battery_degradation_sek_per_kwh,
  );
});

Deno.test("unplugging preserves the car's planned energy while cable telemetry stays false", async () => {
  const { dispatchedEvSnapshot } = await import(
    "../../../scripts/generate-ha-plan-fixture.ts"
  );
  const snapshot = dispatchedEvSnapshot();
  const now = new Date(snapshot.captured_at);
  const connected = generateOptimisationPlan(snapshot, now);
  snapshot.ev_battery!.connected = false;
  const unplugged = generateOptimisationPlan(snapshot, now);
  assertEquals(unplugged.validation_errors, []);
  assertEquals(unplugged.ev_battery!.connected, false);
  assertEquals(
    unplugged.plans.priority.slots.map((slot) => slot.ev_w),
    connected.plans.priority.slots.map((slot) => slot.ev_w),
  );
  assert(
    unplugged.plans.priority.slots.some((slot) => slot.ev_w > 0),
    "the unplugged car must still be planned",
  );
  assert(
    unplugged.plans.priority.slots.every((slot) => !slot.ev_connected),
    "do not invent a cable connection",
  );
});


Deno.test("pool running telemetry is validated and carried into dispatch", () => {
  const base = input();
  for (const running of [true, false, null, undefined]) {
    const snapshot = input({
      schema_version: 6,
      pool: { water_temperature_c: 23, volume_m3: 55, heating_running: running },
      outdoor_temperature_c: base.slots.map(() => 22),
    });
    assertEquals(validateSnapshot(snapshot), []);
    const workbench = dispatchWorkbench(snapshot)!;
    assertEquals(workbench.stores.find((store) => store.key === "pool")!.initially_charging, running === true);
  }
  const invalid = input({ pool: { water_temperature_c: 23, volume_m3: 55, heating_running: "on" as unknown as boolean } });
  assert(validateSnapshot(invalid).includes("pool state is invalid"), "invalid actuator state must be rejected");
});

Deno.test("pool runs preserve each meter's learned draw despite conflicting quarter profiles", () => {
  const snapshot = input({ schema_version: 7, pool: { water_temperature_c: 23, volume_m3: 55 }, thermal_zones: [] });
  snapshot.outdoor_temperature_c = snapshot.slots.map(() => 20);
  snapshot.device_models = [
    { key: "pump", name: "Pump", statistic_id: "sensor.pump", category: "pool_heating",
      suggested_load_type: "fixed_full_load", load_type: "variable_full_load", planning_role: "controllable",
      control_type: "switch_schedule", planning_service: "pool", active_power_w: 764, profile_sample_count: 4,
      forecast_w_by_slot: snapshot.slots.map((_, i) => i % 2 ? 0 : 764) },
    { key: "heater", name: "Heater", statistic_id: "sensor.heater", category: "pool_heating",
      suggested_load_type: "duty_cycle", load_type: "inverter", planning_role: "controllable",
      control_type: "setpoint", planning_service: "pool", active_power_w: 1156, profile_sample_count: 4,
      forecast_w_by_slot: snapshot.slots.map((_, i) => i % 2 ? 1156 : 0) },
    { key: "floor", name: "Floor", statistic_id: "sensor.floor", category: "pool_heating",
      suggested_load_type: "duty_cycle", load_type: "duty_cycle", planning_role: "controllable",
      control_type: "setpoint", active_power_w: 800, profile_sample_count: 4,
      forecast_w_by_slot: snapshot.slots.map(() => 80) },
  ];
  const service = snapshot.services.find(service => service.device === "pool")!;
  service.control = { type: "fixed_power", power_w: 1920 };
  assertEquals(validateSnapshot(snapshot), []);
  const generated = generateOptimisationPlan(snapshot, new Date(NOW));
  for (const plan of Object.values(generated.plans)) {
    assert(plan.slots.some(slot => slot.pool_w > 0), "pool never ran");
    for (const slot of plan.slots) {
      assertEquals(slot.device_loads_w.pump, slot.pool_w > 0 ? 764 : 0);
      assertEquals(slot.device_loads_w.heater, slot.pool_w > 0 ? 1156 : 0);
      assertEquals(slot.device_loads_w.floor, 80);
      assertAlmostEquals(slot.load_w, slot.base_w + slot.pool_w + slot.boiler_expected_w + 80, .01);
      assertAlmostEquals(slot.grid_import_w + slot.pv_w + slot.battery_discharge_w,
        slot.load_w + slot.grid_export_w + slot.battery_charge_w + slot.curtailed_w, .05);
    }
  }
  service.control.power_w = 764;
  assert(validateSnapshot(snapshot).includes("pool service power must equal its devices' running power"),
    "the original pump-only service rating must be refused");
  service.control.power_w = 1920;
  for (const model of snapshot.device_models) delete model.planning_service;
  assert(validateSnapshot(snapshot).includes("pool planning requires explicit device membership from Home Assistant"),
    "a snapshot without pool ownership must not silently revert to category allocation");
});

Deno.test('cached plan validity covers the full 72-hour schedule beyond published prices', () => {
  const snapshot = horizon({}, { pricedSlots: 20 });
  const start = Date.parse(snapshot.slots[0].start);
  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.valid_until, new Date(start + 72 * 60 * 60_000).toISOString());
  assertEquals(plan.binding_until, new Date(start + 5 * 60 * 60_000).toISOString());
  assertEquals(plan.plans.priority.slots.length, 288);
});

Deno.test("late snapshots never earn expired energy and partial quarters reconcile with dispatch", () => {
  const source = input({schema_version: 6, captured_at: "2026-08-10T08:14:55Z", services: [],
    capabilities: {pv: false, battery: true, pool: false, boiler: false, ev: false}});
  source.sources.pv = null;
  source.sources.battery!.issued_at = source.captured_at;
  source.battery!.soc = .05;
  source.policy.battery_target_is_hard = false;
  source.slots.forEach((s, i) => {
    s.pv_forecast_w = 0;
    s.import_price_sek_per_kwh = i < 2 ? .5 : 3;
    s.export_price_sek_per_kwh = .2;
  });
  for (const [time, skipped, hours] of [
    ["2026-08-10T08:14:55Z", 0, 5 / 3600],
    ["2026-08-10T08:15:20Z", 1, 880 / 3600],
  ] as const) {
    const original = structuredClone(source);
    const now = new Date(time);
    const plan = generateOptimisationPlan(source, now);
    assertEquals(plan.status, "ready");
    assertEquals(source, original);
    const first = plan.plans.priority.slots[0];
    assertEquals(first.start, source.slots[skipped].start);
    assertAlmostEquals(first.duration_hours!, hours);
    assert(first.battery_charge_w > 0, "cheap remaining period should charge");
    assertAlmostEquals(first.battery_soc!, .05 + first.battery_charge_w / 1000 * hours * .95 / 10, 1e-6);
    const bench = dispatchWorkbench(source, [], plan.price_outlook, now)!;
    assertEquals(bench.slot_start_ms[0], Date.parse(first.start));
    assertAlmostEquals(bench.stores.find(s => s.key === "battery")!.initial_state, 0);
    assertEquals(bench.planned.power_w.battery.map(w => Math.round(w * 100) / 100),
      plan.plans.priority.slots.map(s => s.battery_charge_w));
  }
});
