import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
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
        prepared.rooms.map(room => ({ room_key: room.key, room_temperature_c: 19, start_ts: new Date(Math.floor(Date.parse(snapshot.captured_at) / 900_000) * 900_000 - 900_000).toISOString() }))));
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
  assert(result.thermal_zones!.every(room => Number.isFinite(room.start_temperature_c)));
  assert(result.thermal_zones!.filter(room => room.model).every(room => room.temperature_observation?.mean_c === 19));
  assertEquals(result.thermal_zones!.every(room => room.target_c.every(value => value === 21)), true);
  assertEquals(result.thermal_zones![0].model, prepared.rooms[0].model);
});

Deno.test("room history identifies late observations and every older gap by room and source", async () => {
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
          prepared.rooms.map(r => ({ room_key: r.key, room_temperature_c: 19, start_ts: new Date(Math.floor(Date.parse(snapshot.captured_at) / 900_000) * 900_000 - 900_000).toISOString() }))));
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
    return { quarters, warnings: (result.planning_warnings ?? []).filter(warning => warning.scope === room.key || warning.scope === "rooms"), zone: result.thermal_zones!.find(zone => zone.key === room.key)! };
  };
  const complete = await run([], []);
  const late = await run([], [95]);
  assertEquals(late.warnings.map(warning => warning.code), ["room_heat_history_late", "room_state_boundary_late"]);
  assertEquals(actionablePlanningWarnings(late.warnings), []);
  assert(late.zone.start_stored_heat_c! < complete.zone.start_stored_heat_c!);
  const small = await run([40], [86, 87, 88, 89, 90, 91, 94, 95]);
  assertEquals(actionablePlanningWarnings(small.warnings)[0].evidence?.quarters, 7);
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
          [{ room_key: key, room_temperature_c: 21, start_ts: new Date(Math.floor(Date.parse(snapshot.captured_at) / 900_000) * 900_000 - 900_000).toISOString() }]));
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
  assertEquals(gap.planning_warnings?.some(w => w.code === "room_passive_heat_history_missing"), true);
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
  device.load_type = "inverter";
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

