import { assertEquals } from "@std/assert";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { cpuPlanningSource } from "../../../tests/planner-handler-cpu.fixture.ts";
import { prepareRoomModels, captureRoomPlanningState, type RoomDeviceMapping } from "./room-model-capture.ts";
import type { DeviceModelBundle } from "./device-model-store.ts";

function syntheticCapture() {
  const snapshot = cpuPlanningSource(true).snapshot;
  const rooms = snapshot.thermal_zones!;
  const mappings: RoomDeviceMapping[] = rooms.map(room => ({ key: room.device_keys[0],
    control_type_override: "setpoint", room: { key: room.key, name: room.name } }));
  const bundle: DeviceModelBundle = { rooms: rooms.filter(room => room.model).map((room, index) => ({
    ...room.model, model_revision: index + 1, room_key: room.key, trained: true,
  })).reverse(), pool: null, revisions: { rooms: {}, pool: null } };
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
