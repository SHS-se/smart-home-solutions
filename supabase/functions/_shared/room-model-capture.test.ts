import { assert, assertEquals } from "@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { cpuPlanningSource } from "../../../tests/planner-handler-cpu.fixture.ts";
import { prepareRoomModels, captureRoomPlanningState, type RoomDeviceMapping } from "./room-model-capture.ts";
import { prepareRoomServices } from "./rules-room-services.ts";
import type { DeviceModelBundle } from "./device-model-store.ts";

function syntheticCapture() {
  const snapshot = cpuPlanningSource(true).snapshot;
  const rooms = snapshot.thermal_zones!;
  const mappings: RoomDeviceMapping[] = rooms.map(room => ({ key: room.device_keys[0],
    control_type_override: "setpoint", room: { key: room.key, name: room.name } }));
  const bundle: DeviceModelBundle = { rooms: rooms.filter(room => room.model).map((room, index) => ({
    ...room.model, model_revision: index + 1, room_key: room.key, trained: true,
  })).reverse(), pool: null, devices: [], revisions: { rooms: {}, pool: null } };
  snapshot.thermal_zones = [];
  return { snapshot, mappings, bundle };
}

Deno.test("room model assembly keeps inventory order and joins calibration by room identity", () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const before = structuredClone({ snapshot, mappings, bundle });
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  assertEquals(prepared.rooms.map(room => room.key), mappings.map(mapping => mapping.room!.key));
  assertEquals(prepared.rooms[0].model?.gain_c_per_wh, bundle.rooms.at(-1)!.gain_c_per_wh);
  assertEquals(prepared.rooms[0].rated_power_w, 800);
  assertEquals(prepared.rooms[0].device_keys, [mappings[0].key]);
  assertEquals(prepared.rooms.at(-1)!.model, null);
  assertEquals({ snapshot, mappings, bundle }, before);
});

Deno.test("unavailable calibration retains mapped rooms and measured electrical demand", () => {
  const { snapshot, mappings } = syntheticCapture();
  const prepared = prepareRoomModels(snapshot, mappings, null);
  assertEquals(prepared.rooms.length, 9);
  assertEquals(prepared.rooms.every(room => room.model === null), true);
  assertEquals(prepared.rooms.every(room => room.rated_power_w === 800), true);
  assertEquals(prepared.snapshot.device_models, snapshot.device_models);
});

Deno.test("capture reads current temperatures and routines without selecting models or running search", async () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  const calls: string[] = [];
  const db = createClient("http://localhost:54321", "synthetic-service", {
    auth: { persistSession: false }, global: { fetch: (url) => {
      const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
      calls.push(endpoint);
      if (endpoint === "get_energy_latest_room_temperatures") return Promise.resolve(Response.json(
        prepared.rooms.map(room => ({ room_key: room.key, room_temperature_c: 19 }))));
      if (endpoint === "energy_optimisation_comfort_schedules") return Promise.resolve(Response.json(
        prepared.rooms.map(room => ({ room_key: room.key, weekday_modes: Array(96).fill("high-temp"),
          weekend_modes: Array(96).fill("high-temp"), off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21 }))));
      if (endpoint === "get_energy_thermal_training_quarters") return Promise.resolve(Response.json([]));
      throw new Error(`Unexpected capture dependency ${endpoint}`);
    } },
  });
  const result = await captureRoomPlanningState(db, "synthetic-customer", "synthetic-home", prepared.snapshot, prepared.rooms);
  assertEquals(calls.sort(), ["energy_optimisation_comfort_schedules", "get_energy_latest_room_temperatures", "get_energy_thermal_training_quarters"]);
  assertEquals(result.thermal_zones!.map(room => room.key), prepared.rooms.map(room => room.key));
  assertEquals(result.thermal_zones!.every(room => room.start_temperature_c === 19), true);
  assertEquals(result.thermal_zones!.every(room => room.target_c.every(value => value === 21)), true);
  assertEquals(result.thermal_zones![0].model, prepared.rooms[0].model);
});

Deno.test("late or missing room heat is counted as none and said out loud, never dropped silently", async () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  const room = prepared.rooms.find(r => r.model)!;
  room.model = { ...room.model!, heat_lag_h: .5 };
  const boundary = Math.floor(Date.now() / 900_000) * 900_000;
  const quarters = Array.from({ length: 96 }, (_, i) => boundary - (96 - i) * 900_000);
  const run = async (starts: number[]) => {
    const db = createClient("http://localhost:54321", "synthetic-service", {
      auth: { persistSession: false }, global: { fetch: (url) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
        if (endpoint === "get_energy_latest_room_temperatures") return Promise.resolve(Response.json(
          prepared.rooms.map(r => ({ room_key: r.key, room_temperature_c: 19 }))));
        if (endpoint === "energy_optimisation_comfort_schedules") return Promise.resolve(Response.json([]));
        if (endpoint === "get_energy_thermal_training_quarters") return Promise.resolve(Response.json(
          starts.map(start => ({ room_key: room.key, start_ts: new Date(start).toISOString(), heat_w: 800 }))));
        throw new Error(`Unexpected capture dependency ${endpoint}`);
      } },
    });
    const result = await captureRoomPlanningState(db, "synthetic-customer", "synthetic-home", structuredClone(prepared.snapshot), prepared.rooms);
    return (result.planning_warnings ?? []).filter(w => w.scope === "rooms").map(w => w.code);
  };
  assertEquals(await run(quarters), []);
  assertEquals(await run(quarters.slice(0, -1)), ["room_heat_history_late"]);
  assertEquals(await run(quarters.filter((_, i) => i !== 40)), ["room_heat_history_missing"]);
  assertEquals(await run([]), [], "a room that never reports heat has no metering to wait for");
});