Deno.test("one shared response plans every forecast temperature and records its revision", () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const [mapping] = mappings;
  const key = mapping.room!.key;
  const fitted = bundle.rooms.find(room => room.room_key === key)!;
  const reference = readThermalModel(fitted)!;
  fitted.heating_bands = { binding: "synthetic-configuration", calibration_policy: "seasonal_independent_runs_v1",
    since: "2025-01-01", reference_revision: "shared-1",
    reference: { model: { ...reference, house_coupling_per_h: .03 }, scope: { kind: "shared" },
      learning_evidence: { run_calibration: { policy: "seasonal_independent_runs_v1", fitted_runs: 5 } } },
    attempted: {}, candidates: [], active: [] };
  fitted.background_gain_c_per_h = reference.background_gain_c_per_h + .5;
  bundle.roomHeating = { [key]: { binding: "synthetic-configuration", observed_since: "2025-01-01" } };
  snapshot.slots = snapshot.slots.slice(0, 3);
  snapshot.outdoor_temperature_c = [-7, 6, 11];
  snapshot.house_temperature_c = [20, 20, 20];
  const device = snapshot.device_models.find(member => member.key === mapping.key)!;
  device.category = "heating";
  device.forecast_w_by_slot = [600, 600, 600];
  device.load_type = "inverter";
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
  assertEquals(prepared.rooms[0].model_source, { kind: "shared", revision: "shared-1" });
  assert(!prepared.snapshot.planning_warnings?.some(warning => warning.code === "room_heating_response_learning"));
  const evidence = roomPlanningZones(prepared.snapshot, prepared.rooms, { schedules: new Map([[key, {
    weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
    off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21,
  }]]), temperature_c: new Map([[key, 19]]), recent_heat_w: new Map() });
  const result = prepareRoomServices({ ...prepared.snapshot, thermal_zones: evidence.zones });
  const used = result.heating_model_use?.[key];
  assertEquals(used?.thermal, [{ from: 0, through: 2, source: { kind: "shared", revision: "shared-1" } }]);
  // Device electrical draw keeps its own weather bands.
  assertEquals(used?.electrical[device.key], [
    { from: 0, through: 0, source: { kind: "band", band_c: -10, revision: "draw-cold" } },
    { from: 1, through: 2, source: { kind: "running_power", watts: device.active_power_w!,
      revision: "synthetic-constant-revision", binding: "synthetic-constant-source" } },
  ]);
  assertEquals(result.power[device.key].length, 3);
  bundle.roomHeating[key].binding = "new heater";
  const replacement = prepareRoomModels(snapshot, [mapping], bundle);
  assert(replacement.rooms[0].model, "the previous response stays in service while the new setup is measured");
  assertEquals(replacement.rooms[0].model_source, undefined);
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
          case "get_energy_latest_room_temperatures": return Promise.resolve(Response.json([{ room_key: key, room_temperature_c: 19, start_ts: new Date(Math.floor(Date.parse(snapshot.captured_at) / 900_000) * 900_000 - 900_000).toISOString() }]));
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

Deno.test("history reconstructs stored heat with the one response and bounds missing readings", async () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  const room = prepared.rooms.find(candidate => candidate.model)!;
  room.model = { ...room.model!, heat_lag_h: 2, gain_c_per_wh: .002 } as typeof room.model;
  const run = async (missing: number[], missingEnergy: number[] = [], missingWeather: number[] = []) => {
    const db = createClient("http://localhost:54321", "synthetic-service", {
      auth: { persistSession: false }, global: { fetch: (url, request) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
        if (endpoint === "get_energy_latest_room_temperatures") return Promise.resolve(Response.json([
          { room_key: room.key, room_temperature_c: 19, start_ts: new Date(Math.floor(Date.parse(snapshot.captured_at) / 900_000) * 900_000 - 900_000).toISOString() },
        ]));
        if (endpoint === "energy_optimisation_comfort_schedules") return Promise.resolve(Response.json([
          { room_key: room.key, weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
            off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21 },
        ]));
        if (endpoint === "get_energy_room_planning_history") {
          const { p_from } = JSON.parse(String(request?.body));
          const starts = Array.from({ length: 96 }, (_, i) => Date.parse(p_from) + i * 900_000);
          return Promise.resolve(Response.json([{ room_key: room.key,
            temperature_starts: starts.filter((_start, i) => !missing.includes(i)),
            heater_quarters: starts.flatMap((start, i) => missingEnergy.includes(i) ? [] : [[start, 800]]),
            outdoor_quarters: starts.flatMap((start, i) => missingWeather.includes(i) ? [] : [[start, -7]]),
          }]));
        }
        throw new Error(`Unexpected synthetic capture dependency ${endpoint}`);
      } },
    });
    return await captureRoomPlanningState(db, "synthetic-customer", "synthetic-home", structuredClone(prepared.snapshot), [room]);
  };
  let expected = 0;
  for (let i = 0; i < 96; i++) expected = Math.exp(-.25 / 2) * expected + .002 * 2 * -Math.expm1(-.25 / 2) * 800;
  const complete = await run([]);
  assertAlmostEquals(complete.thermal_zones![0].start_stored_heat_c!, expected, 1e-12);
  // A missing thermometer does not erase independently received electricity.
  const late = await run([95]);
  assertAlmostEquals(late.thermal_zones![0].start_stored_heat_c!, expected, 1e-12);
  assert(late.planning_warnings!.some(warning => warning.code === "room_heat_history_late"));
  // A hole in the middle keeps the room and never overstates its stored heat.
  const hole = await run([40]);
  assert(hole.thermal_zones![0].model);
  assert(hole.thermal_zones![0].start_stored_heat_c! <= expected);
  // Missing room readings retain measured electricity; an unavailable counter
  // instead contributes the useful-heat lower bound and says so.
  const absent = await run(Array.from({ length: 96 }, (_, i) => i));
  assertAlmostEquals(absent.thermal_zones![0].start_stored_heat_c!, expected, 1e-12);
  assert(absent.planning_warnings!.some(warning => warning.code === "room_heat_history_missing"));
  const noEnergy = await run([], Array.from({ length: 96 }, (_, i) => i));
  assert(noEnergy.thermal_zones![0].model);
  assertEquals(noEnergy.thermal_zones![0].start_stored_heat_c, 0);
  assert(noEnergy.planning_warnings!.some(warning => warning.code === "room_heat_history_missing"));
  // A later complete capture repairs the estimate with no relearning.
  assertAlmostEquals((await run([])).thermal_zones![0].start_stored_heat_c!, expected, 1e-12);
  room.model = { ...room.model!, gain_reference_outdoor_c: 10, gain_outdoor_slope_per_c: -.03 };
  const weatherExpected = expected * (1 - .03 * (-7 - 10));
  assertAlmostEquals((await run([])).thermal_zones![0].start_stored_heat_c!, weatherExpected, 1e-12);
  for (const missing of [[95], [40], Array.from({ length: 96 }, (_, i) => i)]) {
    const bounded = await run([], [], missing);
    assert(bounded.thermal_zones![0].model);
    assert(bounded.thermal_zones![0].start_stored_heat_c! < weatherExpected);
    assert(bounded.planning_warnings!.some(warning => warning.code === (missing[0] === 95 ? "room_heat_history_late" : "room_heat_history_missing")));
  }
  assertAlmostEquals((await run([])).thermal_zones![0].start_stored_heat_c!, weatherExpected, 1e-12);
});

