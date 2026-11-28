import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { dispatchedEvSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateRulesPlan } from "./rules-planner.ts";
import { prepareRoomServices, type RoomPrices } from "./rules-room-services.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { planRoomHeating, type RoomQuarter } from "./room-heating-schedule.ts";

const COMFORT_FROM = 24;
const SETBACK = 18, COMFORT = 22;

Deno.test("synthetic unreachable comfort still purchases useful recovery before the target rises", () => {
  const step = {decay: 1, offset_c: 0, stored_heat_release: 0, gain_c_per_w: .01 / 60,
    stored_heat_gain_c_per_w: 0, carry: 0};
  const quarters: RoomQuarter[] = [18, 24].map(preferred => ({
    hours: .25, steps: 15, step, transition: {...step, gain_c_per_w: .0025},
    required_c: 24, maximum_c: 30, maximum_w: 100,
    relay_w: [100], fixed_relays: [null], fixed_targets_c: [],
    room_target: {preferred_c: preferred, fixed_c: null, fixed_switches: []},
    import_sek_per_kwh: 2, export_sek_per_kwh: 1, surplus_w: 0,
  }));
  const plan = planRoomHeating(18, [], quarters, 0, undefined, [{kind: "fixed", on_w: 100}]);
  assertEquals(plan.relays_on, [[true], [true]]);
  assertAlmostEquals(plan.temperature_c[1], 18.5, 1e-10);
  assert(plan.shortfall_c.every(value => value > 0));
});

/** A floor-heated bathroom: Setback overnight, Comfort from quarter 24. */
function bathroom(prices: number[] = Array(32).fill(1)): OptimisationSnapshot {
  const s: OptimisationSnapshot = { ...dispatchedEvSnapshot(), schema_version: 7 };
  s.slots = s.slots.slice(0, 32).map((slot, i) => ({ ...slot, pv_forecast_w: 0, base_load_forecast_w: 700,
    import_price_sek_per_kwh: prices[i], export_price_sek_per_kwh: .1 }));
  s.capabilities.ev = false;
  s.ev_battery = null;
  s.services = [];
  s.captured_at = s.slots[0].start;
  const n = s.slots.length, series = (f: (i: number) => number) => Array.from({ length: n }, (_v, i) => f(i));
  s.device_models = [{ key: "floor", name: "Master bathroom floor", statistic_id: "sensor.floor", category: "heating",
    suggested_load_type: "duty_cycle", load_type: "duty_cycle", planning_role: "controllable", control_type: "setpoint",
    thermostat: { entity_id: "climate.floor", minimum_c: 5, maximum_c: 35, step_c: .5, current_temperature_c: SETBACK, target_temperature_c: SETBACK, hvac_action: "idle" },
    active_power_w: 2000, profile_sample_count: 1000, forecast_w_by_slot: series(() => 500) }];
  s.outdoor_temperature_c = series(() => 0);
  const objective = series(i => i >= COMFORT_FROM ? COMFORT : SETBACK);
  s.thermal_zones = [{ key: "bathroom", name: "Master bathroom", device_keys: ["floor"],
    model: { gain_c_per_wh: .001, cooling_constant_per_h: .02, background_gain_c_per_h: 0, thermal_capacity_wh_per_c: 1000,
      heat_loss_w_per_c: 20, time_constant_h: 50, heating_rate_c_per_h: 2, r2: .95, sample_count: 1000, residual_std_c: .1 },
    start_temperature_c: SETBACK, rated_power_w: 2000, comfort_min_c: objective, target_c: objective,
    comfort_max_c: series(() => COMFORT + .5), maximum_power_w_by_slot: series(() => 2000), unplanned_power_w: series(() => 500) }];
  return s;
}

const prices = (importPrice: number[]): RoomPrices => ({ import_sek_per_kwh: importPrice,
  export_sek_per_kwh: importPrice.map(() => .1), surplus_w: importPrice.map(() => 0) });
const cost = (power: number[], price: number[]) => power.reduce((sum, w, i) => sum + w / 1000 * .25 * price[i], 0);
/** Cheap night hours, an expensive morning run-up, then the Comfort period. */
const nightTariff = Array.from({ length: 32 }, (_v, i) => i < 12 ? .2 : i < COMFORT_FROM ? 3 : 1);

