import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { nativeTarget, supportedTarget, projectThermostatQuarter, type RoomThermostat, type ThermostatRoomState } from "./planner/thermostat.ts";
import { roomTransition, type ThermalZoneModel } from "./planner/thermal-model.ts";

const thermostat: RoomThermostat = { entity_id: "climate.bathroom", minimum_c: 5, maximum_c: 90, step_c: 1,
  current_temperature_c: 21, target_temperature_c: 21, hvac_action: "idle", sensor_offset_c: 0, power_w: 686.3 };
const model: ThermalZoneModel = { gain_c_per_wh: .001, cooling_constant_per_h: 0, background_gain_c_per_h: 0,
  thermal_capacity_wh_per_c: 1000, heat_loss_w_per_c: 0, time_constant_h: 100, heating_rate_c_per_h: 1,
  r2: 1, sample_count: 1000, residual_std_c: 0 };
const quarter = (hours = .25, thermal = model) => { const steps = Math.ceil(hours * 60); return { hours, steps,
  step: roomTransition(thermal, { hours: hours / steps, outdoor_c: 0, background_c_per_h: thermal.background_gain_c_per_h }) }; };
const state = (t = 21, mask = 0): ThermostatRoomState => ({ temperature_c: t, delivered_w: 0, heating_mask: mask });

Deno.test("native rounding preserves nearest supported step and halves up", () => {
  for (const [target, expected] of [[21.46, 21], [21.5, 22], [22.5, 23], [20.4, 20], [20.6, 21]]) {
    assertEquals(nativeTarget(thermostat, target), expected);
  }
  assertAlmostEquals(nativeTarget({ ...thermostat, minimum_c: 5.2, step_c: .5 }, 20.95), 21.2);
  assertEquals(supportedTarget({ ...thermostat, minimum_c: 5.2, maximum_c: 5.6, step_c: .5 }, 5.6), 5.2);
});
Deno.test("idle thermostat needs the user's 0.5 C margin; HVAC state owns the deadband", () => {
  const q = quarter();
  assertEquals(projectThermostatQuarter(q, [thermostat], state(), [21], 0).thermostat_w, [0]);
  assertEquals(projectThermostatQuarter(q, [thermostat], state(), [21.49], 0).thermostat_w, [0]);
  assertAlmostEquals(projectThermostatQuarter(q, [thermostat], state(), [21.5], 0).thermostat_w[0], 686.3);
  assertEquals(projectThermostatQuarter(q, [thermostat], state(21.1), [21.4], 0).thermostat_w, [0]);
  assert(projectThermostatQuarter(q, [thermostat], state(21.1, 1), [21.4], 0).thermostat_w[0] > 0);
});
Deno.test("native sensor offset prevents heat falsely inferred from the room sensor", () => {
  const t = { ...thermostat, sensor_offset_c: .5 };
  assertEquals(projectThermostatQuarter(quarter(), [t], state(20.5), [21], 0).thermostat_w, [0]);
  assertAlmostEquals(projectThermostatQuarter(quarter(), [t], state(20.5), [22], 0).thermostat_w[0], 686.3);
});
Deno.test("cycling power is integrated and short first quarters use their real duration", () => {
  const t = { ...thermostat, power_w: 4000 };
  const full = projectThermostatQuarter(quarter(), [t], state(), [21.5], 0);
  assert(full.thermostat_w[0] > 0 && full.thermostat_w[0] < 4000);
  assert(full.state.temperature_c >= 21.5 && full.state.temperature_c < 21.57);
  assertEquals(full.state.heating_mask, 0);
  const partial = projectThermostatQuarter(quarter(1 / 60), [t], state(), [22], 150);
  assertAlmostEquals(partial.state.temperature_c, 21 + 4150 / 60 / 1000);
  assertAlmostEquals(partial.thermostat_w[0], 4000);
});
Deno.test("delayed heat continues after the thermostat stops and rack energy stays separate", () => {
  const thermal = { ...model, heat_lag_h: 2 };
  const start = { ...state(), delivered_w: 686.3 };
  const projected = projectThermostatQuarter(quarter(.25, thermal), [thermostat], start, [21], 150);
  assertEquals(projected.thermostat_w, [0]);
  assert(projected.state.temperature_c > 21);
  assert(projected.state.delivered_w < 686.3 && projected.state.delivered_w > 150);
});
