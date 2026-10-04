import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  DeviceModelError, type HeatPumpResponse, parseDeviceModels, parseHeaterResponse, projectHeatPumpResponse,
} from "./device-models.ts";

const response: HeatPumpResponse = {
  kind: "bergvarme",
  startup: [
    { elapsed_seconds: 0, electric_fraction: 0, heat_fraction: 0 },
    { elapsed_seconds: 300, electric_fraction: 0, heat_fraction: 0 },
    { elapsed_seconds: 600, electric_fraction: 1, heat_fraction: 0.5 },
    { elapsed_seconds: 900, electric_fraction: 1, heat_fraction: 1 },
  ],
};
const power = { compressor_w: 3000, auxiliary_w: 600 };
const nominal = power.compressor_w + power.auxiliary_w;

Deno.test("heater response parsing accepts explicit steady and validated independent electricity and heat curves", () => {
  assertEquals(parseHeaterResponse({ kind: "steady" }), { kind: "steady" });
  const evidence = {
    source: "power_and_supply_return_temperature", observed_start: "2026-10-03T19:30:01.634000+00:00",
    heat_basis: "supply_return_delta_proxy", heat_flow_measured: false,
    steady_compressor_w: 2990.5, steady_delta_c: 6.8, sample_count: 1,
  };
  const input = { ...response, evidence };
  const parsed = parseHeaterResponse(input);
  assertEquals(parsed, input);
  if (parsed.kind === "bergvarme") parsed.startup[1].heat_fraction = 0.1;
  assertEquals(response.startup[1].heat_fraction, 0);
  assertThrows(() => parseHeaterResponse(null), DeviceModelError);
  assertThrows(() => parseHeaterResponse({ kind: "other" }), DeviceModelError);
  for (const startup of [
    [],
    [{ elapsed_seconds: 0, electric_fraction: 1, heat_fraction: 1 }],
    [{ elapsed_seconds: 1, electric_fraction: 0, heat_fraction: 0 }, response.startup[3]],
    [response.startup[0], response.startup[0], response.startup[3]],
    [response.startup[0], { elapsed_seconds: Infinity, electric_fraction: 1, heat_fraction: 1 }],
    [response.startup[0], { elapsed_seconds: 900, electric_fraction: -1, heat_fraction: 1 }],
    [response.startup[0], { elapsed_seconds: 900, electric_fraction: 1, heat_fraction: 1.1 }],
    [response.startup[0], { elapsed_seconds: 900, electric_fraction: 0, heat_fraction: 1 }],
    [response.startup[0], response.startup[2]],
  ]) assertThrows(() => parseHeaterResponse({ kind: "bergvarme", startup }), DeviceModelError);
  assertThrows(() => parseHeaterResponse({ ...response, evidence: { ...evidence, sample_count: 1.5 } }), DeviceModelError);
});

Deno.test("steady response is the exact command identity, with explicit on age and off boundaries", () => {
  assertEquals(projectHeatPumpResponse({ kind: "steady" }, power, [nominal, nominal, 0, nominal], [0.25, 0.25, 0.25, 0.1], null), {
    draw_w: [nominal, nominal, 0, nominal], gain_fraction: [1, 1, 0, 1],
    elapsed_seconds_by_boundary: [null, 900, 1800, null, 360],
  });
});

Deno.test("startup projects auxiliaries and delivered heat independently from compressor electricity", () => {
  const projected = projectHeatPumpResponse(response, power, [nominal, nominal], [0.25, 0.25], null);
  assertEquals(projected.draw_w, [2100, nominal]);
  assertAlmostEquals(projected.gain_fraction[0], 1 / 3);
  assertEquals(projected.gain_fraction[1], 1);
  assertEquals(projected.elapsed_seconds_by_boundary, [null, 900, 1800]);
  // The startup buys 0.525 kWh but delivers only one third of a steady quarter's heat.
  assertAlmostEquals(projected.draw_w[0] / 1000 * 0.25, 0.525);
  const phases = projectHeatPumpResponse(response, power, [nominal, nominal, nominal], [1 / 12, 1 / 12, 1 / 12], null);
  assertEquals(phases.draw_w, [600, 2100, nominal]);
  assertEquals(phases.gain_fraction, [0, 0.25, 0.75]);
  const withoutAuxiliary = projectHeatPumpResponse(response, { ...power, auxiliary_w: 0 }, [power.compressor_w], [1 / 12], null);
  assertEquals(withoutAuxiliary.draw_w, [0]);
  assertEquals(withoutAuxiliary.gain_fraction, [0]);
});