Deno.test("flat prices recover as late as possible and reach Comfort when its first quarter begins", () => {
  const s = bathroom();
  const rooms = prepareRoomServices(s, [], undefined, prices(Array(32).fill(1)));
  const power = rooms.room_power.bathroom, temperature = rooms.temperature.bathroom as number[];
  // temperature[i] is the end of quarter i, so i = 23 is the start of quarter 24.
  assert(temperature[COMFORT_FROM - 1] >= COMFORT - 1e-6);
  assert(temperature.slice(COMFORT_FROM).every(t => t >= COMFORT - 1e-6));
  // Without a price reason the floor only holds Setback before recovering.
  assert(temperature.slice(0, 8).every(t => t >= SETBACK - 1e-6 && t <= SETBACK + .55), "no early preheat");
  assert(power[COMFORT_FROM - 1] > 0, "recovery runs right up to the deadline");
  assertEquals(rooms.warnings.filter(w => w.code === "comfort_shortfall"), []);
});

Deno.test("cheap night hours carry the recovery and the deadline still holds", () => {
  const s = bathroom();
  const flat = prepareRoomServices(s, [], undefined, prices(Array(32).fill(1))).room_power.bathroom;
  const rooms = prepareRoomServices(s, [], undefined, prices(nightTariff));
  const power = rooms.room_power.bathroom, temperature = rooms.temperature.bathroom as number[];
  assert(temperature[COMFORT_FROM - 1] >= COMFORT - 1e-6);
  assert(temperature.every(t => t <= COMFORT + .5 + 1e-6), "heat never lifts the floor above its ceiling");
  const expensive = (p: number[]) => p.slice(12, COMFORT_FROM).reduce((a, w) => a + w, 0);
  assert(power.slice(0, 12).some(w => w > 0), "the cheap hours are used");
  assert(expensive(power) < expensive(flat) / 2, `expensive heat ${expensive(power)} vs ${expensive(flat)}`);
  assert(cost(power, nightTariff) < cost(flat, nightTariff));
});

Deno.test("Setpoint heating publishes only a Boolean and consumes full measured power", () => {
  const rooms = prepareRoomServices(bathroom(), [], undefined, prices(nightTariff));
  rooms.commands.floor.forEach((command, i) => {
    assert(command.type === "heating_schedule");
    assertEquals(Object.keys(command).sort(), ["heating", "type"]);
    assertEquals(rooms.power.floor[i], command.heating ? 2000 : 0);
  });
});

Deno.test("solar surplus is priced as foregone export", () => {
  const s = bathroom();
  const sunny = prices(Array(32).fill(2));
  sunny.surplus_w = Array.from({ length: 32 }, (_v, i) => i >= 4 && i < 8 ? 3000 : 0);
  const power = prepareRoomServices(s, [], undefined, sunny).room_power.bathroom;
  assert(power.slice(4, 8).some(w => w > 0), "free surplus warms the floor early");
});

Deno.test("an unreachable deadline gets the closest recovery and a warning, never a refusal", () => {
  const s = bathroom(nightTariff);
  s.thermal_zones![0].start_temperature_c = 5;
  const rooms = prepareRoomServices(s, [], undefined, prices(nightTariff));
  assert(rooms.room_power.bathroom.slice(0, COMFORT_FROM).every(w => Math.abs(w - 2000) < 1e-6));
  assert(rooms.warnings.some(w => w.code === "comfort_shortfall"));
  assertEquals(rooms.commands.floor.length, s.slots.length);
});

Deno.test("committed quarters and shared headroom bind the room plan", () => {
  const s = bathroom();
  const retained = [{ device_commands: { floor: { type: "heating_schedule" as const, heating: true } },
    device_loads_w: { floor: 1234 } }];
  const rooms = prepareRoomServices(s, retained, Array(32).fill(900), prices(nightTariff));
  assertAlmostEquals(rooms.room_power.bathroom[0], 2000); // Retain target 19, not the obsolete 1234 W forecast.
  assertEquals(rooms.commands.floor[0], retained[0].device_commands.floor);
  assert(rooms.room_power.bathroom.slice(1).every(w => w <= 900 + 1e-9));
});