Deno.test("a band-only room keeps one previously accepted band for the whole forecast until its shared response publishes", () => {
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
  assertEquals(prepared.rooms[0].model_source, { kind: "band", band_c: -10, revision: "synthetic--10" });
  assert(prepared.snapshot.planning_warnings?.some(warning => warning.code === "room_heating_response_learning"));
  const evidence = roomPlanningZones(prepared.snapshot, prepared.rooms, { schedules: new Map([[key, {
    weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
    off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21,
  }]]), temperature_c: new Map([[key, 19]]), recent_heat_w: new Map() });
  const result = prepareRoomServices({ ...prepared.snapshot, thermal_zones: evidence.zones });
  assertEquals(result.heating_model_use?.[key]?.thermal.map(run => run.source), [
    { kind: "band", band_c: -10, revision: "synthetic--10" },
  ]);
  bundle.roomHeating[key].binding = "changed-source";
  assertEquals(prepareRoomModels(snapshot, [mapping], bundle).rooms[0].model, null, "untrained stale coefficients are not a response");
});

Deno.test("uncontrolled positive heat is excluded only for the declared heating context", () => {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const key = mappings[0].room!.key;
  const stored = bundle.rooms.find(room => room.room_key === key)!;
  stored.background_gain_c_per_h = .3;
  stored.heating_bands = { binding: "synthetic-binding", calibration_policy: "recent_independent_runs_v1",
    since: "2025-01-01", reference_revision: null, active: [], candidates: [], attempted: {} };
  const ordinaryResult = prepareRoomModels(snapshot,mappings,bundle);
  const ordinary = ordinaryResult.rooms[0].model;
  assert(!ordinaryResult.snapshot.planning_warnings?.some(warning => warning.code === "room_heating_response_learning"));
  assert(ordinary && ordinary.response_family !== "equilibrium");
  assertEquals(ordinary.background_gain_c_per_h,.3,"other categories retain their existing model treatment");
  bundle.roomHeating = { [key]: { binding: "synthetic-binding", observed_since: "2025-01-01T00:00:00Z" } };
  const heating = prepareRoomModels(snapshot,mappings,bundle).rooms[0].model;
  assert(heating && heating.response_family !== "equilibrium");
  assertEquals(heating.background_gain_c_per_h,0);
  assertEquals(stored.background_gain_c_per_h,.3,"forecast compilation never rewrites the stored revision");
});

/** Synthetic RPC boundary fixture. Native means and energy are generated from
 * explicit inputs below, independently of the state initializer. */