Deno.test("splitting an interval or continuing a partial horizon preserves electricity, heat and runtime", () => {
  const whole = projectHeatPumpResponse(response, power, [nominal], [0.25], null);
  const first = projectHeatPumpResponse(response, power, [nominal], [0.125], null);
  const second = projectHeatPumpResponse(response, power, [nominal], [0.125], first.elapsed_seconds_by_boundary[1]);
  assertAlmostEquals((first.draw_w[0] + second.draw_w[0]) / 2, whole.draw_w[0]);
  assertAlmostEquals((first.gain_fraction[0] + second.gain_fraction[0]) / 2, whole.gain_fraction[0]);
  assertEquals(second.elapsed_seconds_by_boundary[1], whole.elapsed_seconds_by_boundary[1]);
  const partial = projectHeatPumpResponse(response, power, [nominal], [1 / 6], 450);
  assertEquals(partial.draw_w, [3412.5]);
  assertEquals(partial.gain_fraction, [0.71875]);
  assertEquals(partial.elapsed_seconds_by_boundary, [450, 1050]);
});

Deno.test("true off resets startup while repeated on and already running horizons preserve run age", () => {
  const projected = projectHeatPumpResponse(response, power, [nominal, 0, nominal, nominal], [0.25, 0.25, 0.25, 0.25], 900);
  assertEquals(projected.draw_w, [nominal, 0, 2100, nominal]);
  assertEquals(projected.elapsed_seconds_by_boundary, [900, 1800, null, 900, 1800]);
  const knownSteady = projectHeatPumpResponse(response, power, [nominal, 0, nominal], [0.25, 0.25, 0.25], Infinity);
  assertEquals(knownSteady.draw_w, [nominal, 0, 2100]);
  assertEquals(knownSteady.elapsed_seconds_by_boundary, [Infinity, Infinity, null, 900]);
});

Deno.test("response projector rejects unexecutable commands, invalid runtime and nonphysical intervals", () => {
  const project = (commands: number[], hours: number[], age: number | null = null) => projectHeatPumpResponse(response, power, commands, hours, age);
  assertThrows(() => project([nominal], []), DeviceModelError);
  for (const command of [-1, nominal / 2, Infinity, NaN]) assertThrows(() => project([command], [0.25]), DeviceModelError);
  for (const hours of [0, -1, Infinity, NaN, Number.MAX_VALUE]) assertThrows(() => project([nominal], [hours]), DeviceModelError);
  for (const age of [-1, -Infinity, NaN]) assertThrows(() => project([nominal], [0.25], age), DeviceModelError);
  assertThrows(() => projectHeatPumpResponse(response, { compressor_w: 0, auxiliary_w: 600 }, [600], [0.25], null), DeviceModelError);
  assertThrows(() => projectHeatPumpResponse(response, { compressor_w: 3000, auxiliary_w: -1 }, [2999], [0.25], null), DeviceModelError);
});

Deno.test("device-model parsing validates configured startup response without changing static models", () => {
  const pool = {
    store: { capacity_kwh_per_c: 60, loss: { kind: "linear" as const, kw_per_c: 0.1, surroundings_c: 15 } },
    heater: {
      setting_unit: "kw_thermal", operating_points: [{ setting: 12, electric_w: 3000, heat_w: 12000 }],
      selected_setting: 12, control: "switch" as const, auxiliary_w: 600, response,
    },
  };
  assertEquals(parseDeviceModels({ pool }), { pool });
  assertThrows(() => parseDeviceModels({ pool: { ...pool, heater: { ...pool.heater, response: { kind: "bergvarme", startup: [] } } } }), DeviceModelError);
});