Deno.test("the household planner moves bathroom recovery into the cheap hours", () => {
  const plan = generateRulesPlan(rulesFixtureInput(bathroom(nightTariff))).plan;
  const slots = plan.plans.priority.slots;
  const heat = slots.map(slot => slot.device_loads_w.floor);
  assert(heat.slice(0, 12).some(w => w > 0));
  const before = slots[COMFORT_FROM - 1].device_commands!.floor;
  assert(before.type === "heating_schedule");
  assert((plan.thermal_projection!.zones[0].planned_temperature_c[COMFORT_FROM - 1]) >= COMFORT);
  assert(!plan.planning_warnings?.some(w => w.code === "comfort_shortfall"));
});

/** The same bathroom with a towel rack on a smart plug: whole quarters only. */
function bathroomWithRack(prices?: number[], rackW = 150): OptimisationSnapshot {
  const s = bathroom(prices);
  s.device_models.push({ ...s.device_models[0], key: "rack", name: "Heated towel rack", statistic_id: "sensor.rack",
    load_type: "fixed_full_load", suggested_load_type: "fixed_full_load", control_type: "switch_schedule",
    active_power_w: rackW, forecast_w_by_slot: s.slots.map(() => 0) });
  s.thermal_zones![0].device_keys.push("rack");
  return s;
}

Deno.test("a relay in a thermostat room no longer drops the room out of deadline planning", () => {
  const s = bathroomWithRack();
  const rooms = prepareRoomServices(s, [], undefined, prices(nightTariff));
  const temperature = rooms.temperature.bathroom as number[];
  assert(temperature[COMFORT_FROM - 1] >= COMFORT - 1e-6, "Comfort is reached when its first quarter begins");
  assert(temperature.slice(COMFORT_FROM).every(t => t >= COMFORT - 1e-6));
  assertEquals(rooms.warnings.filter(w => w.code === "comfort_shortfall"), []);
  const before = rooms.commands.floor[COMFORT_FROM - 1];
  assert(before.type === "heating_schedule");
  assert((rooms.temperature.bathroom[COMFORT_FROM - 1] as number) >= COMFORT);
});

Deno.test("relays run whole quarters and the room's power is the sum of its members", () => {
  const rooms = prepareRoomServices(bathroomWithRack(), [], undefined, prices(nightTariff));
  rooms.commands.rack.forEach((command, i) => {
    assert(command.type === "switch_schedule");
    assert(command.on_seconds === 0 || command.on_seconds === 900);
    assertEquals(rooms.power.rack[i], command.on_seconds ? 150 : 0);
    assertAlmostEquals(rooms.room_power.bathroom[i], rooms.power.rack[i] + rooms.power.floor[i], 1e-6);
    assert(rooms.power.floor[i] >= -1e-9 && rooms.power.floor[i] <= 2000 + 1e-6);
  });
});

Deno.test("the rack adds its heat when the floor alone cannot make the deadline", () => {
  const s = bathroomWithRack();
  s.device_models[0].active_power_w = 1000;
  const rooms = prepareRoomServices(s, [], undefined, prices(Array(32).fill(1)));
  assert(rooms.commands.rack.some(c => c.type === "switch_schedule" && c.on_seconds === 900));
  assert((rooms.temperature.bathroom as number[])[COMFORT_FROM - 1] >= COMFORT - 1e-6);
});

Deno.test("a relay alone carries a modelled room to its deadline", () => {
  const s = bathroomWithRack(undefined, 2000);
  s.device_models = s.device_models.filter(m => m.key === "rack");
  s.thermal_zones![0].device_keys = ["rack"];
  const rooms = prepareRoomServices(s, [], undefined, prices(nightTariff));
  const temperature = rooms.temperature.bathroom as number[];
  assert(temperature[COMFORT_FROM - 1] >= COMFORT - 1e-6);
  assert(rooms.power.rack.every(w => w === 0 || w === 2000));
  assertEquals(rooms.commands.floor, undefined);
});

Deno.test("a committed relay quarter keeps its retained state and power", () => {
  const s = bathroomWithRack();
  const retained = [{ device_commands: { rack: { type: "switch_schedule" as const, on_seconds: 900 } },
    device_loads_w: { rack: 140 } }];
  const rooms = prepareRoomServices(s, retained, undefined, prices(Array(32).fill(5)));
  assertEquals(rooms.commands.rack[0], retained[0].device_commands.rack);
  assertEquals(rooms.power.rack[0], 150); // Its measured running rating, not retained forecast watts.
});

