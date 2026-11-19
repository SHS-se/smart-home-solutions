import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { cpuPlanningSource } from "../../../tests/planner-handler-cpu.fixture.ts";
import { prepareRoomModels, captureRoomPlanningState, type RoomDeviceMapping } from "./room-model-capture.ts";
import { prepareRoomServices } from "./rules-room-services.ts";
import type { DeviceModelBundle } from "./device-model-store.ts";
import { actionablePlanningWarnings } from "./planner/planning-warnings.ts";
import { roomPlanningZones } from "./room-planning-zones.ts";
import { readThermalModel } from "./planner/models/room/read-model.ts";

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
  assert(late.zone.start_stored_heat_c! < complete.zone.start_stored_heat_c!);
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
  assertEquals(unreported.zone.start_stored_heat_c, 0);
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

Deno.test("a forecast crosses heating bands and publishes the actual thermal and electrical revisions", () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const [mapping] = mappings;
  const key = mapping.room!.key;
  const fitted = bundle.rooms.find(room => room.room_key === key)!;
  const reference = readThermalModel(fitted)!;
  const fit = (band: number, revision: string, outdoor: number, gain: number) => ({
    revision, band_c: band, observed_min_c: outdoor, observed_max_c: outdoor,
    training_from: "2025-01-01", training_to: "2025-01-08",
    model: { ...reference, gain_c_per_wh: gain * (band < 0 ? .5 : 2),
      heat_lag_h: band < 0 ? .5 : 2, house_coupling_per_h: .03 },
  });
  fitted.heating_bands = { binding: "synthetic-configuration", since: "2025-01-01", reference_revision: "general",
    reference: { model: reference }, attempted: {}, candidates: [],
    active: [fit(-10, "cold", -7, reference.gain_c_per_wh), fit(5, "mild", 6, reference.gain_c_per_wh)] };
  fitted.background_gain_c_per_h = reference.background_gain_c_per_h + .5;
  bundle.roomHeating = { [key]: { binding: "synthetic-configuration", observed_since: "2025-01-01" } };
  snapshot.slots = snapshot.slots.slice(0, 3);
  snapshot.outdoor_temperature_c = [-7, 6, 11];
  snapshot.house_temperature_c = [20, 20, 20];
  const device = snapshot.device_models.find(member => member.key === mapping.key)!;
  device.category = "heating";
  device.forecast_w_by_slot = [600, 600, 600];
  device.weather_heating_binding = "meter-binding";
  device.running_power_model = { revision: "synthetic-constant-revision", binding: "synthetic-constant-source" };
  snapshot.device_models = [device];
  snapshot.operating_scope = { modes: { [device.key]: "controlling" }, device_owners: { [device.key]: device.key }, external_demands: {} };
  bundle.devices = [{ device_key: device.key, model_revision: 14, operating_points: {
    method: "weather_heating_draw_v1", binding: "meter-binding", versioned: { candidates: [], attempted: {} },
    points: [{ band_c: -10, revision: "draw-cold", outdoor_c: -7, min_c: -8, max_c: -6, watts: 600, spread_w: 10, hours: 5, days: 3,
      training_from: "2025-01-01", training_to: "2025-01-08" }],
  } }];
  const prepared = prepareRoomModels(snapshot, [mapping], bundle);
  assertEquals(prepared.rooms[0].model?.background_gain_c_per_h, reference.background_gain_c_per_h);
  const evidence = roomPlanningZones(prepared.snapshot, prepared.rooms, { schedules: new Map([[key, {
    weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
    off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21,
  }]]), temperature_c: new Map([[key, 19]]), recent_heat_w: new Map() });
  const result = prepareRoomServices({ ...prepared.snapshot, thermal_zones: evidence.zones });
  const used = result.heating_model_use?.[key];
  assertEquals(used?.thermal.map(run => run.source), [
    { kind: "band", band_c: -10, revision: "cold" },
    { kind: "band", band_c: 5, revision: "mild" },
    { kind: "general", revision: "general" },
  ]);
  assertEquals(used?.electrical[device.key], [
    { from: 0, through: 0, source: { kind: "band", band_c: -10, revision: "draw-cold" } },
    { from: 1, through: 2, source: { kind: "running_power", watts: device.active_power_w!,
      revision: "synthetic-constant-revision", binding: "synthetic-constant-source" } },
  ]);
  assertEquals(result.power[device.key].length, 3);
  bundle.roomHeating[key].binding = "new heater";
  const replacement = prepareRoomModels(snapshot, [mapping], bundle);
  assert(replacement.rooms[0].model);
  assertEquals(replacement.rooms[0].heating_bands, { reference_revision: "general", active: [] });
});

