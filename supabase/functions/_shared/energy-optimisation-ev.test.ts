import { generateOptimisationPlan, type OptimisationSnapshot, validateSnapshot } from "./energy-optimisation.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { NOW, assert, input, horizon, routedEvService } from "./energy-optimisation.fixture.ts";

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