Deno.test("the household planner plans the towel rack with the floor", () => {
  const plan = generateRulesPlan(rulesFixtureInput(bathroomWithRack(nightTariff))).plan;
  const slots = plan.plans.priority.slots;
  assert(slots.every(slot => slot.device_commands!.rack.type === "switch_schedule"));
  const before = slots[COMFORT_FROM - 1].device_commands!.floor;
  assert(before.type === "heating_schedule");
  assert((plan.thermal_projection!.zones[0].planned_temperature_c[COMFORT_FROM - 1]) >= COMFORT);
  assert(!plan.planning_warnings?.some(w => w.code === "comfort_shortfall"));
});

/** The bathroom fitted against its house, with its floor's heat arriving through a delay. */
function delayedBathroom(lag: number, prices?: number[]): OptimisationSnapshot {
  const s = bathroom(prices);
  s.thermal_zones![0].model = { ...s.thermal_zones![0].model!, cooling_constant_per_h: 0, background_gain_c_per_h: -0.5,
    house_coupling_per_h: 0.1, heat_lag_h: lag };
  s.house_temperature_c = s.slots.map(() => 21);
  // Heat reaches a delayed room late, so one exactly at Setback with a cold
  // floor dips below it before anything can arrive.
  s.thermal_zones![0].start_temperature_c = SETBACK + .3;
  return s;
}
/** Where the recovery starts: more than holding Setback against the house. */
const firstHeat = (power: number[]) => power.findIndex(w => w > 1000);

Deno.test("a delayed floor starts its recovery earlier and still makes the deadline", () => {
  const immediate = prepareRoomServices(delayedBathroom(0), [], undefined, prices(Array(32).fill(1)));
  const delayed = prepareRoomServices(delayedBathroom(2), [], undefined, prices(Array(32).fill(1)));
  const temperature = delayed.temperature.bathroom as number[];
  assert(temperature[COMFORT_FROM - 1] >= COMFORT - 1e-6, `reached ${temperature[COMFORT_FROM - 1]}`);
  assert(firstHeat(delayed.room_power.bathroom) < firstHeat(immediate.room_power.bathroom),
    "heat that arrives late has to start early");
  assertEquals(delayed.warnings.filter(w => w.code === "comfort_shortfall"), []);
});

Deno.test("cheap hours never park heat in the floor above the ceiling", () => {
  const cheapFirst = Array.from({ length: 32 }, (_v, i) => i < 16 ? .05 : 5);
  const rooms = prepareRoomServices(delayedBathroom(2), [], undefined, prices(cheapFirst));
  const temperature = rooms.temperature.bathroom as number[];
  assert(temperature.every(t => t <= COMFORT + .5 + .05), `peak ${Math.max(...temperature)}`);
  assert(temperature[COMFORT_FROM - 1] >= COMFORT - 1e-6);
});

Deno.test("heat already in the floor at the start is counted", () => {
  const s = delayedBathroom(2);
  const cold = prepareRoomServices(s, [], undefined, prices(Array(32).fill(1))).temperature.bathroom as number[];
  s.thermal_zones![0].start_stored_heat_c = 2000 * s.thermal_zones![0].model!.gain_c_per_wh * 2;
  const warm = prepareRoomServices(s, [], undefined, prices(Array(32).fill(1))).temperature.bathroom as number[];
  assert(warm[3] > cold[3] + .1, "a floor that was just heated keeps warming the room");
});

Deno.test("a house-coupled room without the house forecast is not run on a guess", () => {
  const s = delayedBathroom(2);
  delete s.house_temperature_c;
  const rooms = prepareRoomServices(s, [], undefined, prices(Array(32).fill(1)));
  assert(rooms.temperature.bathroom.every(t => t === null));
  assert(rooms.warnings.some(w => w.code === "room_estimate"));
  assertEquals(rooms.commands.floor.length, s.slots.length);
});

Deno.test("missing native observations hold settings and empirical power without invented temperature", () => {
  const s = bathroom();
  s.device_models[0].thermostat = null;
  const rooms = prepareRoomServices(s);
  assert(rooms.commands.floor.every(c => c.type === "unavailable"));
  assertEquals(rooms.power.floor, s.device_models[0].forecast_w_by_slot);
  assert(rooms.temperature.bathroom.every(t => t === null));
  assert(rooms.warnings.some(w => w.code === "room_estimate"));
});