Deno.test("room preparation uses connected probe evidence without requiring the neighbour to be planned", async () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const [mapping] = mappings;
  const key = mapping.room!.key;
  const fitted = bundle.rooms.find(room => room.room_key === key)!;
  fitted.house_coupling_per_h = .2;
  fitted.doorway_exchange = { source: "receiver", peers: [
    { key: "observed-only", source: "probe", weight: .1, usual: 1, persistence: .95 },
  ] };
  snapshot.device_models = snapshot.device_models.filter(device => device.key === mapping.key);
  snapshot.slots = snapshot.slots.slice(0, 8);
  snapshot.house_temperature_c = snapshot.slots.map(() => 20);
  snapshot.outdoor_temperature_c = snapshot.outdoor_temperature_c!.slice(0, 8);
  snapshot.solar_irradiance_w_per_m2 = snapshot.solar_irradiance_w_per_m2?.slice(0, 8);
  snapshot.device_models[0].forecast_w_by_slot = snapshot.device_models[0].forecast_w_by_slot.slice(0, 8);
  snapshot.captured_at = snapshot.slots[0].start;
  const prepared = prepareRoomModels(snapshot, [mapping], bundle);
  const start = Date.parse(snapshot.captured_at) - 900_000;
  const capture = (links: unknown[]) => captureRoomPlanningState(createClient(
    "http://localhost:54321", "synthetic-service", {
      auth: { persistSession: false }, global: { fetch: url => {
        switch (new URL(String(url)).pathname.split("/").at(-1)) {
          case "get_energy_latest_room_temperatures": return Promise.resolve(Response.json([{ room_key: key, room_temperature_c: 19 }]));
          case "energy_optimisation_comfort_schedules": return Promise.resolve(Response.json([{ room_key: key,
            weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
            off_temperature_c: 16, low_temperature_c: 18, high_temperature_c: 21 }]));
          case "get_energy_room_planning_history": return Promise.resolve(Response.json([]));
          case "get_energy_doorway_probes": return Promise.resolve(Response.json(links));
          default: throw new Error("Unexpected capture endpoint");
        }
      } },
    }), "customer", "home", structuredClone(prepared.snapshot), prepared.rooms);
  const measured = await capture([{ room_key: key, other_key: "observed-only", room_source: "receiver",
    other_source: "probe", quarters: [[start, 28]] }]);
  const deleted = await capture([]);
  assert(measured.thermal_zones![0].doorway_boundary_c!.every(c => c > 20));
  assertEquals(deleted.thermal_zones![0].doorway_boundary_c, undefined);
  const shifted = prepareRoomServices(measured);
  const baseline = prepareRoomServices(deleted);
  assertEquals(Object.keys(shifted.commands), [mapping.key]);
  assert(shifted.temperature[key].some((thermal, index) => thermal !== baseline.temperature[key][index]));
});

