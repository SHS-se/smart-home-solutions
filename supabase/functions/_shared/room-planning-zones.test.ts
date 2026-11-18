import { assert, assertEquals } from "@std/assert";
import { input } from "./planner/energy-optimisation.fixture.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { PreparedRoom } from "./prepared-energy-forecasts.ts";
import { type RoomEvidence, roomPlanningZones } from "./room-planning-zones.ts";
import type { ComfortMode, ZoneComfortSchedule } from "./comfort-schedule.ts";

function snapshot(): OptimisationSnapshot {
  const s = input();
  s.slots = s.slots.slice(0, 8);
  s.outdoor_temperature_c = s.slots.map(() => 5);
  s.solar_irradiance_w_per_m2 = null;
  return s;
}
const bathroom = (lag: number | null = null): PreparedRoom => ({
  key: "bath", name: "Bathroom", device_keys: ["floor"], rated_power_w: 800,
  maximum_power_w_by_slot: Array(8).fill(800),
  model: { gain_c_per_wh: .001, cooling_constant_per_h: .02, background_gain_c_per_h: 0, thermal_capacity_wh_per_c: 1000,
    heat_loss_w_per_c: 20, time_constant_h: 50, heating_rate_c_per_h: .8, r2: .9, sample_count: 700, residual_std_c: .05,
    heat_lag_h: lag },
});
const routine = (comfort: number): ZoneComfortSchedule => ({
  weekday_modes: Array<ComfortMode>(96).fill("high-temp"), weekend_modes: Array<ComfortMode>(96).fill("high-temp"),
  off_temperature_c: 12, low_temperature_c: 18, high_temperature_c: comfort,
});
const evidence = (comfort: number, overrides: Partial<RoomEvidence> = {}): RoomEvidence => ({
  schedules: new Map([["bath", routine(comfort)]]), temperature_c: new Map([["bath", 21.4]]),
  recent_heat_w: new Map(), ...overrides,
});

Deno.test("Comfort comes from the routine saved now, not from any prepared copy", () => {
  const before = roomPlanningZones(snapshot(), [bathroom()], evidence(22)).zones[0];
  const after = roomPlanningZones(snapshot(), [bathroom()], evidence(21)).zones[0];
  assertEquals(new Set(before.comfort_min_c), new Set([22]));
  assertEquals(new Set(after.comfort_min_c), new Set([21]));
  assertEquals(new Set(after.comfort_max_c), new Set([21.5]), "the ceiling follows Comfort");
});

Deno.test("the room starts from its latest measured temperature", () => {
  const zone = roomPlanningZones(snapshot(), [bathroom()], evidence(21)).zones[0];
  assertEquals(zone.start_temperature_c, 21.4);
  assert(zone.model, "a measured start with a model plans on the model");
});

Deno.test("a room with no complete routine keeps its settings and says so", () => {
  const result = roomPlanningZones(snapshot(), [bathroom()], evidence(21, { schedules: new Map() }));
  assertEquals(result.zones, []);
  assertEquals(result.warnings.map(w => [w.code, w.scope]), [["room_forecast_estimate", "bath"]]);
});

Deno.test("a delayed floor starts with the heat its last day put on the way", () => {
  const recent = new Map([["bath", Array(96).fill(0).map((_v, i) => i >= 88 ? 800 : 0)]]);
  const zone = roomPlanningZones(snapshot(), [bathroom(2)], evidence(21, { recent_heat_w: recent })).zones[0];
  assert((zone.start_stored_heat_c ?? 0) > 300 * .001 * 2, `delivered ${zone.start_stored_heat_c}`);
  const immediate = roomPlanningZones(snapshot(), [bathroom()], evidence(21, { recent_heat_w: recent })).zones[0];
  assertEquals(immediate.start_stored_heat_c, 0);
});

// Independently generated synthetic room responses: neither is a general fit.
function bandOnlyRoom(): PreparedRoom {
  const room = bathroom(2);
  const model = room.model!;
  return { ...room, model: null, heating_bands: { reference_revision: null, active: [
    { revision: "synthetic-cold", band_c: -10, observed_min_c: -9, observed_max_c: -6,
      training_from: "2025-01-01", training_to: "2025-02-01", model },
    { revision: "synthetic-mild", band_c: 5, observed_min_c: 5, observed_max_c: 8,
      training_from: "2025-02-01", training_to: "2025-03-01",
      model: { ...model, gain_c_per_wh: .002, heat_lag_h: .5 } },
  ] } };
}

Deno.test("accepted bands forecast every quarter without a general model", () => {
  const s = snapshot();
  s.outdoor_temperature_c = [-8, -7, 5, 6, 7, -8, 5, 8];
  const result = roomPlanningZones(s, [bandOnlyRoom()], evidence(22));
  assert(result.zones[0].model);
  assertEquals(result.zones[0].heating_bands?.reference_revision, null);
  assertEquals(result.zones[0].heating_bands?.by_quarter, [0, 0, 1, 1, 1, 0, 1, 1]);
  assertEquals(result.zones[0].start_stored_heat_c, 0, "unknown historical dynamics cannot create stored heat");
  assertEquals(result.warnings, []);
});

Deno.test("a band-only forecast never extrapolates across a support hole or missing weather", () => {
  for (const missingWeather of [false, true]) {
    const s = snapshot();
    s.outdoor_temperature_c = missingWeather ? undefined : [5, 5, 5, 9, 5, 5, 5, 5];
    s.device_models = [{ ...s.device_models[0], key: "floor", forecast_w_by_slot: Array(8).fill(234) }];
    const result = roomPlanningZones(s, [bandOnlyRoom()], evidence(22));
    assertEquals(result.zones[0].model, null);
    assertEquals(result.zones[0].unplanned_power_w, Array(8).fill(234));
    assertEquals(result.zones[0].target_c, Array(8).fill(22));
    assert(result.warnings.some(warning => warning.code === "room_forecast_estimate"));
  }
});

Deno.test("house evidence is required by any selected band, not only the first quarter", () => {
  const room = bandOnlyRoom();
  room.heating_bands!.active[1].model.house_coupling_per_h = .03;
  const s = snapshot();
  s.outdoor_temperature_c = [-8, -8, 5, 5, 5, 5, 5, 5];
  s.house_temperature_c = null;
  const result = roomPlanningZones(s, [room], evidence(22));
  assertEquals(result.zones[0].model, null);
  assert(result.warnings.some(warning => warning.message.includes("house temperature unavailable")));
});
