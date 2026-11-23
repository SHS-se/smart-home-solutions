import { assertAlmostEquals, assertEquals } from "@std/assert";
import { roomTransition, stepRoom, storedRoomHeat, type RoomState, type ThermalZoneModel } from "./planner/models/room/thermal.ts";
import { readThermalModel } from "./planner/models/room/read-model.ts";

// Independently generated synthetic physics; no household observations.
const model = (lag: number, gain = .001, exchange = 0): ThermalZoneModel => ({
  gain_c_per_wh: gain, heat_lag_h: lag, cooling_constant_per_h: exchange,
  background_gain_c_per_h: 0, thermal_capacity_wh_per_c: 1 / gain,
  heat_loss_w_per_c: exchange / gain, time_constant_h: exchange > 0 ? 1 / exchange : 0,
  heating_rate_c_per_h: null, r2: 1, sample_count: 0, residual_std_c: 0,
});
const transition = (physics: ThermalZoneModel, hours: number) => roomTransition(physics,
  { hours, outdoor_c: 0, background_c_per_h: 0 });

Deno.test("stored heat is conserved across independent gain and lag bands", () => {
  let state: RoomState = { temperature_c: 19, stored_heat_c: 1.2 };
  let energy = state.temperature_c + state.stored_heat_c;
  for (const [lag, gain, hours, watts] of [[2, .001, 1, 600], [.3, .006, .25, 0],
    [4, .0002, 1, 900], [0, .01, .25, 0], [1, .003, .25, 250]]) {
    state = stepRoom(transition(model(lag, gain), hours), state, watts);
    energy += gain * hours * watts;
    assertAlmostEquals(state.temperature_c + state.stored_heat_c, energy, 1e-11);
    if (lag === 0) assertEquals(state.stored_heat_c, 0);
  }
});

Deno.test("zero elapsed time preserves stored heat even when the next band is immediate", () => {
  const state = { temperature_c: 19, stored_heat_c: 1.2 };
  for (const lag of [0, .5, 2]) assertEquals(stepRoom(transition(model(lag), 0), state, 800), state);
});

Deno.test("weather-dependent gain changes new electricity without rescaling stored floor heat", () => {
  const physics = { ...model(2), gain_reference_outdoor_c: 10, gain_outdoor_slope_per_c: -.03 };
  let state = { temperature_c: 19, stored_heat_c: 1.2 }, expected = 20.2;
  for (const [outdoor, watts] of [[-10, 800], [20, 0], [5, 400], [-5, 0]]) {
    state = stepRoom(roomTransition(physics, { hours: .25, outdoor_c: outdoor, background_c_per_h: 0 }), state, watts);
    expected += .001 * (1 - .03 * (outdoor - 10)) * .25 * watts;
    assertAlmostEquals(state.temperature_c + state.stored_heat_c, expected, 1e-12);
  }
  assertEquals(readThermalModel(physics)?.gain_outdoor_slope_per_c, -.03);
  assertEquals(readThermalModel({ ...physics, gain_reference_outdoor_c: null }), null);
  assertEquals(readThermalModel({ ...physics, gain_outdoor_slope_per_c: Infinity }), null);
});

Deno.test("stored useful heat uses each interval's weather and bounds unreceived observations", () => {
  const physics = { ...model(2), gain_reference_outdoor_c: 10, gain_outdoor_slope_per_c: -.03 };
  const intervals = [{ watts: 800, outdoor_c: -10 }, { watts: 400, outdoor_c: 20 }, { watts: 0, outdoor_c: 5 }];
  let state = { temperature_c: 19, stored_heat_c: 0 };
  for (const interval of intervals) state = stepRoom(roomTransition(physics,
    { hours: .25, outdoor_c: interval.outdoor_c, background_c_per_h: 0 }), state, interval.watts);
  assertAlmostEquals(storedRoomHeat(physics, intervals), state.stored_heat_c, 1e-12);
  const missingWeather = storedRoomHeat(physics, intervals.map((row, i) => i === 1 ? { ...row, outdoor_c: null } : row));
  const missingPower = storedRoomHeat(physics, intervals.map((row, i) => i === 1 ? { ...row, watts: null } : row));
  assertEquals(missingWeather, missingPower);
  assertEquals(missingWeather < state.stored_heat_c, true);
});

Deno.test("exact endpoint matches independent integration for hourly, quarter and short intervals", () => {
  for (const hours of [1, .25, 1 / 60]) for (const [lag, exchange] of [[2, 0], [2, .03], [2, .5], [.2, 2]]) {
    const gain = .0017, watts = 800, q = .6;
    const initial = { temperature_c: 19, stored_heat_c: q };
    const next = stepRoom(transition(model(lag, gain, exchange), hours), initial, watts);
    let t = initial.temperature_c, heat = q;
    const h = hours / 4000;
    const derivative = (temperature: number, stored: number) =>
      [stored / lag - exchange * temperature, gain * watts - stored / lag];
    for (let i = 0; i < 4000; i++) {
      const a = derivative(t, heat), b = derivative(t + h * a[0] / 2, heat + h * a[1] / 2);
      const c = derivative(t + h * b[0] / 2, heat + h * b[1] / 2), d = derivative(t + h * c[0], heat + h * c[1]);
      t += h * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
      heat += h * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
    }
    assertAlmostEquals(next.temperature_c, t, 1e-9);
    assertAlmostEquals(next.stored_heat_c, heat, 1e-9);
  }
});