Deno.test("history reconstructs stored heat with historical bands and bounds missing weather", async () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  const room = prepared.rooms.find(candidate => candidate.model)!;
  room.model = { ...room.model!, heat_lag_h: 0 };
  const band = (band_c: number, lag: number, gain: number) => ({
    band_c, revision: `synthetic-${band_c}`, observed_min_c: band_c, observed_max_c: band_c + 4,
    training_from: "2025-01-01", training_to: "2025-02-01",
    model: { ...room.model!, heat_lag_h: lag, gain_c_per_wh: gain },
  });
  room.heating_bands = { reference_revision: "general", active: [band(-10, 2, .002), band(5, .5, .001)] };
  const run = async (missing: number[], unsupported: number[] = [], missingEnergy: number[] = []) => {
    const db = createClient("http://localhost:54321", "synthetic-service", {
      auth: { persistSession: false }, global: { fetch: (url, request) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
        if (endpoint === "get_energy_latest_room_temperatures") return Promise.resolve(Response.json([
          { room_key: room.key, room_temperature_c: 19 },
        ]));
        if (endpoint === "energy_optimisation_comfort_schedules") return Promise.resolve(Response.json([
          { room_key: room.key, weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
            off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21 },
        ]));
        if (endpoint === "get_energy_room_planning_history") {
          const { p_from } = JSON.parse(String(request?.body));
          const starts = Array.from({ length: 96 }, (_, i) => Date.parse(p_from) + i * 900_000);
          return Promise.resolve(Response.json([{ room_key: room.key, temperature_starts: starts,
            heater_quarters: starts.flatMap((start, i) => missingEnergy.includes(i) ? [] : [[start, 800]]),
            outdoor_quarters: starts.flatMap((start, i) => missing.includes(i) ? [] : [[start, unsupported.includes(i) ? 20 : i < 94 ? -7 : 6]]),
          }]));
        }
        throw new Error(`Unexpected synthetic capture dependency ${endpoint}`);
      } },
    });
    return await captureRoomPlanningState(db, "synthetic-customer", "synthetic-home", structuredClone(prepared.snapshot), [room]);
  };
  let expected = 0;
  for (let i = 0; i < 96; i++) {
    const lag = i < 94 ? 2 : .5, gain = i < 94 ? .002 : .001;
    expected = Math.exp(-.25 / lag) * expected + gain * lag * -Math.expm1(-.25 / lag) * 800;
  }
  const complete = await run([]);
  assertAlmostEquals(complete.thermal_zones![0].start_stored_heat_c!, expected, 1e-12);
  const late = await run([95]);
  assert(late.thermal_zones![0].start_stored_heat_c! < expected);
  assert(late.planning_warnings!.some(warning => warning.code === "room_heat_history_late"));
  const hole = await run([40]);
  assert(hole.thermal_zones![0].model);
  assert(hole.thermal_zones![0].start_stored_heat_c! <= expected);
  const absent = await run(Array.from({ length: 96 }, (_, i) => i));
  assertEquals(absent.thermal_zones![0].start_stored_heat_c, 0);
  assert(absent.planning_warnings!.some(warning => warning.code === "room_heat_history_missing"));
  assertAlmostEquals((await run([])).thermal_zones![0].start_stored_heat_c!, expected, 1e-12);

  // No general model: all forecast intervals remain covered, but historical
  // temperatures outside accepted bands cannot be treated as another band.
  room.model = null;
  room.heating_bands.reference_revision = null;
  prepared.snapshot.outdoor_temperature_c = prepared.snapshot.slots.map(() => -7);
  const bandOnly = await run([]);
  assert(bandOnly.thermal_zones![0].model);
  assertAlmostEquals(bandOnly.thermal_zones![0].start_stored_heat_c!, expected, 1e-12);
  const lastMissing = await run([95]);
  assert(lastMissing.thermal_zones![0].model);
  assertEquals(lastMissing.thermal_zones![0].start_stored_heat_c, 0);
  assert(lastMissing.planning_warnings!.some(warning => warning.code === "room_heat_history_late"));
  const outside = await run([], [95]);
  assertEquals(outside.thermal_zones![0].start_stored_heat_c, 0);
  assert(outside.planning_warnings!.some(warning => warning.scope === room.key));
  const middle = await run([40]);
  assert(middle.thermal_zones![0].start_stored_heat_c! > 0);
  assert(middle.thermal_zones![0].start_stored_heat_c! <= expected);
  const noEnergy = await run([], [], Array.from({ length: 96 }, (_, i) => i));
  assert(noEnergy.thermal_zones![0].model);
  assertEquals(noEnergy.thermal_zones![0].start_stored_heat_c, 0);
  assert(noEnergy.planning_warnings!.some(warning => warning.code === "room_heat_history_missing"));
});

Deno.test("untrained general response retains independent bands and records each planned revision", () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const [mapping] = mappings;
  const key = mapping.room!.key;
  const fitted = bundle.rooms.find(room => room.room_key === key)!;
  const model = readThermalModel(fitted)!;
  fitted.trained = false;
  fitted.heating_bands = { binding: "synthetic-bands-only", since: "2025-01-01", reference_revision: null,
    attempted: {}, candidates: [], active: [-10, 5].map((band_c, i) => ({
      revision: `synthetic-${band_c}`, band_c, observed_min_c: band_c, observed_max_c: band_c + 4,
      training_from: "2025-01-01", training_to: "2025-02-01", model: { ...model, heat_lag_h: i + .5 },
    })) };
  bundle.roomHeating = { [key]: { binding: "synthetic-bands-only", observed_since: "2025-01-01" } };
  snapshot.slots = snapshot.slots.slice(0, 3);
  snapshot.outdoor_temperature_c = [-7, 6, -8];
  snapshot.house_temperature_c = [20, 20, 20];
  snapshot.device_models = snapshot.device_models.filter(device => device.key === mapping.key);
  snapshot.device_models[0].forecast_w_by_slot = [600, 600, 600];
  const prepared = prepareRoomModels(snapshot, [mapping], bundle);
  assertEquals(prepared.rooms[0].model, null, "untrained stale coefficients are not a general response");
  assertEquals(prepared.rooms[0].heating_bands?.active.length, 2);
  assertEquals(prepared.rooms[0].heating_bands?.reference_revision, null);
  const evidence = roomPlanningZones(prepared.snapshot, prepared.rooms, { schedules: new Map([[key, {
    weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
    off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21,
  }]]), temperature_c: new Map([[key, 19]]), recent_heat_w: new Map() });
  const result = prepareRoomServices({ ...prepared.snapshot, thermal_zones: evidence.zones });
  assertEquals(result.heating_model_use?.[key]?.thermal.map(run => run.source), [
    { kind: "band", band_c: -10, revision: "synthetic--10" },
    { kind: "band", band_c: 5, revision: "synthetic-5" },
    { kind: "band", band_c: -10, revision: "synthetic--10" },
  ]);
  bundle.roomHeating[key].binding = "changed-source";
  assertEquals(prepareRoomModels(snapshot, [mapping], bundle).rooms[0].heating_bands?.active, []);
});

