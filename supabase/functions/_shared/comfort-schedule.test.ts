import {
  buildComfortForecast,
  comfortIntervals,
  type ComfortMode,
  comfortModesForStarts,
  seededComfortModes,
  summerHeatingLockoutForStarts,
  type ZoneComfortSchedule,
} from "./comfort-schedule.ts";
import type { ThermalZoneModel } from "./planner/thermal-model.ts";
import { buildThermalProjection } from "./thermal-training.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const thermalModel: ThermalZoneModel = {
  gain_c_per_wh: 0.0005,
  cooling_constant_per_h: 0.05,
  background_gain_c_per_h: 0,
  thermal_capacity_wh_per_c: 2_000,
  heat_loss_w_per_c: 100,
  time_constant_h: 20,
  heating_rate_c_per_h: 1,
  r2: 0.9,
  residual_std_c: 0.1,
  sample_count: 1_000,
};

const schedule = (
  weekday: ComfortMode[],
  weekend = weekday,
): ZoneComfortSchedule => ({
  weekday_modes: weekday,
  weekend_modes: weekend,
  off_temperature_c: 5,
  low_temperature_c: 10,
  high_temperature_c: 20,
});

const starts = (iso: string, count: number) => {
  const first = Date.parse(iso);
  return Array.from(
    { length: count },
    (_unused, index) => new Date(first + index * 15 * 60_000).toISOString(),
  );
};

Deno.test("the Node-RED seed preserves both warm periods at quarter resolution", () => {
  const intervals = comfortIntervals(seededComfortModes());
  assert(
    intervals.length === 5,
    `expected five periods, found ${intervals.length}`,
  );
  assert(
    intervals[1].mode === "high-temp" &&
      intervals[1].start_quarter === 20 && intervals[1].end_quarter === 38,
    "morning comfort period changed",
  );
  assert(
    intervals[3].mode === "high-temp" &&
      intervals[3].start_quarter === 56 && intervals[3].end_quarter === 86,
    "evening comfort period changed",
  );
});

Deno.test("the schedule follows the home's local weekday across UTC midnight", () => {
  const weekday = new Array<ComfortMode>(96).fill("low-temp");
  const weekend = new Array<ComfortMode>(96).fill("high-temp");
  const modes = comfortModesForStarts(
    starts("2026-08-14T22:00:00Z", 4), // Saturday 00:00 in Stockholm.
    "Europe/Stockholm",
    schedule(weekday, weekend),
  );
  assert(
    modes.every((mode) => mode === "high-temp"),
    "UTC selected the wrong day type",
  );
});

Deno.test("the summer lockout follows local month boundaries", () => {
  const lockout = summerHeatingLockoutForStarts([
    "2026-08-31T21:45:00Z", // 23:45 August in Stockholm.
    "2026-08-31T22:00:00Z", // 00:00 September in Stockholm.
  ], "Europe/Stockholm");
  assert(lockout[0] === true, "the final August slot was not locked out");
  assert(lockout[1] === false, "the first September slot stayed locked out");
});

Deno.test("a slow cold room begins recovery before comfort starts", () => {
  const modes = new Array<ComfortMode>(96).fill("low-temp");
  modes.fill("high-temp", 24, 40);
  const result = buildComfortForecast(
    starts("2026-08-16T22:00:00Z", 96), // Monday 00:00 local.
    "Europe/Stockholm",
    schedule(modes),
    thermalModel,
    10,
    new Array(96).fill(10),
    2_000,
    new Array(96).fill(false),
  );
  assert(
    result.power_w.slice(0, 24).some((watts) => watts > 0),
    "high-mass recovery did not start before the comfort window",
  );
  assert(
    result.power_w.every((watts) => watts >= 0 && watts <= 2_000),
    "forecast exceeded the reviewed heater rating",
  );
});

Deno.test("warm outdoor air does not cancel an imminent comfort deadline", () => {
  const modes = new Array<ComfortMode>(96).fill("high-temp");
  const result = buildComfortForecast(
    starts("2026-08-16T22:00:00Z", 96),
    "Europe/Stockholm",
    schedule(modes),
    thermalModel,
    19,
    new Array(96).fill(24),
    2_000,
    new Array(96).fill(false),
  );
  assert(
    result.power_w.some((watts) => watts > 0),
    "the room was left cold while passive warming was too slow",
  );
  assert(
    result.power_w[0] === 2_000 &&
      result.temperature_c.slice(1).some((temperature) => temperature >= 19.99),
    "the room did not recover at its available rating",
  );
});

Deno.test("season lockout wins even during an unusually cold summer slot", () => {
  const modes = new Array<ComfortMode>(4).fill("high-temp");
  const fullDay = new Array<ComfortMode>(96).fill("high-temp");
  const result = buildComfortForecast(
    starts("2026-08-16T22:00:00Z", modes.length),
    "Europe/Stockholm",
    schedule(fullDay),
    thermalModel,
    10,
    new Array(modes.length).fill(5),
    2_000,
    new Array(modes.length).fill(true),
  );
  assert(
    result.power_w.every((watts) => watts === 0),
    "seasonal lockout emitted a heating request",
  );
});

Deno.test("the thermal projection preserves the slot-varying comfort target", () => {
  const slotStarts = starts("2026-08-16T22:00:00Z", 4);
  const projection = buildThermalProjection(slotStarts, [0, 0, 0, 0], [{
    key: "office-heater",
    name: "Office",
    model: thermalModel,
    start_temperature_c: 18,
    rated_power_w: 2_000,
    comfort_min_c: [16.7, 16.7, 20.7, 20.7],
    target_c: [17, 17, 21, 21],
    comfort_max_c: [17.5, 17.5, 21.5, 21.5],
    planned_power_w: [0, 2_000, 2_000, 500],
    unplanned_power_w: [0, 2_000, 2_000, 500],
  }]);
  assert(projection !== null, "complete thermal inputs produced no projection");
  assert(
    projection.zones[0].target_c.join(",") === "17,17,21,21",
    "projection flattened the weekly comfort routine",
  );
  assert(
    projection.source === "comfort_schedule_model",
    "projection did not disclose its comfort-schedule source",
  );
});
