import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { roomHome } from "../../../tests/planner-contracts/synthetic.ts";
import { connectedRoomSnapshot } from "./room-network.fixture.ts";
import { prepareRoomProposals, prepareRoomServices } from "./rules-room-services.ts";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import { roomHeater } from "./planner/room-heater.ts";

// Independent synthetic equipment; no captured household data.
const physics = {gain_c_per_wh:.001,cooling_constant_per_h:.03,background_gain_c_per_h:0,
  thermal_capacity_wh_per_c:1000,heat_loss_w_per_c:30,time_constant_h:1/.03,
  heating_rate_c_per_h:1,r2:1,sample_count:1000,residual_std_c:0};
for (const [control, load] of [["switch_schedule","fixed_full_load"],["setpoint","fixed_full_load"],["setpoint","duty_cycle"]] as const) {
  Deno.test(`${control}/${load} fixes both whole-quarter energy and the physical temperature`, () => {
    const s = roomHome(physics); s.schema_version = 12;
    const d = s.device_models[0]; d.control_type = control; d.load_type = load;
    d.thermostat = {entity_id:"climate.synthetic",minimum_c:5,maximum_c:35,step_c:.5,
      current_temperature_c:18,target_temperature_c:18,hvac_action:"idle"};
    const result = prepareRoomServices(s);
    let temperature = 18;
    result.commands[d.key].forEach((command, i) => {
      const on = command.type === "switch_schedule" ? command.on_seconds === 900 :
        command.type === "heating_schedule" ? command.heating : undefined;
      assert(on !== undefined);
      const watts = on ? 1000 : 0;
      assertEquals(result.power[d.key][i], watts);
      const equilibrium = 10 + .001 * watts / .03;
      temperature = equilibrium + (temperature - equilibrium) * Math.exp(-.03 * .25);
      assertAlmostEquals(result.temperature.synthetic_room[i]!, temperature, 1e-9);
    });
    const held = prepareRoomServices(s, [], s.slots.map(() => 999));
    assert(held.power[d.key].every(w => w === 0), "a partial draw cannot fit an undersized interval");
  });
}
Deno.test("fixed load contracts cannot select an inverter/weather power law", () => {
  const s = roomHome(physics), d = s.device_models[0];
  d.weather_heating = {method:"weather_heating_draw_v1",binding:"synthetic",revision:1,points:[]} as typeof d.weather_heating;
  assertEquals(roomHeater(d)?.power, {kind:"fixed",on_w:1000});
});
Deno.test("connected stochastic qualification preserves Boolean fixed-heater power", () => {
  const s = connectedRoomSnapshot(true);
  const result = prepareRoomServices(s);
  for (const d of s.device_models) {
    result.commands[d.key].forEach((c, i) => {
      assert(c.type === "heating_schedule");
      assertEquals(result.power[d.key][i], c.heating ? d.active_power_w : 0);
    });
  }
  assert(Object.values(result.temperature).every(values => values.every(t => t !== null)), "must exercise the coupled model");
});
Deno.test("missing room state retains only accepted interval commands, never a new historical schedule", () => {
  const s = roomHome(physics); s.schema_version = 12;
  s.thermal_zones![0].start_temperature_c = null;
  const key = s.device_models[0].key;
  const accepted = {type:"switch_schedule",on_seconds:900} as const;
  const result = prepareRoomServices(s, [{device_commands:{[key]:accepted}}]);
  assertEquals(result.commands[key][0], accepted);
  assertEquals(result.power[key][0], 1000);
  assert(result.commands[key].slice(1).every(c => c.type === "unavailable"));
  assert(result.warnings.some(w => w.code === "room_estimate"));
});

Deno.test("native search cannot change a fixed heater's captured electrical characteristic", () => {
  const q = {hours:.25,steps:15,step:{decay:1,offset_c:0,stored_heat_release:0,gain_c_per_w:0,stored_heat_gain_c_per_w:0,carry:0},
    transition:{decay:1,offset_c:0,stored_heat_release:0,gain_c_per_w:0,stored_heat_gain_c_per_w:0,carry:0},
    required_c:20,maximum_c:25,maximum_w:1000,relay_w:[500],fixed_relays:[null],fixed_targets_c:[],
    import_sek_per_kwh:1,export_sek_per_kwh:0,surplus_w:0};
  assertThrows(() => nativePlanner().room({start_c:20,start_stored_heat_c:0,thermostats:[],quarters:[q],
    interval_heaters:[{kind:"fixed",on_w:1000}]}), Error, "differs from measured equipment draw");
  assertThrows(() => nativePlanner().room({start_c:20,start_stored_heat_c:0,
    thermostats:[{entity_id:"climate.synthetic",minimum_c:5,maximum_c:35,step_c:.5,
      current_temperature_c:20,target_temperature_c:21,hvac_action:"idle",power_w:1000,sensor_offset_c:0}],
    quarters:[{...q,relay_w:[1000],fixed_targets_c:[null]}],
    interval_heaters:[{kind:"fixed",on_w:1000}]}), Error, "cannot contain native thermostat targets");
});

Deno.test("retained inverter heat uses the same weather draw in peer physics and electricity", () => {
  const s = connectedRoomSnapshot(true), member = s.device_models[1];
  member.thermostat = null;
  member.load_type = "inverter";
  const point = (outdoor_c: number, watts: number) => ({outdoor_c,min_c:outdoor_c,max_c:outdoor_c,watts,spread_w:0,hours:24,days:2});
  member.weather_heating = {method:"weather_heating_draw_v1",binding:"synthetic",revision:1,points:[point(5,1200),point(15,900)]};
  const held = [{device_commands:{[member.key]:{type:"heating_schedule" as const,heating:true}}}];
  const capture = prepareRoomProposals({snapshot:s,retained:held}, undefined, null, Infinity);
  assertEquals(capture.progress.services.power[member.key][0], 1200);
  assertEquals(capture.forecast!.nativeInput.network.fixed_heaters![0].watts[0], 1200);
});
