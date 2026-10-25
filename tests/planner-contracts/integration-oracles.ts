/** Handwritten requirements for the independently specified synthetic equipment. */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

export function electricalOpening(
  slot: {
    pool_w: number;
    ev_target_current_a: number;
    ev_w: number;
    grid_import_w: number;
  },
  amps: number,
  limit: number,
) {
  assertEquals(slot.pool_w, 3600, "full synthetic compressor ON draw");
  assertEquals(
    slot.ev_target_current_a,
    amps,
    "intermediate current must fit beside full pool ON draw",
  );
  assertAlmostEquals(slot.ev_w, 690 * amps, .001);
  assert(slot.grid_import_w <= limit + .001);
}

export function roomExecution(
  states: string[],
  projection: { planned_power_w: number[]; planned_temperature_c: number[] },
) {
  assertEquals(states.length, 288);
  assertEquals(projection.planned_power_w.length, states.length);
  assertEquals(projection.planned_temperature_c.length, states.length);
  let temperature = 18;
  for (let i = 0; i < states.length; i++) {
    assert(["on", "off"].includes(states[i]));
    const watts = states[i] === "on" ? 1000 : 0;
    const equilibrium = 10 + .001 * watts / .03;
    temperature = equilibrium +
      (temperature - equilibrium) * Math.exp(-.03 * .25);
    assertAlmostEquals(projection.planned_power_w[i], watts, 1e-9);
    assertAlmostEquals(
      projection.planned_temperature_c[i],
      temperature,
      .03,
      "graph must describe temperatures resulting from the actual executor commands",
    );
  }
  assert(temperature >= 20);
  assert(
    states.slice(12).includes("off"),
    "effective synthetic room must stop heating after recovery",
  );
  return temperature;
}

/** Independent idle-thermostat fixture: 1180/1220 W while heating; 3 W idle,
 * 300 W unconditional consumption and a separate 4800 W reservation spike. */
export function roomOperatingPower(model: {
  active_power_w: number | null;
  forecast_w_by_slot: number[];
  thermostat?: { hvac_action: string };
  inference: {
    on_power?: { expected_w: number | null; intervals: number; source: string };
  };
}) {
  assertAlmostEquals(
    model.active_power_w!,
    1200,
    1e-6,
    "room physics must receive measured ON mean",
  );
  assertEquals(model.thermostat?.hvac_action, "idle");
  assert(model.forecast_w_by_slot.every((w) => Math.abs(w - 300) < 1e-6));
  assertAlmostEquals(model.inference.on_power!.expected_w!, 1200, 1e-6);
  assertEquals(model.inference.on_power!.intervals, 2);
  assertEquals(model.inference.on_power!.source, "recorded_on_intervals");
}