function continuityCapture(lag = 0, background = -.1) {
  const { snapshot, mappings, bundle } = syntheticCapture();
  const mapping = mappings[0], key = mapping.room!.key;
  snapshot.slots = snapshot.slots.slice(0, 2);
  snapshot.captured_at = snapshot.slots[0].start;
  snapshot.device_models = snapshot.device_models.filter(device => device.key === mapping.key);
  snapshot.device_models[0].forecast_w_by_slot = [200, 200];
  snapshot.outdoor_temperature_c = [0, 0];
  snapshot.house_temperature_c = [20, 20];
  snapshot.solar_irradiance_w_per_m2 = [0, 0];
  const prepared = prepareRoomModels(snapshot, [mapping], bundle);
  const room = prepared.rooms[0];
  room.model = { ...room.model!, response_family: "integrator", cooling_constant_per_h: 0,
    house_coupling_per_h: 0, gain_c_per_wh: .001, heat_lag_h: lag,
    background_gain_c_per_h: background, time_constant_h: null };
  const calls: { endpoint: string; from?: number; to?: number }[] = [];
  const quarter = 900_000, hour = 3_600_000;
  const capture = (readingStart: number, mean: number, watts: number,
    omitPower: number[] = [], siblings: typeof prepared.rooms = [room]) => {
    calls.length = 0;
    const db = createClient("http://localhost:54321", "synthetic-service", {
      auth: { persistSession: false }, global: { fetch: (url, request) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
        if (endpoint === "get_energy_latest_room_temperatures") {
          calls.push({ endpoint });
          return Promise.resolve(Response.json(siblings.map(candidate => ({ room_key: candidate.key,
            room_temperature_c: mean, start_ts: new Date(readingStart).toISOString() }))));
        }
        if (endpoint === "energy_optimisation_comfort_schedules") {
          calls.push({ endpoint });
          return Promise.resolve(Response.json(siblings.map(candidate => ({ room_key: candidate.key,
            weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
            off_temperature_c: 10, low_temperature_c: 12, high_temperature_c: 15 }))));
        }
        if (endpoint === "get_energy_room_planning_history") {
          const args = JSON.parse(String(request?.body)), from = Date.parse(args.p_from), to = Date.parse(args.p_to);
          calls.push({ endpoint, from, to });
          const starts = Array.from({ length: (to - from) / quarter }, (_, i) => from + i * quarter);
          return Promise.resolve(Response.json(siblings.map(candidate => ({ room_key: candidate.key,
            temperature_starts: starts, heater_quarters: starts.filter(start => !omitPower.includes(start)).map(start => [start, watts]),
            outdoor_quarters: starts.map(start => [start, 0]) }))));
        }
        throw new Error(`Unexpected synthetic continuity dependency ${endpoint}`);
      } },
    });
    return captureRoomPlanningState(db, "synthetic-customer", "synthetic-home", structuredClone(prepared.snapshot), siblings);
  };
  return { prepared, room, key, calls, capture, quarter, hour };
}

Deno.test("capture conditions the native mean then carries delayed heat through a partial quarter exactly once", async () => {
  const f = continuityCapture(2, -.4), boundary = Date.parse(f.prepared.snapshot.captured_at);
  f.prepared.snapshot.captured_at = new Date(boundary + .1 * f.hour).toISOString();
  const lag = 2, heating = .8, q0 = heating * lag * -Math.expm1(-(24 - .25) / lag);
  const mean = 20 + (heating - .4) * .25 / 2 + (q0 - heating * lag) * (1 - lag / .25 * -Math.expm1(-.25 / lag));
  const qEnd = q0 * Math.exp(-.25 / lag) + heating * lag * -Math.expm1(-.25 / lag);
  const endpoint = 20 + (heating - .4) * .25 + (q0 - heating * lag) * -Math.expm1(-.25 / lag);
  const result = await f.capture(boundary - f.quarter, mean, 800);
  const zone = result.thermal_zones![0];
  const expected = endpoint + qEnd * -Math.expm1(-.1 / lag) - .4 * .1;
  assertAlmostEquals(zone.start_temperature_c!, expected, 1e-11);
  assertAlmostEquals(zone.start_stored_heat_c!, qEnd * Math.exp(-.1 / lag), 1e-11);
  assertEquals(zone.temperature_observation, { start_ms: boundary - f.quarter, end_ms: boundary, mean_c: mean });
  assert(result.planning_warnings!.some(w => w.code === "room_heat_history_late"));
  const services = prepareRoomServices(result);
  const firstEndpoint = expected + zone.start_stored_heat_c! * -Math.expm1(-.15 / lag) - .4 * .15;
  assertAlmostEquals(services.temperature[f.key][0]!, firstEndpoint, 1e-9);
  assertAlmostEquals(services.unplanned_temperature[f.key][0]!, firstEndpoint, 1e-9);
});

