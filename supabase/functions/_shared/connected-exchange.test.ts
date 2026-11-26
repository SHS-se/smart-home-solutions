import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { filterConnectedRoomExchange, forecastConnectedExchange, readConnectedRoomResponse } from "./planner/models/room/connected-exchange.ts";
import { syntheticConnectedPlant as plant, syntheticConnectedResponse as response } from "./connected-exchange.fixture.ts";

Deno.test("connected native mean filter carries constant dynamics consistently at quarter and hourly resolution", () => {
  for (const duration of [900, 3600] as const) {
    const rows = plant(false, duration), model = response(false);
    const result = filterConnectedRoomExchange(model, rows, 8 * 86400_000);
    assert(result.diagnostics.thermal_state_identified);
    assertEquals(result.diagnostics.observed_intervals, rows.length);
    assert(Math.sqrt(result.diagnostics.squared_error_c2 / rows.length) < .002);
    assert(readConnectedRoomResponse({ ...model, reference_state: result.posterior }));
  }
});

Deno.test("missing meter, thermometer and newest late quarter conserve independently measured heater storage", () => {
  const model = response(false);
  model.thermal.heater = { gain_c_per_wh: .001, lag_h: 2, gain_reference_outdoor_c: 0, gain_outdoor_slope_per_c: 0 };
  const initial = { ...model.reference_state, through_ms: 0, stored_heat_c: 1, observations: 1 };
  const rows = [{ start_ms: 0, duration_s: 900 as const, room_c: null, outdoor_c: 5, heat_w: 1000, cooling: false,
    solar_w_per_m2: null, peer_c: { peer: null } }, { start_ms: 900_000, duration_s: 900 as const, room_c: null,
    outdoor_c: 5, heat_w: null, cooling: false, solar_w_per_m2: null, peer_c: { peer: 23 } }];
  const result = filterConnectedRoomExchange(model, rows, 2700_000, initial);
  const afterMeasured = Math.exp(-.25 / 2) + 2 * (1 - Math.exp(-.25 / 2));
  assertAlmostEquals(result.posterior.stored_heat_c, afterMeasured * Math.exp(-.5 / 2), 1e-12);
  assertEquals(result.diagnostics.thermal_state_identified, false);
  assertEquals(result.diagnostics.observed_intervals, 0);
  assertEquals(result.diagnostics.numerical_failures, 0);
});

Deno.test("zero exchange does not read an unavailable peer and qualified direction facts admit measured heating", () => {
  const model = response(false); model.incoming[0] = { kind: "constant", from: "peer", per_h: 0 };
  model.thermal.heater = { gain_c_per_wh: .001, lag_h: 0, gain_reference_outdoor_c: 0, gain_outdoor_slope_per_c: 0 };
  const rows = Array.from({ length: 3 }, (_, i) => ({ start_ms: i * 900_000, duration_s: 900 as const,
    room_c: 20, outdoor_c: 5, heat_w: 100, cooling: null, operation_fact: "qualified-source-fact", solar_w_per_m2: null }));
  const filtered = filterConnectedRoomExchange(model, rows, 2700_000);
  assertEquals(filtered.diagnostics.observed_intervals, 3);
  assertEquals(filtered.diagnostics.numerical_failures, 0);
});
Deno.test("recent means change effective exchange without a parameter refit or future observations", () => {
  const rows = plant(true), model = response(), first = filterConnectedRoomExchange(model, rows, 4 * 86400_000);
  const later = filterConnectedRoomExchange(model, rows, 8 * 86400_000);
  const before = forecastConnectedExchange(model, first.posterior, 0)[0], after = forecastConnectedExchange(model, later.posterior, 0)[0];
  assertAlmostEquals(before, .1, .03); assert(after > .5, String(after));
  const changedFuture = rows.map(row => row.start_ms >= 4 * 86400_000 ? { ...row, room_c: 100 } : row);
  assertEquals(filterConnectedRoomExchange(model, changedFuture, 4 * 86400_000), first);
  assert(forecastConnectedExchange(model, later.posterior, 1000)[0] < after);
});
Deno.test("late observations and interior holes repair by replay and never become measured idle", () => {
  const rows = plant(true), model = response(), complete = filterConnectedRoomExchange(model, rows, 8 * 86400_000);
  for (const missing of [rows.slice(0, -1), rows.filter((_row, i) => i !== 300), rows.map((row, i) => i === 500 ? { ...row, peer_c: { peer: null } } : row)]) {
    const partial = filterConnectedRoomExchange(model, missing, 8 * 86400_000);
    assert(partial.posterior.observations > 0);
    assertEquals(filterConnectedRoomExchange(model, rows, 8 * 86400_000), complete);
  }
});

Deno.test("unknown static exchange center propagates joint covariance without inventing ongoing center drift", () => {
  const model = response();
  model.incoming = [{ kind: "log_ou", from: "peer", mean_log_per_h: -3, reversion_per_h: .4, stationary_variance: .2 }];
  const initial = { through_ms: 0, temperature_c: 21, stored_heat_c: 0, observations: 4,
    log_rates: [Math.log(.3)], log_centers: [Math.log(.2)],
    covariance: [[.1, 0, .02, .01], [0, 0, 0, 0], [.02, 0, .4, .15], [.01, 0, .15, .25]] };
  assert(readConnectedRoomResponse({ ...model, reference_state: initial }));
  const hours = 6, a = Math.exp(-.4 * hours), b = 1 - a;
  const propagated = filterConnectedRoomExchange(model, [], hours * 3600_000, initial).posterior;
  assertAlmostEquals(propagated.log_rates[0], a * initial.log_rates[0] + b * initial.log_centers[0], 1e-12);
  assertEquals(propagated.log_centers, initial.log_centers);
  assertAlmostEquals(propagated.covariance[2][2], a * a * .4 + b * b * .25 + 2 * a * b * .15 + (1 - a * a) * .2, 1e-12);
  assertAlmostEquals(propagated.covariance[2][3], a * .15 + b * .25, 1e-12);
  assertAlmostEquals(propagated.covariance[0][2], a * .02 + b * .01, 1e-12);
  assertEquals(propagated.covariance[3][3], .25);
  assertAlmostEquals(forecastConnectedExchange(model, initial, 100_000)[0], .2 * Math.exp((.25 + .2) / 2), 1e-12);
  assertEquals(readConnectedRoomResponse({ ...model, reference_state: { ...initial, log_centers: [] } }), null);
});
