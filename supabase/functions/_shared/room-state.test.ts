import { assertAlmostEquals, assertEquals } from "@std/assert";
import { estimateRoomState, roomPlanClock, type RoomStateInterval } from "./planner/models/room/state.ts";
import { roomMeanObservation } from "./planner/models/room/observation.ts";
import { type DynamicThermalZoneModel, roomTransition, stepRoom } from "./planner/models/room/thermal.ts";

// Independently generated synthetic inputs only; no household data.
const H = 3_600_000;
const model = (lag = 0, exchange = 0): DynamicThermalZoneModel => ({
  response_family: exchange ? "finite" : "integrator", gain_c_per_wh: .001,
  cooling_constant_per_h: exchange, heat_lag_h: lag, background_gain_c_per_h: 0,
  thermal_capacity_wh_per_c: 1000, heat_loss_w_per_c: exchange * 1000,
  time_constant_h: exchange ? 1 / exchange : null, heating_rate_c_per_h: null,
  r2: 1, sample_count: 100, residual_std_c: 0,
});
const row = (from: number, to: number, watts: number | null, outdoor: number | null = 0): RoomStateInterval => ({
  start_ms: from * H, end_ms: to * H, heater_w: watts, outdoor_c: outdoor,
});
const input = (mean = 20, intervals: RoomStateInterval[] = []) => ({
  reading: { start_ms: 0, end_ms: .25 * H, mean_c: mean }, intervals,
  fallback: { outdoor_c: 0, house_c: 20, solar_w_per_m2: 0 },
});

/** Independent RK4 integration includes integral(T), without the production
 * endpoint or observation kernels. */
function integrate(physics: DynamicThermalZoneModel, initial: number[], hours: number, watts: number, outdoor = 0) {
  const lag = physics.heat_lag_h ?? 0, k = physics.cooling_constant_per_h;
  const derivative = ([t, q]: number[]) => [-k * (t - outdoor) + (lag ? q / lag : physics.gain_c_per_wh * watts),
    lag ? physics.gain_c_per_wh * watts - q / lag : 0, t];
  const count = 2000, dt = hours / count;
  let state = initial.slice();
  for (let i = 0; i < count; i++) {
    const a = derivative(state), b = derivative(state.map((x, j) => x + dt / 2 * a[j]));
    const c = derivative(state.map((x, j) => x + dt / 2 * b[j]));
    const d = derivative(state.map((x, j) => x + dt * c[j]));
    state = state.map((x, j) => x + dt / 6 * (a[j] + 2 * b[j] + 2 * c[j] + d[j]));
  }
  return state;
}

Deno.test("room clock clips the first interval and shares the exact capture anchor", () => {
  const captured_at = new Date(.1 * H).toISOString();
  const slots = [0, .25, .5].map(t => ({ start: new Date(t * H).toISOString() }));
  const clock = roomPlanClock({ captured_at, slots } as Parameters<typeof roomPlanClock>[0]);
  assertEquals(clock.start_ms, .1 * H);
  assertEquals(clock.hours, [.15, .25, .25]);
  assertEquals(roomPlanClock({ captured_at: new Date(-H).toISOString(), slots } as Parameters<typeof roomPlanClock>[0]).start_ms, 0);
});

Deno.test("native quarter mean of an integrator ramp is conditioned to its endpoint once", () => {
  const result = estimateRoomState(model(), input(20.125, [row(0, .5, 1000)]), .4 * H);
  assertAlmostEquals(result.temperature_c, 20.4, 1e-12);
  assertEquals(result.stored_heat_c, 0);
  assertEquals(result.observed_through, .25 * H);
  assertEquals(result.missing_power, []);
});

Deno.test("finite and integrator mean conditioning matches independent integration with delayed memory", () => {
  for (const exchange of [0, .03, 2, 20]) for (const lag of [0, .5, 2]) {
    const physics = model(lag, exchange);
    const pre = integrate(physics, [20, 0, 0], 1, 800);
    const observed = integrate(physics, [pre[0], pre[1], 0], .25, 300);
    const expected = integrate(physics, [observed[0], observed[1], 0], .15, 600);
    const result = estimateRoomState(physics, input(observed[2] / .25,
      [row(-1, 0, 800), row(0, .25, 300), row(.25, .4, 600)]), .4 * H);
    assertAlmostEquals(result.temperature_c, expected[0], 2e-9);
    assertAlmostEquals(result.stored_heat_c, expected[1], 2e-9);
  }
});

Deno.test("a mean spanning changing power uses the integrated observation rather than averaged inputs", () => {
  const physics = model(.5, .2);
  const first = integrate(physics, [20, 0, 0], .1, 900);
  const second = integrate(physics, first, .15, 0);
  const result = estimateRoomState(physics, input(second[2] / .25, [row(0, .1, 900), row(.1, .25, 0)]), .25 * H);
  assertAlmostEquals(result.temperature_c, second[0], 1e-9);
  assertAlmostEquals(result.stored_heat_c, second[1], 1e-9);
});

