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
  assert((zone.start_delivered_w ?? 0) > 300, `delivered ${zone.start_delivered_w}`);
  const immediate = roomPlanningZones(snapshot(), [bathroom()], evidence(21, { recent_heat_w: recent })).zones[0];
  assertEquals(immediate.start_delivered_w, 0);
});
