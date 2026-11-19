import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { buildComfortForecast, type ZoneComfortSchedule } from "./comfort-schedule.ts";
import { readThermalModel } from "./planner/models/room/read-model.ts";
import {
  backgroundRateForSlot, projectZoneTemperature, roomMemoryScale, roomTransition, stepRoom,
  type DynamicThermalZoneModel, type EquilibriumThermalZoneModel,
} from "./planner/models/room/thermal.ts";

// Independently specified synthetic responses; no household measurements.
const stats = { r2: .9, sample_count: 180, residual_std_c: .05, prediction_error_c: .1, solar_mean_w_per_m2: 100 };
const integrator = (lag = 2, gain = .002): DynamicThermalZoneModel => ({
  ...stats, response_family: "integrator", gain_c_per_wh: gain, cooling_constant_per_h: 0,
  house_coupling_per_h: 0, background_gain_c_per_h: -.1, solar_gain_c_per_h_per_wm2: null,
  heat_lag_h: lag, thermal_capacity_wh_per_c: gain ? 1 / gain : null,
  heat_loss_w_per_c: gain ? 0 : null, time_constant_h: null, heating_rate_c_per_h: null,
});
const equilibrium = (lag = 2, gain = .006): EquilibriumThermalZoneModel => ({
  ...stats, response_family: "equilibrium", heater_c_per_w: gain, outdoor_share: .2,
  offset_c: 3, solar_c_per_wm2: .001, heat_lag_h: lag,
});
const conditions = (hours: number, background = 3.1) => ({ hours, outdoor_c: -5, house_c: 21, background_c_per_h: background });

Deno.test("published response families retain their own units through JSON and model decoding", () => {
  for (const original of [integrator(), integrator(1, 0), equilibrium(), equilibrium(1, 0)]) {
    const wire = JSON.parse(JSON.stringify(original));
    assertEquals(readThermalModel(wire), original);
  }
  const algebraic = JSON.parse(JSON.stringify(equilibrium()));
  assertEquals("gain_c_per_wh" in algebraic, false);
  assertEquals("thermal_capacity_wh_per_c" in algebraic, false);
  assertEquals("time_constant_h" in algebraic, false);
  assertEquals(readThermalModel({ ...integrator(), cooling_constant_per_h: .01 }), null);
  assertEquals(readThermalModel({ ...integrator(), time_constant_h: 1e9 }), null);
  assertEquals(readThermalModel({ ...equilibrium(), outdoor_share: 1.01 }), null);
});

Deno.test("equilibrium endpoint follows independent delivered-power integration for heating and cooldown", () => {
  const physics = equilibrium();
  for (const hours of [1, .25, 1 / 60]) for (const watts of [0, 600]) {
    let delivered = 200;
    const h = hours / 8000;
    // Integrate only the independently defined actuator reservoir, using RK4.
    for (let i = 0; i < 8000; i++) {
      const a = (watts - delivered) / 2, b = (watts - delivered - h * a / 2) / 2;
      const c = (watts - delivered - h * b / 2) / 2, d = (watts - delivered - h * c) / 2;
      delivered += h * (a + 2 * b + 2 * c + d) / 6;
    }
    const result = stepRoom(roomTransition(physics, conditions(hours)), { temperature_c: 90, stored_heat_c: .006 * 200 }, watts);
    assertAlmostEquals(result.temperature_c, .8 * 21 + .2 * -5 + 3.1 + .006 * delivered, 1e-10);
    assertAlmostEquals(result.stored_heat_c, .006 * delivered, 1e-10);
  }
});

Deno.test("instantaneous equilibrium has no invented capacity and zero elapsed time preserves either family", () => {
  const initial = { temperature_c: 19, stored_heat_c: 1.2 };
  const instant = equilibrium(0);
  const result = stepRoom(roomTransition(instant, conditions(.25)), initial, 500);
  assertAlmostEquals(result.temperature_c, .8 * 21 + .2 * -5 + 3.1 + .006 * 500, 1e-12);
  assertEquals(result.stored_heat_c, 0);
  for (const physics of [instant, equilibrium(2), integrator(0), integrator(2)]) {
    assertEquals(stepRoom(roomTransition(physics, conditions(0)), initial, 800), initial);
  }
  // Auxiliary input is a rate, not an algebraic temperature offset.
  assertAlmostEquals(backgroundRateForSlot(instant, 0, [200], [50]), 3.2, 1e-12);
});

