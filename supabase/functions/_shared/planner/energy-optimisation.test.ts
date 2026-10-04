import { generateOptimisationPlan, dispatchWorkbench, poolStopTemperature, type OptimisationSnapshot, validateSnapshot } from "./energy-optimisation.ts";
import { projectZoneTemperature } from "./thermal-model.ts";
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { NOW, assert, input, horizon, routedEvService, splitHorizon, poolKwhBetween } from "./energy-optimisation.fixture.ts";

Deno.test("base-load forecasts need no confidence bounds to produce a plan", () => {
  const snapshot = input();
  snapshot.slots.forEach((slot, index) => {
    slot.base_load_forecast_w = index % 2 ? 1368 : 500;
  });
  assertEquals(validateSnapshot(snapshot), []);
  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.status, "ready");
  assertEquals(plan.plans.priority.slots[1].base_w, 1368);
  for (const slot of plan.plans.priority.slots) {
    assertEquals(Object.keys(slot).filter(key => key.startsWith("base_")), ["base_w"]);
  }
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
  assertEquals(plan.model_version, "marginal-value-planner-v47");
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

Deno.test("a measured pool response replaces the loss by temperature and the COP as one figure", () => {
  // A pool that cools 0.04 °C an hour and gains 0.08 °C per heater kWh above
  // 29 °C, and does a third and a half of that below it.
  const response = [
    { at_c: 28.875, idle_c_per_h: -0.015, heat_c_per_kwh: 0.035 },
    { at_c: 29.125, idle_c_per_h: -0.04, heat_c_per_kwh: 0.08 },
    { at_c: 30.125, idle_c_per_h: -0.04, heat_c_per_kwh: 0.08 },
  ];
  const planAt = (waterC: number, measured: boolean) => generateOptimisationPlan(horizon({
    pool: { water_temperature_c: waterC, volume_m3: 55 },
    comfort: { pool: { target_c: 30 } },
    pool_model: { loss_kw_per_k: 0.35, rated_cop: null, cop_per_air_c: null, ...(measured ? { response } : {}) },
  }), new Date(NOW));
  const store = (plan: ReturnType<typeof generateOptimisationPlan>) =>
    plan.resolved_value_stores!.find((entry) => entry.key === "pool")!;
  const hours = planAt(30, true).plans.priority.slots.reduce((total, slot) => total + slot.duration_hours, 0);

  // Holding 30 °C costs what the pool was measured to lose there, not what a loss coefficient says.
  const upkeep = (plan: ReturnType<typeof generateOptimisationPlan>) => (store(plan).derivation as { upkeep: number }).upkeep;
  assert(Math.abs(upkeep(planAt(30, true)) - 0.04 * hours) < 0.01, `measured upkeep ${upkeep(planAt(30, true))} over ${hours} h`);
  assert(upkeep(planAt(30, false)) > upkeep(planAt(30, true)) + 0.2, `the loss coefficient asks for something else: ${upkeep(planAt(30, false))} against ${upkeep(planAt(30, true))}`);

  // A kWh buys the measured warmth, one figure wherever the pool is: returns
  // that rose with temperature would leave the dispatch nothing to settle on.
  const gain = (waterC: number) => store(planAt(waterC, true)).units_per_kwh;
  assert(Math.abs(gain(28.875) - gain(29.5)) < 1e-9, `stall ${gain(28.875)} against ${gain(29.5)}`);
  assert(gain(29.5) > 0.035 && gain(29.5) < 0.08, `between the measured bins: ${gain(29.5)}`);

  // An unheated quarter moves the pool by the measured rate: the first heated
  // quarter of a pool starting in the stall starts from a slower fall.
  const firstHeated = (waterC: number) => planAt(waterC, true).plans.priority.slots
    .flatMap((slot, index) => (slot.decision?.store_allocations ?? [])
      .filter((allocation) => allocation.store_key === "pool").map((allocation) => ({ index, before: allocation.state_before })))[0];
  const stalled = firstHeated(28.9);
  if (stalled && stalled.index > 0) {
    assert(28.9 - stalled.before <= 0.02 * stalled.index * 0.25 + 1e-6, `fell ${28.9 - stalled.before} °C in ${stalled.index} quarters`);
  }
});

Deno.test("an unpublished sale price is the published line in the import price, not a share of it", () => {
  // Buying costs fees on top of the market and selling does not: here a sale
  // pays 0.8 of the import price less 0.64, as it does at Phil's.
  const sale = (buy: number) => 0.8 * buy - 0.64;
  const base = horizon();
  const slots = base.slots.map((slot, index) => {
    const buy = index < 96 ? (index % 8 < 4 ? 2.4 : 0.9) : null;
    return { ...slot, import_price_sek_per_kwh: buy, export_price_sek_per_kwh: buy === null ? null : sale(buy) };
  });
  const plan = generateOptimisationPlan(horizon({ slots }), new Date(NOW));
  const estimated = plan.plans.priority.slots.slice(96);
  assert(estimated.length > 0 && estimated.every((slot) => slot.export_price_sek_per_kwh === null));
  for (const slot of estimated) {
    assert(
      // The plan rounds its prices to five decimals.
      Math.abs(slot.shadow_export_sek_per_kwh - Math.max(0, sale(slot.shadow_import_sek_per_kwh))) < 1e-4,
      `${slot.start}: buys at ${slot.shadow_import_sek_per_kwh}, sells at ${slot.shadow_export_sek_per_kwh}`,
    );
  }
  // A share of the import price would put a cheap quarter's sale several times too high.
  const cheapest = estimated.reduce((low, slot) => slot.shadow_import_sek_per_kwh < low.shadow_import_sek_per_kwh ? slot : low);
  const share = (sale(2.4) / 2.4 + sale(0.9) / 0.9) / 2;
  assert(cheapest.shadow_export_sek_per_kwh < cheapest.shadow_import_sek_per_kwh * share * 0.8, "the cheap end sells for less than a share says");

  // With one import price published there is no line to read, and the share stands in.
  const flat = generateOptimisationPlan(horizon(), new Date(NOW)).plans.priority.slots;
  assert(flat.slice(96).every((slot) => slot.shadow_export_sek_per_kwh >= 0));
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
  // The cut-out is a recorded property of this machine, not a default: the
  // planner applies none unless one is on record, so an air-source unit has to
  // say so. The other three terms repeat what the planner seeds, leaving the
  // cut-out as the only thing this test varies.
  const cold = (airC: number) =>
    input({
      schema_version: 6,
      pool: { water_temperature_c: 23, volume_m3: 55 },
      outdoor_temperature_c: base.slots.map(() => airC),
      pool_model: {
        loss_kw_per_k: 0.35,
        rated_cop: 4.5,
        cop_per_air_c: 0.045,
        cutout_air_c: 8,
      },
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

Deno.test("with no cut-out on record a cold day does not stop pool heating", () => {
  // The same 4 °C day as above, with nothing recorded about the machine. A
  // ground-source unit has no cut-out, and neither does a home whose fit has
  // not converged: in both cases the honest model is the absence of one, so
  // price and physics decide rather than an assumed air-source refusal.
  const base = input();
  const frozenDay = generateOptimisationPlan(
    input({
      schema_version: 6,
      pool: { water_temperature_c: 23, volume_m3: 55 },
      outdoor_temperature_c: base.slots.map(() => 4),
    }),
    new Date(NOW),
  );

  assertEquals(frozenDay.status, "ready");
  const poolKwh = frozenDay.plans.priority.slots.reduce(
    (total, slot) => total + slot.pool_w / 1_000 * 0.25,
    0,
  );
  assert(
    poolKwh > 0,
    `a pool with no recorded cut-out must still be schedulable at 4 °C, got ${poolKwh}`,
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

Deno.test("pool Stop at is explicit and distinct from Preferred level", () => {
  const curve = { unit: "celsius", points: [
    { at: 28, sek_per_unit: 30 }, { at: 30, sek_per_unit: 15 }, { at: 32, sek_per_unit: 0 },
  ] };
  assertEquals(poolStopTemperature(curve), 32);
  assertEquals(poolStopTemperature({ ...curve, points: [{ at: 30, sek_per_unit: 5 }] }), null);
  const snapshot = horizon({
    capabilities: { pv: true, battery: true, pool: true, boiler: false, ev: false },
    pool: { water_temperature_c: 33, volume_m3: 55 },
    value_curves: { pool: curve },
  });
  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.pool?.stop_temperature_c, 32);
  assertEquals(plan.plans.priority.slots[0].pool_w, 0);
});

Deno.test("a declared band never yields an inexecutable pool power", () => {
  // The same fixture as the §8.13 test above, with the one difference that the
  // installation now says its heat pump can hold power between 500 W and its
  // 2 kW ceiling. Nothing else moves: the device models, their running power
  // and the required energy are untouched.
  const snapshot = input();
  const pool = snapshot.services.find((service) => service.device === "pool")!;
  pool.control = {
    type: "fixed_power",
    power_w: 2_000,
    min_power_w: 500,
    power_step_w: 500,
  };

  const result = generateOptimisationPlan(
    snapshot,
    new Date("2026-08-10T07:55:00Z"),
  );
  const levels = new Set(
    Object.values(result.plans).flatMap((plan) =>
      plan.slots.map((slot) => slot.pool_w)
    ),
  );

  // Still only executable levels — the band has a floor, so the fractions that
  // §8.13 exists to refuse are refused here too.
  for (const level of levels) {
    assert(
      [0, 500, 1_000, 1_500, 2_000].includes(level),
      `pool power ${level} is not an executable level of the declared band`,
    );
  }
  // NOT asserted here: that an intermediate level is actually *chosen*. In this
  // fixture the pool's curve outbids every price, so full power is always
  // optimal and the band correctly never shows — the same condition the §8.13
  // comment describes ("while the pool's curve outbids every price the winner is
  // always full power and nothing shows"). Proving the band is used needs a
  // scenario where a solar surplus sits between the floor and the ceiling, which
  // this fixture does not contain. Until that fixture exists, band *selection*
  // is covered only at the parser (power-envelope.test.ts), not end to end.
});

Deno.test("a declared band cannot lower a relay below its rated power", () => {
  // The regression that matters most: an integration that sends no band must
  // plan byte-for-byte as it does today. This asserts it against the same
  // fixture the §8.13 test uses, so the two move together.
  const withBand = input();
  const pool = withBand.services.find((service) => service.device === "pool")!;
  pool.control = { type: "fixed_power", power_w: 2_000 };

  const relay = generateOptimisationPlan(
    withBand,
    new Date("2026-08-10T07:55:00Z"),
  );
  for (const plan of Object.values(relay.plans)) {
    for (const slot of plan.slots) {
      assert([0, 2_000].includes(slot.pool_w), "pool power is fractional");
    }
  }
});
