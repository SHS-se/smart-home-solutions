import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  carryOut, chargerLevels, cop, DeviceModelError, electricKwhPerDegree, heatPumpLevels, idleCPerHour, operatingPoint,
  parseDeviceModels, stepThermalStore, thermalTimeConstantH,
} from "./device-models.ts";

const charger = { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1 };

Deno.test("a charger runs at whole amps between its limits, or not at all", () => {
  const levels = chargerLevels(charger);
  assertEquals(levels.length, 13);
  assertEquals([levels[0], levels[1], levels[12]], [{ setting: 0, draw_w: 0 }, { setting: 5, draw_w: 3450 }, { setting: 16, draw_w: 11040 }]);
  // A single-phase charger in two-amp steps has its own levels: the numbers are the model's.
  assertEquals(chargerLevels({ voltage_v: 230, phase_count: 1, min_current_a: 6, max_current_a: 10, current_step_a: 2 }).map(level => level.draw_w), [0, 1380, 1840, 2300]);
  assertThrows(() => chargerLevels({ ...charger, max_current_a: 15.5 }), DeviceModelError, "whole number of steps");
  assertThrows(() => chargerLevels({ ...charger, min_current_a: 0 }), DeviceModelError);
});

Deno.test("a request between two levels is carried out at the lower one", () => {
  const levels = chargerLevels(charger);
  const asked = (w: number, tolerance = 1) => { const { run, refused_w } = carryOut(levels, w, tolerance); return [run.setting, run.draw_w, refused_w]; };
  assertEquals(asked(3450), [5, 3450, 0]);
  assertEquals(asked(4000), [5, 3450, 550]);
  // Below five amps the charger does not run.
  assertEquals(asked(2000), [0, 0, 2000]);
  assertEquals(asked(0), [0, 0, 0]);
  // Rounding is not a step: within the tolerance below a level is that level.
  assertEquals(asked(3449.5), [5, 3450, 0]);
  assertEquals(asked(3446), [0, 0, 3446]);
  // Above the highest level it runs flat out.
  assertEquals(asked(12_000), [16, 11040, 960]);
});

// The S1256 pool function as measured in September 2026: heat delivered against compressor electricity.
const heater = {
  setting_unit: "kw_thermal", control: "switch" as const, selected_setting: 12, auxiliary_w: 764, minimum_run_s: 4 * 3600,
  operating_points: [
    { setting: 6, electric_w: 1_250, heat_w: 5_875 },
    { setting: 8, electric_w: 1_650, heat_w: 7_755 },
    { setting: 10, electric_w: 2_250, heat_w: 10_520 },
    { setting: 12, electric_w: 3_000, heat_w: 12_450 },
  ],
};
const store = { capacity_kwh_per_c: 63.965, loss: { kind: "linear" as const, kw_per_c: 0.13, surroundings_c: 13.5 } };
const models = () => structuredClone({
  battery: { capacity_kwh: 18.08, min_soc: 0.05, max_soc: 1, charge_max_w: 8_800, discharge_max_w: 9_600, charge_efficiency: 0.95, discharge_efficiency: 0.95 },
  car: { battery: { capacity_kwh: 75.6, kwh_per_km: 0.16, charge_efficiency: 0.92 }, charger },
  pool: { store, heater },
});

Deno.test("a heat pump's COP is what it was measured to give at its setting, whatever the weather", () => {
  assertEquals(heater.operating_points.map(point => Math.round(cop(point) * 100) / 100), [4.7, 4.7, 4.68, 4.15]);
  // Between two measured settings: the line between them.
  assertEquals(operatingPoint(heater, 9), { setting: 9, electric_w: 1_950, heat_w: 9_137.5 });
  assertThrows(() => operatingPoint(heater, 13), DeviceModelError, "outside");
  // On, it draws its compressor and the pump that must run with it; only the compressor's heat reaches the water.
  assertEquals(heatPumpLevels(heater), [{ setting: 0, draw_w: 0, heat_w: 0 }, { setting: 12, draw_w: 3_764, heat_w: 12_450 }]);
  assertEquals(heatPumpLevels({ ...heater, selected_setting: 10 })[1], { setting: 10, draw_w: 3_014, heat_w: 10_520 });
  // A degree of this pool costs 19.3 kWh from the grid at 12 kW, 18.3 at 10 kW.
  assertAlmostEquals(electricKwhPerDegree(store, heatPumpLevels(heater)[1]), 19.34, 0.01);
  assertAlmostEquals(electricKwhPerDegree(store, heatPumpLevels({ ...heater, selected_setting: 10 })[1]), 18.33, 0.01);
});

Deno.test("a store loses its heat to its surroundings, and gains what is put into it", () => {
  // Unheated at 30 °C: 2.1 kW to surroundings at 13.5 °C, the same in frost and in a heat wave.
  assertAlmostEquals(idleCPerHour(store, 30, -5), -0.03353, 1e-5);
  assertEquals(idleCPerHour(store, 30, -5), idleCPerHour(store, 30, 32));
  assertEquals(stepThermalStore(store, 13.5, 0, 20, 1), 13.5);
  // A quarter of the heat pump: 12.45 kW into 64 kWh per degree, less the loss.
  assertAlmostEquals(stepThermalStore(store, 30, 12_450, 20, 0.25) - 30, 12.45 / 63.965 / 4 - 0.03353 / 4, 1e-5);
  // A surplus of heat fades with the store's time constant: 492 hours here.
  assertAlmostEquals(thermalTimeConstantH(store, 30, 10), 63.965 / 0.13, 1e-6);
  // A loss to the outdoor air follows the weather.
  const outdoors = { ...store, loss: { kind: "linear" as const, kw_per_c: 0.13, surroundings_c: null } };
  assert(idleCPerHour(outdoors, 30, 0) < idleCPerHour(outdoors, 30, 25));
  // A measured rate: the line between its points, held beyond them, never a warming.
  const measured = { capacity_kwh_per_c: 63.965, loss: { kind: "measured" as const, points: [{ at_c: 28, c_per_h: -0.02 }, { at_c: 30, c_per_h: -0.04 }, { at_c: 31, c_per_h: 0.01 }] } };
  assertEquals([28, 29, 30, 35, 20].map(c => idleCPerHour(measured, c, 0)), [-0.02, -0.03, -0.04, 0, -0.02]);
});

Deno.test("device models are checked once and never filled in", () => {
  const parsed = parseDeviceModels(models());
  assertEquals(parsed, models());
  const broken = (change: (m: ReturnType<typeof models>) => void) => { const m = models(); change(m); return () => parseDeviceModels(m); };
  assertThrows(broken(m => { m.pool.heater.selected_setting = 14; }), DeviceModelError, "outside");
  assertThrows(broken(m => { m.pool.heater.operating_points[2].electric_w = 1_000; }), DeviceModelError, "rise");
  assertThrows(broken(m => { m.pool.heater.operating_points = []; }), DeviceModelError, "at least one");
  assertThrows(broken(m => { m.car.charger.max_current_a = 15.5; }), DeviceModelError, "whole number of steps");
  assertThrows(broken(m => { m.battery.min_soc = 1; }), DeviceModelError, "in order");
  assertThrows(broken(m => { m.pool.store.capacity_kwh_per_c = 0; }), DeviceModelError, "heat capacity");
});