Deno.test("zero-duration state preserves the reading and zero-duration transition is identity", () => {
  const physics = model(2, .1), data = input(20, [row(-1, 0, 800)]);
  data.reading.end_ms = 0;
  const result = estimateRoomState(physics, data, 0);
  assertEquals(result.temperature_c, 20);
  const state = { temperature_c: result.temperature_c, stored_heat_c: result.stored_heat_c };
  assertEquals(stepRoom(roomTransition(physics, { hours: 0, outdoor_c: 0, background_c_per_h: 0 }), state, 1000), state);
});

Deno.test("elapsed finite and integrator propagation obeys the semigroup law", () => {
  for (const exchange of [0, .2]) for (const lag of [0, 2]) {
    const physics = model(lag, exchange), data = input(20, [row(-1, 1, 400)]);
    const first = estimateRoomState(physics, data, .4 * H);
    const split = stepRoom(roomTransition(physics, { hours: .6, outdoor_c: 0, background_c_per_h: 0 }), first, 400);
    const whole = estimateRoomState(physics, data, H);
    assertAlmostEquals(split.temperature_c, whole.temperature_c, 1e-12);
    assertAlmostEquals(split.stored_heat_c, whole.stored_heat_c, 1e-12);
  }
});

Deno.test("conditioned mean endpoint coefficients never overstate unknown nonnegative heat", () => {
  for (const k of [0, .001, .03, .5, 2, 20, 1000]) for (const lag of [0, .01, .5, 2, 100]) {
    const op = roomMeanObservation(k, lag, .25), rho = op.a / op.E;
    for (const coefficient of [op.B - rho * op.U, op.effect - op.B - rho * (op.V - op.U), op.effect - rho * op.V]) {
      assertEquals(coefficient >= -1e-12, true, `k=${k}, lag=${lag}, coefficient=${coefficient}`);
    }
  }
});

Deno.test("newest missing quarter and interior holes retain delayed heat and repair on recapture", () => {
  const physics = model(2, .05);
  const full = [row(-1, .25, 800), row(.25, .5, 600), row(.5, .75, 400), row(.75, 1, 700)];
  const complete = estimateRoomState(physics, input(20, full), H);
  for (const removed of [2, 3]) {
    const incomplete = full.filter((_, i) => i !== removed);
    const estimate = estimateRoomState(physics, input(20, incomplete), H);
    assertEquals(estimate.missing_power, [{ start_ms: full[removed].start_ms, end_ms: full[removed].end_ms }]);
    assertEquals(estimate.stored_heat_c > 0, true);
    assertEquals(estimate.stored_heat_c < complete.stored_heat_c, true);
    assertEquals(estimate.temperature_c < complete.temperature_c, true);
    assertEquals(estimateRoomState(physics, input(20, full), H), complete);
  }
});

Deno.test("unavailable counter during the mean is a useful-heat estimate, not measured zero", () => {
  const physics = model(2, .1);
  const available = estimateRoomState(physics, input(20, [row(-1, .25, 800)]), .25 * H);
  const unavailable = estimateRoomState(physics, input(20, [row(-1, 0, 800), row(0, .25, null)]), .25 * H);
  assertEquals(unavailable.missing_power, [{ start_ms: 0, end_ms: .25 * H }]);
  assertEquals(unavailable.temperature_c < available.temperature_c, true);
  assertEquals(unavailable.stored_heat_c > 0, true);
});

Deno.test("missing weather, house and solar use explicit boundary estimates without crediting variable-gain heat", () => {
  const physics = { ...model(2, .1), house_coupling_per_h: .2, solar_gain_c_per_h_per_wm2: .001,
    gain_reference_outdoor_c: 0, gain_outdoor_slope_per_c: .01 };
  const result = estimateRoomState(physics, input(20, [row(0, .25, 800, null)]), .25 * H);
  assertEquals(result.stored_heat_c, 0);
  assertEquals(result.missing_power, []);
  assertEquals(result.estimated_boundary, [{ start_ms: 0, end_ms: .25 * H, fields: ["outdoor_c", "house_c", "solar_w_per_m2"] }]);
});

Deno.test("long missing spans are integrated as one span with no age rejection", () => {
  const data = input(20, [row(0, .25, 0)]);
  const result = estimateRoomState(model(2, .1), data, 10_000_000 * H);
  assertEquals(result.temperature_c, 0);
  assertEquals(result.stored_heat_c, 0);
  assertEquals(result.missing_power, [{ start_ms: .25 * H, end_ms: 10_000_000 * H }]);
});

Deno.test("future mean provenance remains intact without rejecting the room or reversing dynamics", () => {
  const data = input(20.125, [row(0, .25, 1000)]);
  assertAlmostEquals(estimateRoomState(model(), data, .1 * H).temperature_c, 20.1, 1e-12);
  const before = estimateRoomState(model(), data, -.1 * H);
  assertAlmostEquals(before.temperature_c, 20, 1e-12);
  assertEquals(before.observed_through, .25 * H);
});