Deno.test("mixed response-family history carries measured heater memory into the first forecast band", async () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  const room = prepared.rooms.find(candidate => candidate.model)!;
  const dynamic = { response_family: "integrator" as const, gain_c_per_wh: .002, heat_lag_h: 2,
    cooling_constant_per_h: 0, house_coupling_per_h: 0, background_gain_c_per_h: 0,
    thermal_capacity_wh_per_c: 500, heat_loss_w_per_c: 0, time_constant_h: null,
    heating_rate_c_per_h: null, r2: 1, sample_count: 240, residual_std_c: .01 };
  const algebraic = { response_family: "equilibrium" as const, heater_c_per_w: .01, heat_lag_h: .5,
    outdoor_share: .2, offset_c: 3, solar_c_per_wm2: null, r2: 1, sample_count: 240, residual_std_c: .01 };
  room.model = dynamic;
  room.heating_bands = { reference_revision: "synthetic-general", active: [
    { band_c: -10, revision: "synthetic-integrator", observed_min_c: -10, observed_max_c: -6,
      training_from: "2025-01-01", training_to: "2025-02-01", model: dynamic },
    { band_c: 5, revision: "synthetic-equilibrium", observed_min_c: 5, observed_max_c: 9,
      training_from: "2025-01-01", training_to: "2025-02-01", model: algebraic },
  ] };
  const run = (forecastC: number, missing: number[] = []) => {
    const source = structuredClone(prepared.snapshot);
    source.outdoor_temperature_c = source.slots.map(() => forecastC);
    const db = createClient("http://localhost:54321", "synthetic-service", {
      auth: { persistSession: false }, global: { fetch: (url, request) => {
        switch (new URL(String(url)).pathname.split("/").at(-1)) {
          case "get_energy_latest_room_temperatures": return Promise.resolve(Response.json([
            { room_key: room.key, room_temperature_c: 19 },
          ]));
          case "energy_optimisation_comfort_schedules": return Promise.resolve(Response.json([
            { room_key: room.key, weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
              off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21 },
          ]));
          case "get_energy_room_planning_history": {
            const { p_from } = JSON.parse(String(request?.body));
            const starts = Array.from({ length: 96 }, (_, i) => Date.parse(p_from) + i * 900_000);
            return Promise.resolve(Response.json([{ room_key: room.key, temperature_starts: starts,
              heater_quarters: starts.flatMap((start, i) => missing.includes(i) ? [] : [[start, 800]]),
              outdoor_quarters: starts.map((start, i) => [start, i < 94 ? -7 : 6]),
            }]));
          }
          default: throw new Error("Unexpected synthetic mixed-family capture endpoint");
        }
      } },
    });
    return captureRoomPlanningState(db, "synthetic-customer", "synthetic-home", source, [room]);
  };
  // 23.5 hours through the dynamic reservoir, followed by half an hour through
  // the algebraic reservoir. The coordinate changes, not measured delivered watts.
  const deliveredCold = 800 * (1 - Math.exp(-23.5 / 2));
  const delivered = 800 + (deliveredCold - 800) * Math.exp(-.5 / .5);
  const cold = await run(-7), mild = await run(6);
  assertAlmostEquals(cold.thermal_zones![0].start_stored_heat_c!, .002 * 2 * delivered, 1e-11);
  assertAlmostEquals(mild.thermal_zones![0].start_stored_heat_c!, .01 * delivered, 1e-11);
  for (const missing of [[95], [70], Array.from({ length: 96 }, (_, i) => i)]) {
    const incomplete = await run(6, missing);
    assertEquals(incomplete.thermal_zones!.length, 1);
    const heat = incomplete.thermal_zones![0].start_stored_heat_c!;
    assert(Number.isFinite(heat) && heat >= 0 && heat < .01 * delivered);
    assertEquals(incomplete.thermal_zones![0].model, room.model);
  }
});
