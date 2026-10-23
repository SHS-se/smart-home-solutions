import { runRulesPlanner } from "./run-rules-planner.ts";
import { type OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { NOW, assert, input, horizon, routedEvService } from "./planner/energy-optimisation.fixture.ts";

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
    ev_battery: { kwh_per_km: .2,
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

  const plan = runRulesPlanner({ snapshot: snapshot, now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;
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
    ev_battery: { kwh_per_km: .2,
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

  const plan = runRulesPlanner({ snapshot: snapshot, now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;
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
    ev_battery: { kwh_per_km: .2,
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

  const plan = runRulesPlanner({ snapshot: snapshot, now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;

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
    ev_battery: { kwh_per_km: .2,
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

  const plan = runRulesPlanner({ snapshot: snapshot, now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;
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
    slot.ev_soc !== null && slot.ev_soc > 0.8 + 1e-6
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
    ev_battery: { kwh_per_km: .2,
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

  const plan = runRulesPlanner({ snapshot: snapshot, now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;
  const charged = plan.plans.priority.slots.reduce(
    (total, slot) => total + slot.ev_w,
    0,
  ) / 4_000;

  assert(
    charged < 0.5,
    `a car already past its limit has no room left to sell into, got ${charged} kWh`,
  );
  assertEquals(plan.ev_battery!.soc,.99,"the measured state above a desired limit remains authoritative");
  assert(plan.plans.priority.slots.every(s=>s.ev_target_current_a===0),"no charge request above its physical charge limit");
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
    ev_battery: { kwh_per_km: .2,
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

  const plan=runRulesPlanner({snapshot,now:NOW,price_archive:[]}).plan;
  assertEquals(plan.status,"ready");assertEquals(plan.capabilities.ev,false);
  assert(plan.planning_warnings!.some(w=>w.code==="ev_service_evidence"),"missing charger evidence remains visible");
});

Deno.test("a single-phase charger is planned at the power its cable delivers", () => {
  // The defect this pins: the planner assumed three 230 V phases regardless of
  // what the installation declared, so a single-phase 16 A charger — 3.7 kW —
  // was dispatched as an 11 kW load. Nothing failed; the plan was simply wrong
  // about how fast the car could fill, and confidently so.
  const vehicle = { kwh_per_km:.2,
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
    const plan = runRulesPlanner({ snapshot: horizon({
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
      }), now: (new Date(NOW)).toISOString(), price_archive: [] }).plan;
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

Deno.test("the native planner uses the vehicle's own consumption when buying range",async()=>{
 const {dispatchedEvSnapshot}=await import("../../../scripts/generate-ha-plan-fixture.ts");
 const s=dispatchedEvSnapshot();const solve=(consumption:number)=>{s.ev_battery!.kwh_per_km=consumption;
  return runRulesPlanner({snapshot:s,now:s.captured_at,price_archive:[]}).plan.plans.priority.slots.reduce((total,slot)=>total+slot.ev_w*.25/1000,0);};
 assert(solve(.24)>solve(.14),"the thirstier car needs more electricity for the same requested range");
});

Deno.test("unplugging preserves the car's planned energy while cable telemetry stays false", async () => {
  const { dispatchedEvSnapshot } = await import(
    "../../../scripts/generate-ha-plan-fixture.ts"
  );
  const snapshot = dispatchedEvSnapshot();
  const now = new Date(snapshot.captured_at);
  const connected = runRulesPlanner({ snapshot: snapshot, now: (now).toISOString(), price_archive: [] }).plan;
  snapshot.ev_battery!.connected = false;
  const unplugged = runRulesPlanner({ snapshot: snapshot, now: (now).toISOString(), price_archive: [] }).plan;
  assertEquals(unplugged.validation_errors, []);
  assertEquals(unplugged.ev_battery!.connected, false);
  assert(connected.plans.priority.slots.some(s=>s.ev_w>0),"connected fixture must charge");
  assertEquals(unplugged.plans.priority.slots.map(slot => slot.ev_w), connected.plans.priority.slots.map(slot => slot.ev_w));
  assert(unplugged.plans.priority.slots.some(slot => slot.ev_w > 0), "the unplugged car must still be planned");
  assert(unplugged.plans.priority.slots.some(slot => slot.ev_charging_conditional), "future charging must disclose its connection dependency");
  assert(
    unplugged.plans.priority.slots.every((slot) => !slot.ev_connected),
    "do not invent a cable connection",
  );
});