Deno.test("capture extends history beyond one day for an older native mean without rejecting its age", async () => {
  const f = continuityCapture(), captured = Date.parse(f.prepared.snapshot.captured_at);
  const start = captured - 36 * f.hour;
  const result = await f.capture(start, 20, 500);
  const reads = f.calls.filter(call => call.endpoint === "get_energy_room_planning_history");
  assertEquals(reads.length, 2);
  assertEquals(reads[0].from, captured - 24 * f.hour);
  assertEquals(reads[1].from, start - 24 * f.hour);
  assertEquals(reads[1].to, captured);
  assertAlmostEquals(result.thermal_zones![0].start_temperature_c!, 20 + .4 * (36 - .125), 1e-11);
  assert(result.thermal_zones![0].model);
  assertEquals(result.thermal_zones![0].temperature_observation?.end_ms, start + f.quarter);
});

Deno.test("late measurements repair the next captured state without fitting or changing the accepted model", async () => {
  const f = continuityCapture(), captured = Date.parse(f.prepared.snapshot.captured_at);
  const modelBefore = structuredClone(f.room.model);
  const readingStart = captured - 2 * f.quarter;
  const missing = await f.capture(readingStart, 20, 500, [captured - f.quarter]);
  assertAlmostEquals(missing.thermal_zones![0].start_temperature_c!, 20.025, 1e-12);
  const repaired = await f.capture(captured - f.quarter, 20.1, 500);
  assertAlmostEquals(repaired.thermal_zones![0].start_temperature_c!, 20.15, 1e-12);
  assertEquals(f.room.model, modelBefore);
  assertEquals(missing.thermal_zones![0].model, repaired.thermal_zones![0].model);
  assert(f.calls.every(call => ["get_energy_latest_room_temperatures", "get_energy_room_planning_history", "energy_optimisation_comfort_schedules"].includes(call.endpoint)));
  assert(!repaired.planning_warnings?.some(w => w.code === "room_heat_history_missing" || w.code === "room_heat_history_late"));
});

Deno.test("algebraic room evidence preserves comfort commands and demand without inventing a projection", async () => {
  const f = continuityCapture(), captured = Date.parse(f.prepared.snapshot.captured_at);
  f.room.model = { response_family: "equilibrium", heater_c_per_w: .002, outdoor_share: 1,
    offset_c: 20, solar_c_per_wm2: null, r2: 1, sample_count: 1000, residual_std_c: .1 };
  const result = await f.capture(captured - f.quarter, 19, 500);
  const zone = result.thermal_zones![0];
  assertEquals(zone.model, null);
  assertEquals(zone.start_stored_heat_c, null);
  const services = prepareRoomServices(result), device = f.room.device_keys[0];
  assertEquals(services.commands[device].map(command => command.type), ["unavailable", "unavailable"]);
  assertEquals(services.power[device], [200, 200]);
  assertEquals(services.temperature[f.key], [null, null]);
  assertEquals(services.unplanned_temperature[f.key], [null, null]);
  assert(result.planning_warnings?.some(w => w.scope === f.key && w.code === "room_forecast_estimate"));
});

Deno.test("a malformed room state cannot stop a healthy sibling or either comfort service", async () => {
  const f = continuityCapture(), captured = Date.parse(f.prepared.snapshot.captured_at);
  const broken = { ...f.room, key: "synthetic-broken-room", name: "Synthetic malformed room",
    device_keys: ["synthetic-broken-heater"], model: { ...f.room.model!, background_gain_c_per_h: NaN } };
  const device = f.prepared.snapshot.device_models[0];
  f.prepared.snapshot.device_models.push({ ...device, key: broken.device_keys[0] });
  const result = await f.capture(captured - f.quarter, 20, 500, [], [f.room, broken]);
  assert(result.thermal_zones!.find(zone => zone.key === f.key)!.model);
  assertEquals(result.thermal_zones!.find(zone => zone.key === broken.key)!.model, null);
  const services = prepareRoomServices(result);
  assertEquals(services.commands[broken.device_keys[0]].length, 2);
  assertEquals(services.commands[device.key].length, 2);
  assert(result.planning_warnings?.some(w => w.scope === broken.key));
});

