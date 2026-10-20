import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { dispatchedEvSnapshot, rulesFixtureInput } from "../../../scripts/generate-ha-plan-fixture.ts";
import { generateRulesPlan } from "./rules-planner.ts";
import { prepareRoomServices, type RoomPrices } from "./rules-room-services.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";

const COMFORT_FROM = 24;
const SETBACK = 18, COMFORT = 22;

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
  assert(temperature.slice(0, 8).every(t => Math.abs(t - SETBACK) < .01), "no early preheat");
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

Deno.test("each setpoint is the planned temperature at the end of its quarter", () => {
  const s = bathroom();
  const rooms = prepareRoomServices(s, [], undefined, prices(nightTariff));
  const temperature = rooms.temperature.bathroom as number[];
  rooms.commands.floor.forEach((command, i) => {
    assert(command.type === "setpoint");
    assertEquals(command.minimum_c, s.thermal_zones![0].comfort_min_c[i]);
    assertEquals(command.maximum_c, COMFORT + .5);
    assert(command.minimum_c <= command.target_c && command.target_c <= command.maximum_c);
    assertAlmostEquals(command.target_c, Math.max(command.minimum_c, temperature[i]), .006);
  });
  // The quarter before Comfort already asks for Comfort.
  const before = rooms.commands.floor[COMFORT_FROM - 1];
  assert(before.type === "setpoint" && before.target_c >= COMFORT);
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
  assert(rooms.room_power.bathroom.slice(0, COMFORT_FROM).every(w => w === 2000));
  assert(rooms.warnings.some(w => w.code === "comfort_shortfall"));
  assertEquals(rooms.commands.floor.length, s.slots.length);
});

Deno.test("committed quarters and shared headroom bind the room plan", () => {
  const s = bathroom();
  const retained = [{ device_commands: { floor: { type: "setpoint" as const, target_c: 19, minimum_c: 18, maximum_c: 22.5 } },
    device_loads_w: { floor: 1234 } }];
  const rooms = prepareRoomServices(s, retained, Array(32).fill(900), prices(nightTariff));
  assertEquals(rooms.room_power.bathroom[0], 1234);
  assertEquals(rooms.commands.floor[0], retained[0].device_commands.floor);
  assert(rooms.room_power.bathroom.slice(1).every(w => w <= 900 + 1e-9));
});

Deno.test("the household planner moves bathroom recovery into the cheap hours", () => {
  const plan = generateRulesPlan(rulesFixtureInput(bathroom(nightTariff))).plan;
  const slots = plan.plans.priority.slots;
  const heat = slots.map(slot => slot.device_loads_w.floor);
  assert(heat.slice(0, 12).some(w => w > 0));
  const before = slots[COMFORT_FROM - 1].device_commands!.floor;
  assert(before.type === "setpoint" && before.target_c >= COMFORT);
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
  assert(before.type === "setpoint" && before.target_c >= COMFORT, "the thermostat is asked for Comfort ahead of it");
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
  assertEquals(rooms.power.rack[0], 140);
});

Deno.test("the household planner plans the towel rack with the floor", () => {
  const plan = generateRulesPlan(rulesFixtureInput(bathroomWithRack(nightTariff))).plan;
  const slots = plan.plans.priority.slots;
  assert(slots.every(slot => slot.device_commands!.rack.type === "switch_schedule"));
  const before = slots[COMFORT_FROM - 1].device_commands!.floor;
  assert(before.type === "setpoint" && before.target_c >= COMFORT);
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
  s.thermal_zones![0].start_delivered_w = 2000;
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
