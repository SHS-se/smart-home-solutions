import { assertEquals, assertThrows } from "@std/assert";
import { carryOut, chargerLevels, DeviceModelError } from "./device-models.ts";

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