Deno.test("thermostat sensor calibration uses the raw mean instead of elapsed room cooling", async () => {
  const f = continuityCapture(0, -2), captured = Date.parse(f.prepared.snapshot.captured_at);
  const member = f.prepared.snapshot.device_models[0];
  member.thermostat!.current_temperature_c = 20;
  member.thermostat!.hvac_action = "idle";
  const result = await f.capture(captured - 2 * f.hour, 20, 0);
  assertAlmostEquals(result.thermal_zones![0].start_temperature_c!, 16.25, 1e-12);
  // The thermometer and thermostat both measured 20 C, so their calibration
  // offset is zero. The elapsed 3.75 C cooling must not become a sensor offset:
  // the retained 18 C command now needs heat, rather than appearing satisfied.
  const held = result.slots.map(() => ({ device_commands: { [member.key]: {
    type: "heating_schedule" as const, heating: true,
  } } }));
  const services = prepareRoomServices(result, held);
  for (const watts of services.power[member.key]) assertAlmostEquals(watts, 800, 1e-9);
  assertAlmostEquals(services.temperature[f.key][0]!, 16.25 + (.8 - 2) * .25, 1e-9);
});

Deno.test('room capture resolves missing weather from observed history without an age cutoff or persisting measurements', async () => {
  const {snapshot, mappings, bundle} = syntheticCapture();
  const prepared = prepareRoomModels(snapshot, mappings, bundle);
  const missing = structuredClone(prepared.snapshot); delete missing.outdoor_temperature_c;
  const calls: string[] = [];
  const db = createClient('http://localhost:54321', 'synthetic-service', {auth: {persistSession: false}, global: {fetch: url => {
    const endpoint = new URL(String(url)).pathname.split('/').at(-1)!;
    calls.push(endpoint);
    if (endpoint === 'energy_optimisation_outdoor_slots') return Promise.resolve(Response.json([{start_ts: '2000-01-01T00:00:00Z', temperature_c: -4}]));
    if (endpoint === 'get_energy_latest_room_temperatures') return Promise.resolve(Response.json(prepared.rooms.map(room => ({room_key: room.key,
      room_temperature_c: 19, start_ts: new Date(Date.parse(snapshot.captured_at) - 900000).toISOString()}))));
    if (endpoint === 'energy_optimisation_comfort_schedules') return Promise.resolve(Response.json(prepared.rooms.map(room => ({room_key: room.key,
      weekday_modes: Array(96).fill('high-temp'), weekend_modes: Array(96).fill('high-temp'), off_temperature_c: 16, low_temperature_c: 19, high_temperature_c: 21}))));
    if (endpoint === 'get_energy_room_planning_history') return Promise.resolve(Response.json([]));
    throw new Error('Unexpected capture operation ' + endpoint);
  }}});
  const result = await captureRoomPlanningState(db, 'synthetic-customer', 'synthetic-home', missing, prepared.rooms);
  assertEquals(result.room_outdoor_estimate_c, -4);
  assertEquals(result.outdoor_temperature_c, undefined);
  assert(result.thermal_zones!.some(room => room.model !== null));
  assert(result.planning_warnings!.some(w => w.code === 'outdoor_estimate'));
  assert(calls.includes('energy_optimisation_outdoor_slots'));
  assertEquals(calls.filter(name => /insert|update|publish|record/.test(name)), []);
  const partial = {...missing, outdoor_temperature_c: snapshot.slots.map((_, i) => i === 0 ? null : -20)};
  const observed = {...missing, outdoor_temperature_c: snapshot.slots.map(() => -4)};
  const [coldFuture, knownNow] = await Promise.all([
    captureRoomPlanningState(db, 'synthetic-customer', 'synthetic-home', partial, prepared.rooms),
    captureRoomPlanningState(db, 'synthetic-customer', 'synthetic-home', observed, prepared.rooms),
  ]);
  assertEquals(coldFuture.thermal_zones!.map(room => room.start_temperature_c),
    knownNow.thermal_zones!.map(room => room.start_temperature_c), 'future cold cannot change the reconstructed current state');
});