Deno.test("monitored heat warms the native room projection without creating appliance commands", async () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const mapping = mappings[0];
  const key = mapping.room!.key;
  const source = "synthetic-observed-appliance";
  const heater = snapshot.device_models.find(device => device.key === mapping.key)!;
  const monitor = { ...heater, key: source, planning_role: "base_load" as const };
  snapshot.device_models = [heater, monitor];
  snapshot.slots = snapshot.slots.slice(0, 8);
  snapshot.house_temperature_c = snapshot.house_temperature_c!.slice(0, 8);
  snapshot.outdoor_temperature_c = snapshot.outdoor_temperature_c!.slice(0, 8);
  snapshot.solar_irradiance_w_per_m2 = snapshot.solar_irradiance_w_per_m2?.slice(0, 8);
  snapshot.captured_at = snapshot.slots[0].start;
  bundle.rooms.find(room => room.room_key === key)!.passive_heat = {
    device_key: source, direct_c_per_wh: .001, delayed_c_per_wh: .002, lag_h: 1,
  };
  const prepared = prepareRoomModels(snapshot, [mapping, { ...mapping, key: source }], bundle);
  const start = Date.parse(snapshot.captured_at);
  const quarters = Array.from({ length: 96 }, (_, i) => [start - (96 - i) * 900_000, i > 91 ? 700 : 0]);
  const capture = (series: number[][], device = source) => captureRoomPlanningState(createClient(
    "http://localhost:54321", "synthetic-service", {
      auth: { persistSession: false }, global: { fetch: (url) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1);
        if (endpoint === "get_energy_latest_room_temperatures") return Promise.resolve(Response.json(
          [{ room_key: key, room_temperature_c: 21 }]));
        if (endpoint === "energy_optimisation_comfort_schedules") return Promise.resolve(Response.json(
          [{ room_key: key, weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
            off_temperature_c: 15, low_temperature_c: 16, high_temperature_c: 17 }]));
        if (endpoint === "get_energy_thermal_training_quarters") return Promise.resolve(Response.json([]));
        if (endpoint === "get_energy_room_passive_heat") return Promise.resolve(Response.json(
          [{ room_key: key, device_key: device, quarters: series }]));
        throw new Error(`Unexpected capture dependency ${endpoint}`);
      } },
    },
  ), "synthetic-customer", "synthetic-home", structuredClone(prepared.snapshot), prepared.rooms);

  const complete = await capture(quarters);
  const late = await capture(quarters.slice(0, -1));
  const gap = await capture(quarters.filter((_, i) => i !== 92));
  const unavailable = await capture([]);
  const wrongOwner = await capture(quarters, "unrelated-meter");
  const zone = complete.thermal_zones![0];
  const rate = zone.passive_heat_c_per_h!;
  assertEquals(zone.device_keys, [heater.key]);
  assert(rate[0] > rate[1] && rate[1] > 0);
  assert(late.thermal_zones![0].passive_heat_c_per_h![0] < rate[0]);
  assertEquals(late.planning_warnings?.some(w => w.code === "room_heat_history_late"), true);
  assert(gap.thermal_zones![0].passive_heat_c_per_h![0] < rate[0]);
  assertEquals(gap.planning_warnings?.some(w => w.code === "room_passive_heat_history_missing"), true);
  assertEquals(unavailable.thermal_zones![0].passive_heat_c_per_h, Array(8).fill(0));
  assertEquals(unavailable.thermal_zones![0].model, zone.model);
  assertEquals(wrongOwner.thermal_zones![0].passive_heat_c_per_h, undefined);
  assertEquals(complete.slots, wrongOwner.slots, "electricity is still accounted for in the original base load");
  const observed = prepareRoomServices(complete);
  const ordinary = prepareRoomServices(wrongOwner);
  assert(observed.temperature[key][0]! > ordinary.temperature[key][0]!);
  assertEquals(observed.commands[source], undefined);
  assertEquals(observed.power[source], undefined);
});

Deno.test("weather draw is pinned only for the matching device in Verification", () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const device = snapshot.device_models.find(model => model.key === mappings[0].key)!;
  const read = (value: typeof snapshot) => value.device_models.find(model => model.key === device.key)?.weather_heating;
  const binding = "climate.unit|sensor.power|sensor.energy";
  device.weather_heating_binding = binding;
  const p = (outdoor_c: number, watts: number) =>
    ({ outdoor_c, min_c: outdoor_c, max_c: outdoor_c, watts, spread_w: 50, hours: 4, days: 2 });
  bundle.devices = [{ device_key: device.key, model_revision: 14, operating_points: {
    method: "weather_heating_draw_v1", binding, points: [p(-10, 1600), p(20, 500)],
  } }];
  snapshot.outdoor_temperature_c = snapshot.slots.map(() => -10);
  snapshot.operating_scope = { modes: { [device.key]: "control_verification" },
    device_owners: { [device.key]: device.key }, external_demands: {} };
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  assertEquals(read(prepared.snapshot)?.revision, 14);
  assertEquals(prepared.rooms[0].maximum_power_w_by_slot[0], 1600);
  snapshot.operating_scope.modes[device.key] = "controlling";
  assertEquals(read(prepareRoomModels(snapshot, mappings, bundle).snapshot), undefined);
  snapshot.operating_scope.modes[device.key] = "control_verification";
  device.weather_heating_binding = "replaced";
  assertEquals(read(prepareRoomModels(snapshot, mappings, bundle).snapshot), undefined);
});