Deno.test("multiple native actuators retain separate interval decisions and power contributions", () => {
  const s = bathroom();
  s.device_models[0].active_power_w = 1000;
  s.device_models.push({ ...s.device_models[0], key: "second", name: "Second heater",
    thermostat: { ...s.device_models[0].thermostat!, entity_id: "climate.second", current_temperature_c: 19, hvac_action: "heating" } });
  s.thermal_zones![0].device_keys.push("second");
  const rooms = prepareRoomServices(s, [], undefined, prices(nightTariff));
  rooms.room_power.bathroom.forEach((w, i) => {
    assertAlmostEquals(w, rooms.power.floor[i] + rooms.power.second[i], 1e-8);
    assert(w <= 2000 + 1e-8);
  });
  assert((rooms.temperature.bathroom[COMFORT_FROM - 1] as number) >= COMFORT);
});

Deno.test("a native minimum that cannot express no-heat retains settings and visible demand", () => {
  const s = bathroom();
  s.thermal_zones![0].start_temperature_c = 4;
  s.device_models[0].thermostat = { ...s.device_models[0].thermostat!, current_temperature_c: 4, target_temperature_c: 5 };
  const rooms = prepareRoomServices(s, [], s.slots.map(() => 0), prices(Array(32).fill(1)));
  assert(rooms.power.floor[0] > 0);
  assert(rooms.commands.floor.every(c => c.type === "unavailable"));
});

Deno.test("mixed rooms retain each member's interval commands and full draw", () => {
  const snapshot = bathroomWithRack(); snapshot.schema_version = 12;
  const held = { type: "switch_schedule", on_seconds: 900 } as const;
  const result = prepareRoomServices(snapshot, [{device_commands: {rack: held}}], undefined, prices(nightTariff));
  assertEquals(result.commands.rack[0], held);
  for (let i = 0; i < snapshot.slots.length; i++) {
    const relay = result.commands.rack[i], floor = result.commands.floor[i];
    assert(relay.type === "switch_schedule" && floor.type === "heating_schedule");
    assertEquals(result.power.rack[i], relay.on_seconds ? 150 : 0);
    assertEquals(result.power.floor[i], floor.heating ? 2000 : 0);
    assertEquals(result.room_power.bathroom[i], result.power.rack[i] + result.power.floor[i]);
  }
});

Deno.test("two fixed heaters never share a quarter through fractional duty", () => {
  const snapshot = bathroomWithRack(undefined, 1000); snapshot.schema_version = 12;
  const relay = snapshot.device_models[1]; snapshot.device_models = [relay, {...relay,key: "rack2"}];
  const zone = snapshot.thermal_zones![0]; zone.device_keys = ["rack", "rack2"];
  zone.maximum_power_w_by_slot.fill(1000);
  const result = prepareRoomServices(snapshot);
  assert(result.room_power.bathroom.every(w => w === 0 || w === 1000));
  for (const key of zone.device_keys) assert(result.power[key].every(w => w === 0 || w === 1000));
  zone.model = null;
  const estimated = prepareRoomServices(snapshot);
  assert(estimated.commands.rack.every(c => c.type === "unavailable"));
  assert(estimated.warnings.some(w => w.code === "room_estimate"));
});

Deno.test("a sparse fit cannot turn a brief comfort target into full-power preheating", () => {
  const snapshot = bathroomWithRack();
  snapshot.schema_version = 12;
  const relay = snapshot.device_models[1];
  relay.relay_on = false;
  relay.forecast_w_by_slot.fill(40);
  snapshot.device_models = [relay];
  const zone = snapshot.thermal_zones![0];
  zone.device_keys = [relay.key];
  zone.unplanned_power_w.fill(relay.active_power_w!);
  assert(zone.model && "gain_c_per_wh" in zone.model);
  zone.target_c = zone.target_c.map((_, i) => i === COMFORT_FROM ? COMFORT : SETBACK);
  zone.comfort_min_c = zone.target_c;
  zone.model = { ...zone.model, gain_c_per_wh: .00003 };
  zone.model_warnings = ["insufficient_heating"];
  zone.model_source = { kind: "shared", revision: "synthetic-weak-heater" };
  const accepted = { type: "switch_schedule", on_seconds: 900 } as const;
  const result = prepareRoomServices(snapshot, [{ device_commands: { [relay.key]: accepted } }], undefined, prices(nightTariff));

  assertEquals(result.commands[relay.key][0], accepted);
  result.commands[relay.key].slice(1).forEach((command, i) => {
    assertEquals(command.type, "unavailable");
  });
  assertEquals(result.power[relay.key], [relay.active_power_w!, ...relay.forecast_w_by_slot.slice(1)]);
  assertEquals(result.unplanned_power[zone.key], relay.forecast_w_by_slot);
  assert(result.temperature[zone.key].every(value => value === null));
  assertEquals(result.heating_model_use?.[zone.key].thermal[0].source.kind, "empirical");
  assert(result.warnings.some(warning => warning.message.includes("too few measured heating observations")));
});

