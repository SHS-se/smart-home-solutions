import { assert, assertEquals } from "@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { cpuPlanningSource } from "../../../tests/planner-handler-cpu.fixture.ts";
import { prepareRoomModels, captureRoomPlanningState, type RoomDeviceMapping } from "./room-model-capture.ts";
import { prepareRoomServices } from "./rules-room-services.ts";
import type { DeviceModelBundle } from "./device-model-store.ts";
import { actionablePlanningWarnings } from "./planner/planning-warnings.ts";

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
      if (endpoint === "get_energy_room_planning_history") return Promise.resolve(Response.json([]));
      throw new Error(`Unexpected capture dependency ${endpoint}`);
    } },
  });
  const result = await captureRoomPlanningState(db, "synthetic-customer", "synthetic-home", prepared.snapshot, prepared.rooms);
  assertEquals(calls.sort(), ["energy_optimisation_comfort_schedules", "get_energy_latest_room_temperatures", "get_energy_room_planning_history"]);
  assertEquals(result.thermal_zones!.map(room => room.key), prepared.rooms.map(room => room.key));
  assertEquals(result.thermal_zones!.every(room => room.start_temperature_c === 19), true);
  assertEquals(result.thermal_zones!.every(room => room.target_c.every(value => value === 21)), true);
  assertEquals(result.thermal_zones![0].model, prepared.rooms[0].model);
});

Deno.test("room history warns by room and source only for substantial gaps", async () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  const [room, neighbour] = prepared.rooms.filter(r => r.model);
  for (const candidate of [room, neighbour]) candidate.model = { ...candidate.model!, heat_lag_h: .5 };
  const quarterMs = 900_000;
  const run = async (missingTemperature: number[], missingHeat: number[], unavailable = false) => {
    let quarters: number[] = [];
    const db = createClient("http://localhost:54321", "synthetic-service", {
      auth: { persistSession: false }, global: { fetch: (url, request) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
        if (endpoint === "get_energy_latest_room_temperatures") return Promise.resolve(Response.json(
          prepared.rooms.map(r => ({ room_key: r.key, room_temperature_c: 19 }))));
        if (endpoint === "energy_optimisation_comfort_schedules") return Promise.resolve(Response.json(
          prepared.rooms.map(r => ({ room_key: r.key, weekday_modes: Array(96).fill("high-temp"),
            weekend_modes: Array(96).fill("high-temp"), off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21 }))));
        if (endpoint === "get_energy_room_planning_history") {
          if (unavailable) return Promise.resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
          const { p_from, p_to } = JSON.parse(String(request?.body));
          const start = Date.parse(p_from);
          quarters = Array.from({ length: 96 }, (_, i) => start + i * quarterMs);
          assertEquals(start % quarterMs, 0);
          assertEquals(quarters.at(-1)! + quarterMs, Date.parse(p_to));
          return Promise.resolve(Response.json([
            { room_key: room.key, temperature_starts: quarters.filter((_, i) => !missingTemperature.includes(i)),
              heater_quarters: quarters.flatMap((at, i) => missingHeat.includes(i) ? [] : [[at, i === 40 ? 0 : 800]]) },
            { room_key: neighbour.key, temperature_starts: quarters.filter((_, i) => i !== 40),
              heater_quarters: quarters.map(at => [at, 0]) },
          ]));
        }
        throw new Error(`Unexpected capture dependency ${endpoint}`);
      } },
    });
    const result = await captureRoomPlanningState(db, "synthetic-customer", "synthetic-home", structuredClone(prepared.snapshot), [room, neighbour]);
    return { quarters, warnings: result.planning_warnings ?? [], zone: result.thermal_zones!.find(zone => zone.key === room.key)! };
  };
  const complete = await run([], []);
  const late = await run([], [95]);
  assertEquals(late.warnings.map(warning => warning.code), ["room_heat_history_late"]);
  assertEquals(actionablePlanningWarnings(late.warnings), []);
  assert(late.zone.start_delivered_w! < complete.zone.start_delivered_w!);
  const small = await run([40], [86, 87, 88, 89, 90, 91, 94, 95]);
  assertEquals(actionablePlanningWarnings(small.warnings), []);
  const large = await run([60, 61, 62, 63, 64, 65], [64, 65, 66, 67, 94, 95]);
  const [warning] = actionablePlanningWarnings(large.warnings);
  assertEquals(actionablePlanningWarnings(large.warnings).length, 1);
  assertEquals(warning.scope, room.key);
  assertEquals(warning.message, `${room.name} has 2 h of missing room history.`);
  const { quarters } = large;
  assertEquals(warning.evidence, { quarters: 8, intervals: JSON.stringify([
    { from: quarters[60], until: quarters[64], sources: "Room temperature" },
    { from: quarters[64], until: quarters[66], sources: "Room temperature and Heater energy" },
    { from: quarters[66], until: quarters[68], sources: "Heater energy" },
  ]) });
  const missing = Array.from({ length: 96 }, (_, i) => i);
  const unreported = await run([], missing);
  assertEquals(unreported.zone.start_delivered_w, 0);
  assertEquals(actionablePlanningWarnings(unreported.warnings)[0].evidence?.quarters, 94);
  const failed = await run([], [], true);
  assertEquals(actionablePlanningWarnings(failed.warnings).map(w => w.code), ["room_evidence_unavailable"]);
  assertEquals(failed.zone.model, complete.zone.model);
  assertEquals(actionablePlanningWarnings((await run([], [])).warnings), []);
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
        if (endpoint === "get_energy_room_planning_history") return Promise.resolve(Response.json([]));
        if (endpoint === "get_energy_room_passive_heat") return Promise.resolve(Response.json(
          [{ room_key: key, device_key: device, quarters: series }]));
        throw new Error(`Unexpected capture dependency ${endpoint}`);
      } },
    },
  ), "synthetic-customer", "synthetic-home", structuredClone(prepared.snapshot), prepared.rooms);

  const complete = await capture(quarters);
  const late = await capture(quarters.slice(0, -1));
  const gap = await capture(quarters.filter((_, i) => i !== 92));
  const substantial = await capture(quarters.filter((_, i) => i < 60 || i >= 68));
  const unavailable = await capture([]);
  const wrongOwner = await capture(quarters, "unrelated-meter");
  const zone = complete.thermal_zones![0];
  const rate = zone.passive_heat_c_per_h!;
  assertEquals(zone.device_keys, [heater.key]);
  assert(rate[0] > rate[1] && rate[1] > 0);
  assert(late.thermal_zones![0].passive_heat_c_per_h![0] < rate[0]);
  assertEquals(late.planning_warnings?.some(w => w.code === "room_heat_history_late"), true);
  assert(gap.thermal_zones![0].passive_heat_c_per_h![0] < rate[0]);
  assertEquals(gap.planning_warnings?.some(w => w.code === "room_passive_heat_history_missing"), false);
  assertEquals(substantial.planning_warnings?.find(w => w.code === "room_passive_heat_history_missing")?.evidence?.quarters, 8);
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
