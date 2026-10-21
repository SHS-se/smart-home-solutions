import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import { prepareRoomServices } from "./rules-room-services.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import { nativeTarget, projectThermostatQuarter, type RoomThermostat, type ThermostatRoomState } from "./planner/thermostat.ts";
import { roomTransition, backgroundRateForSlot } from "./planner/thermal-model.ts";
import fixture from "./bathroom-thermostat-replay.fixture.json" with { type: "json" };

const floor = fixture.devices.find(d => d.control_type === "setpoint")!.key;
const rack = fixture.devices.find(d => d.control_type === "switch_schedule")!.key;
function bathroom(): OptimisationSnapshot {
  const base = dispatchedEvSnapshot();
  return { ...base, snapshot_id: fixture.source_plan_id, captured_at: fixture.captured_at,
    capabilities: { pv: true, battery: false, ev: false, pool: false, boiler: false }, battery: null, ev_battery: null, services: [],
    slots: fixture.slots, outdoor_temperature_c: fixture.outdoor_temperature_c,
    solar_irradiance_w_per_m2: fixture.solar_irradiance_w_per_m2, house_temperature_c: fixture.house_temperature_c,
    device_models: fixture.devices.map(d => ({ ...d, ...(d.key === floor ? { thermostat: fixture.thermostat_evidence } : {}) })),
    thermal_zones: [fixture.zone] } as OptimisationSnapshot;
}
const prices = { import_sek_per_kwh: fixture.slots.map(s => s.import_price_sek_per_kwh),
  export_sek_per_kwh: fixture.slots.map(s => s.export_price_sek_per_kwh), surplus_w: fixture.slots.map(() => 0) };

Deno.test("bathroom replay: historical rounded 21 C targets do not invent 686 W of floor heating", () => {
  const s = bathroom();
  const historical = fixture.historical_commands.map(c => ({ ...c, type: "setpoint" as const }));
  const retained = historical.map((command, i) => ({ device_commands: { [floor]: command,
    [rack]: { type: "switch_schedule" as const, on_seconds: fixture.actuals[i].rack_w > 75 ? 900 : 0 } },
    device_loads_w: { [floor]: fixture.historical_planned_floor_w[i] } }));
  const result = prepareRoomServices(s, retained, undefined, prices);
  assertEquals(result.commands[floor], historical);
  assertEquals(result.power[floor], s.slots.map(() => 0));
  assert(fixture.historical_planned_floor_w.some(w => w > 680));
  const at17 = result.temperature.master_bathroom[14]!;
  assertAlmostEquals(at17, fixture.actuals.at(-1)!.room_c!, .04);
});

Deno.test("bathroom replay: Comfort recovery uses supported targets and reproduces every published power and temperature", () => {
  const s = bathroom(), z = s.thermal_zones![0], t = s.device_models.find(d => d.key === floor)!;
  const unit: RoomThermostat = { ...t.thermostat!, power_w: t.active_power_w!, sensor_offset_c: t.thermostat!.current_temperature_c - z.start_temperature_c! };
  // Counterfactual recovery request on the recorded bathroom physics/state.
  z.comfort_min_c.fill(21); z.target_c.fill(21);
  const result = prepareRoomServices(s, [], undefined, prices);
  let state: ThermostatRoomState = { temperature_c: z.start_temperature_c!, delivered_w: 0, heating_mask: 0 };
  let sawHeating = false;
  for (let i = 0; i < s.slots.length; i++) {
    const command = result.commands[floor][i]; assert(command.type === "setpoint");
    assertEquals(command.target_c, nativeTarget(unit, command.target_c));
    const hours = Math.min(.25, (Date.parse(s.slots[i].start) + 900000 - Date.parse(s.captured_at)) / 3600000);
    const steps = Math.ceil(hours * 60);
    const q = { hours, steps, step: roomTransition(z.model!, { hours: hours / steps,
      outdoor_c: s.outdoor_temperature_c![i]!, background_c_per_h: backgroundRateForSlot(z.model!, i, s.solar_irradiance_w_per_m2) }) };
    if (result.power[floor][i] > 680 && state.heating_mask === 0) {
      assert(command.target_c >= state.temperature_c + unit.sensor_offset_c + .5 - 1e-9);
      sawHeating = true;
    }
    const projected = projectThermostatQuarter(q, [unit], state, [command.target_c], result.power[rack][i]);
    assertAlmostEquals(projected.thermostat_w[0], result.power[floor][i], 1e-8);
    assertAlmostEquals(projected.state.temperature_c, result.temperature.master_bathroom[i]!, 1e-8);
    assertAlmostEquals(result.room_power.master_bathroom[i], result.power[floor][i] + result.power[rack][i], 1e-8);
    state = projected.state;
  }
  assert(sawHeating, "The replacement plan can actually start the floor heater");
  assert(result.commands[floor].some(c => c.type === "setpoint" && c.target_c === 22));
});