/** Synthetic resistive room, independent of household observations. */
function sharedRelayRoom(): OptimisationSnapshot {
  const snapshot = bathroomWithRack(undefined, 2000);
  snapshot.schema_version = 12;
  const relay = { ...snapshot.device_models[1], relay_on: false };
  snapshot.device_models = [relay];
  const zone = snapshot.thermal_zones![0];
  zone.device_keys = [relay.key];
  zone.start_temperature_c = 20;
  zone.target_c = zone.target_c.map((_, i) => i === COMFORT_FROM ? 21 : 17);
  zone.comfort_min_c = zone.target_c;
  zone.maximum_power_w_by_slot.fill(2000);
  zone.rated_power_w = 2000;
  return snapshot;
}

Deno.test("a weak supported response may purchase partial recovery while retaining accepted commands", () => {
  const snapshot = sharedRelayRoom();
  const zone = snapshot.thermal_zones![0];
  assert(zone.model && "gain_c_per_wh" in zone.model);
  zone.model = { ...zone.model, gain_c_per_wh: .000001, sample_count: 10000 };
  const accepted = {type: "switch_schedule", on_seconds: 0} as const;
  const result = prepareRoomServices(snapshot, [{device_commands: {rack: accepted}}], undefined,
    prices(snapshot.slots.map(() => 2)));
  assertEquals(result.commands.rack[0], accepted);
  result.commands.rack.slice(1).forEach((command, i) => {
    assert(command.type === "switch_schedule");
  });
  const exposure = (temperatures: Array<number | null>) => temperatures.reduce<number>((sum, temperature, i) =>
    sum + Math.max(0, Math.max(zone.comfort_min_c[i], zone.comfort_min_c[i + 1] ?? zone.comfort_min_c[i]) - temperature!) * .25, 0);
  assert(exposure(result.temperature.bathroom) < exposure(result.unplanned_temperature.bathroom));
  assert(result.room_power.bathroom.every(watts => watts === 0 || watts === 2000));
});

Deno.test("schedule comparison preserves genuine sustained heating demand", () => {
  const snapshot = sharedRelayRoom();
  snapshot.outdoor_temperature_c!.fill(-25);
  const zone = snapshot.thermal_zones![0];
  zone.target_c.fill(24);
  zone.comfort_min_c.fill(24);
  zone.start_temperature_c = 10;
  const result = prepareRoomServices(snapshot, [], undefined, prices(snapshot.slots.map(() => 2)));
  assert(result.room_power.bathroom.every(watts => Math.abs(watts - 2000) < 1e-6));
});

Deno.test("schedule comparison pays to preheat for a comfort deadline the literal schedule misses", () => {
  const snapshot = sharedRelayRoom();
  const zone = snapshot.thermal_zones![0];
  const deadline = 8;
  zone.start_temperature_c = 18;
  zone.target_c = zone.target_c.map((_, i) => i >= deadline ? 21 : 18);
  zone.comfort_min_c = zone.target_c;
  snapshot.outdoor_temperature_c!.fill(0);
  assert(zone.model && "gain_c_per_wh" in zone.model);
  zone.model = {...zone.model, gain_c_per_wh: .001, cooling_constant_per_h: .025,
    house_coupling_per_h: .08, background_gain_c_per_h: 0};
  snapshot.house_temperature_c = snapshot.slots.map(() => 20);
  // Flat prices: preheating can only cost more than following the schedule.
  const result = prepareRoomServices(snapshot, [], undefined, prices(snapshot.slots.map(() => 2)));
  assert(result.room_power.bathroom.slice(0, deadline).some(watts => watts > 0), "heat starts before the deadline");
  assert(result.commands.rack.slice(0, deadline).some(command => command.type === "switch_schedule" && command.on_seconds === 900));
  assert(result.temperature.bathroom[deadline - 1]! >= 21 - 1e-3, "the preceding quarter ends warm when comfort starts");
});