Deno.test("family crossings preserve delivered watts while dynamic band crossings retain stored heat", () => {
  const dynamic = integrator(2, .002), algebraic = equilibrium(1, .01), another = integrator(.5, .003);
  const dynamicQ = .002 * 2 * 300;
  const algebraicQ = dynamicQ * roomMemoryScale(dynamic, algebraic);
  assertAlmostEquals(algebraicQ, .01 * 300, 1e-12);
  assertAlmostEquals(algebraicQ * roomMemoryScale(algebraic, another), .003 * .5 * 300, 1e-12);
  assertEquals(roomMemoryScale(dynamic, another), 1);
  assertEquals(roomMemoryScale(algebraic, equilibrium(1, 0)), 0);
  assertEquals(roomMemoryScale(equilibrium(1, 0), dynamic), 0);
});

Deno.test("mixed-family projection keeps the right memory coordinate across a zero-duration slot", () => {
  const dynamic = integrator(2, .002), algebraic = equilibrium(1, .01);
  const models = [dynamic, algebraic, algebraic, dynamic, dynamic];
  const actual = projectZoneTemperature(dynamic, 19, [-5, -5, -5, -5, -5], [600, 0, 0, 200, 0],
    [0, 0, 0, 0, 0], [.25, 0, .25, .25, .25], {
      house_c: [21, 21, 21, 21, 21], start_stored_heat_c: .002 * 2 * 300, model_by_quarter: models,
    });
  const delivered1 = 600 + (300 - 600) * Math.exp(-.25 / 2);
  const t1 = 19 + .002 * (600 * .25 + (300 - 600) * 2 * (1 - Math.exp(-.25 / 2))) - .1 * .25;
  const delivered2 = delivered1 * Math.exp(-.25);
  const t2 = .8 * 21 + .2 * -5 + 3 + .01 * delivered2;
  const t3 = t2 + .002 * (200 * .25 + (delivered2 - 200) * 2 * (1 - Math.exp(-.25 / 2))) - .1 * .25;
  assertEquals(actual, [19, t1, t1, t2, t3].map(value => Math.round(value * 1000) / 1000));
});

Deno.test("comfort forecasts use the fitted algebraic response and do not heat an already-warm zero-response room", () => {
  const schedule: ZoneComfortSchedule = { weekday_modes: Array(96).fill("high-temp"), weekend_modes: Array(96).fill("high-temp"),
    off_temperature_c: 10, low_temperature_c: 16, high_temperature_c: 21 };
  const starts = ["2026-01-01T00:00:00Z", "2026-01-01T00:15:00Z", "2026-01-01T00:30:00Z"];
  const physics = { ...equilibrium(0), outdoor_share: 0, offset_c: 0, solar_c_per_wm2: null, heater_c_per_w: .01 };
  const forecast = buildComfortForecast(starts, "UTC", schedule, physics, 18, [0, 0, 0], 800, [false, false, false],
    null, { house_c: [18, 18, 18] });
  // 18°C boundary + .01°C/W * 300W = 21°C: no generic empirical draw substitutes for the fit.
  assertEquals(forecast.power_w, [300, 300, 300]);
  assertEquals(forecast.temperature_c, [18, 21, 21]);
  for (const zero of [{ ...integrator(0, 0), background_gain_c_per_h: 0 },
    { ...physics, heater_c_per_w: 0, offset_c: 5 }]) {
    const warm = buildComfortForecast(starts, "UTC", schedule, zero, 23, [0, 0, 0], 800, [false, false, false],
      null, { house_c: [18, 18, 18] });
    assertEquals(warm.power_w, [0, 0, 0]);
    assert(warm.temperature_c.every(value => value === 23));
  }
});