Deno.test("schedule comparison preserves an exact comfort deadline even when literal heating catches up within its first quarter", () => {
  // Independent synthetic lossless plant: 600 W supplies 0.1 °C per minute.
  // Literal targets [20, 21] recover within the second quarter, but miss its
  // starting boundary. The more expensive first quarter must still preheat.
  const step = { decay: 1, offset_c: 0, stored_heat_release: 0, gain_c_per_w: .01 / 60,
    stored_heat_gain_c_per_w: 0, carry: 0 };
  const actuator = { relay: true, power_w: 600, sensor_offset_c: 0, current_temperature_c: 20,
    minimum_c: 0, maximum_c: 100, step_c: .1, target_temperature_c: 20,
    entity_id: "synthetic-heater", hvac_action: "idle" as const };
  const quarters: RoomQuarter[] = [20, 21].map((preferred, i) => ({
    hours: .25, steps: 15, step, transition: { ...step, gain_c_per_w: .01 * .25 },
    required_c: 21, maximum_c: 22, maximum_w: 600, relay_budget_w: 600,
    relay_w: [], fixed_relays: [], fixed_targets_c: [null],
    room_target: { preferred_c: preferred, fixed_c: null, fixed_switches: [null] },
    import_sek_per_kwh: i === 0 ? 2 : 1, export_sek_per_kwh: 1, surplus_w: 0,
  }));
  const plan = planRoomHeating(20, [actuator], quarters);
  assert(plan.temperature_c[0] >= 21 - 1e-9, "21 °C must be reached before the first comfort quarter starts");
  assert(plan.power_w[0] > 0, "the price premium cannot postpone a comfort deadline");
  let temperature = 20, on = false;
  for (let i = 0; i < quarters.length; i++) {
    let wh = 0;
    for (let minute = 0; minute < 15; minute++) {
      on = temperature < plan.room_targets_c![i] + (on ? .25 : 0);
      if (on) { temperature += .1; wh += 10; }
    }
    assertAlmostEquals(temperature, plan.temperature_c[i], 1e-9);
    assertAlmostEquals(wh * 4, plan.power_w[i], 1e-9);
    assert(temperature >= 21 - 1e-9);
  }
});

Deno.test("schedule comparison accepts cheaper heating that improves scheduled comfort", () => {
  const snapshot = sharedRelayRoom();
  const zone = snapshot.thermal_zones![0];
  zone.target_c = zone.target_c.map((_, i) => i >= 4 ? 21 : 18);
  zone.comfort_min_c = zone.target_c;
  snapshot.outdoor_temperature_c!.fill(14);
  assert(zone.model && "gain_c_per_wh" in zone.model);
  zone.model = {...zone.model, gain_c_per_wh: .001, cooling_constant_per_h: .025,
    house_coupling_per_h: .08, background_gain_c_per_h: .05};
  snapshot.house_temperature_c = snapshot.slots.map(() => 20);
  const result = prepareRoomServices(snapshot, [], undefined,
    prices(snapshot.slots.map((_, i) => i < 4 ? .25 : 4)));
  assert(result.room_power.bathroom.slice(0, 4).some(watts => watts > 0));
  assert(result.commands.rack.slice(0, 4).some(command => command.type === "switch_schedule" && command.on_seconds === 900));
  assert(result.temperature.bathroom.slice(4).every(c => c !== null && c >= 20.75));
});

Deno.test("literal schedule cannot start a native heater beyond available headroom", () => {
  const snapshot = bathroom();
  snapshot.schema_version = 12;
  const zone = snapshot.thermal_zones![0];
  zone.start_temperature_c = 20;
  zone.target_c.fill(24);
  zone.comfort_min_c.fill(24);
  snapshot.device_models[0].thermostat = {...snapshot.device_models[0].thermostat!,
    current_temperature_c: 20, target_temperature_c: 24};
  const result = prepareRoomServices(snapshot, [], snapshot.slots.map(() => 1000),
    prices(snapshot.slots.map(() => 2)));
  assert(result.power.floor.every(watts => watts === 0));
});
