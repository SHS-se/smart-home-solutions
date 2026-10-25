import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fitRoomMeans, type RoomMeanQuarter } from "../../supabase/functions/_shared/device-learning/room/mean-observations.ts";
import { fitRoomsFromQuarters, zoneModelRows } from "../../supabase/functions/_shared/thermal-training.ts";
import { fitRoom } from "../../supabase/functions/_shared/device-learning/room/fit.ts";

/** Independently generated synthetic recorder observations; one-second ODE integration. */
function synthetic(lag: number, options: { missing?: boolean; solar?: boolean; sparse?: boolean; disturbance?: number } = {}): RoomMeanQuarter[] {
  let seed = 5, temperature = 20, delivered = 0;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const rows: RoomMeanQuarter[] = [];
  for (let quarter = 0; quarter < 14 * 96; quarter++) {
    const house = 20 + Math.sin(quarter / 96 * 2 * Math.PI), outdoor = 5 + Math.sin(quarter / 51);
    const power = random() > (options.sparse ? 0.95 : 0.7) ? 800 : 0;
    const solar = options.solar ? Math.max(0, 300 * Math.sin(quarter / 96 * 2 * Math.PI)) : 0;
    let sum = 0;
    for (let second = 0; second < 900; second++) {
      // Midpoint measurement integration avoids matching the production formula.
      const rate = .002 * (lag ? delivered : power) + .2 * (house - temperature) - .1 + .0003 * solar;
      sum += temperature + rate / 7200;
      temperature += rate / 3600;
      if (lag) delivered += (power - delivered) / lag / 3600;
    }
    rows.push({ start_ms: quarter * 900_000,
      room_c: sum / 900 + (options.disturbance ?? 0) * Math.sin(quarter / 250),
      outdoor_c: outdoor, house_c: house, solar_w_per_m2: options.solar ? solar : null,
      heat_w: options.missing && quarter >= 600 && quarter < 650 ? null : power, cooling: false });
  }
  return rows;
}

for (const lag of [0, 2]) Deno.test(`interval means recover known heater gain and ${lag} h delay`, () => {
  const fit = fitRoomMeans(synthetic(lag), 800);
  assert(fit.ok);
  assertEquals(fit.model.heat_lag_h, lag);
  assertAlmostEquals(fit.model.gain_c_per_wh, .002, .00002);
  assertAlmostEquals(fit.model.house_coupling_per_h!, .2, .002);
  assertAlmostEquals(fit.model.background_gain_c_per_h, -.1, .002);
  assert(fit.learning_evidence!.validation_pairs > 300);
  assert(fit.learning_evidence!.validation_mse_c2! < 1e-6);
});

Deno.test("the producer-style mean contract catches the old interval-start interpretation", () => {
  const rows = synthetic(0);
  const wrong = fitRoom(rows.map(r => ({ ...r, heat_w: r.heat_w! })), 800);
  assert(wrong.ok);
  assert(Math.abs(wrong.model.gain_c_per_wh - .002) > .0005,
    "the seeded start-observation interpretation must fail known heater response");
  const correct = fitRoomMeans(rows, 800);
  assert(correct.ok);
  assertAlmostEquals(correct.model.gain_c_per_wh, .002, .00002);
});

Deno.test("missing heat observations do not become zero or reset delayed heat to zero", () => {
  const complete = synthetic(2), missing = synthetic(2, { missing: true });
  const fit = fitRoomMeans(missing, 800);
  assert(fit.ok);
  assertEquals(fit.model.heat_lag_h, 2);
  assertAlmostEquals(fit.model.gain_c_per_wh, .002, .00003);
  assertAlmostEquals(fit.model.house_coupling_per_h!, .2, .003);
  assertEquals(fit.model.sample_count, complete.length - 1 - 51);
  const unknown = fitRoomMeans(complete.map(r => ({ ...r, heat_w: null })), 800);
  assertEquals(unknown.ok, false);
  assertEquals(unknown.learning_evidence!.method, "interval_mean_transition_holdout_v1");
});

Deno.test("solar response and electrical heat remain distinct observed regressors", () => {
  const fit = fitRoomMeans(synthetic(2, { solar: true }), 800);
  assert(fit.ok);
  assertAlmostEquals(fit.model.gain_c_per_wh, .002, .00003);
  assertAlmostEquals(fit.model.solar_gain_c_per_h_per_wm2!, .0003, .00002);
});

Deno.test("held-out transitions retain heater response when slow ambient drift wins the old twelve-hour score", () => {
  // Synthetic independent plant plus a smooth unmodelled observation drift.
  // Sparse known heater pulses are the causal signal; the slow drift is not
  // evidence that the heater acquired a multi-hour delay or lost its gain.
  const rows = synthetic(0, { sparse: true, disturbance: .5 });
  const old = fitRoom(rows.map(r => ({ ...r, heat_w: r.heat_w! })), 800);
  assert(old.ok);
  assert(old.model.heat_lag_h! >= 1);
  assert(old.model.gain_c_per_wh < .0006);
  const fit = fitRoomMeans(rows, 800);
  assert(fit.ok);
  assertEquals(fit.model.heat_lag_h, 0);
  assertAlmostEquals(fit.model.gain_c_per_wh, .002, .0001);
  assertEquals(fit.learning_evidence!.method, "interval_mean_transition_holdout_v1");
  // Long-range error remains visible instead of being cosmetically improved
  // by selecting a model that ignores the measured electrical intervention.
  assert(fit.model.prediction_error_c! > old.model.prediction_error_c!);
});

Deno.test("the stored-observation bridge preserves mean semantics and method evidence on failed attempts", () => {
  const rows = synthetic(0).map(row => ({
    room_key: "synthetic-room", room_name: "Synthetic room", active_power_w: 800,
    start_ts: new Date(row.start_ms).toISOString(), room_temperature_c: row.room_c,
    outdoor_temperature_c: row.outdoor_c, house_temperature_c: row.house_c,
    solar_w_per_m2: row.solar_w_per_m2, heat_w: row.heat_w, cooling: row.cooling,
  }));
  const fitted = fitRoomsFromQuarters(rows)[0].result;
  assert(fitted.ok);
  assertAlmostEquals(fitted.model.gain_c_per_wh, .002, .00002);
  const unidentified = fitRoomsFromQuarters(rows.map(row => ({ ...row, heat_w: null })));
  assertEquals(unidentified[0].result.ok, false);
  const stored = zoneModelRows(unidentified, { customerId: "synthetic", homeId: "synthetic", trainingFrom: rows[0].start_ts, trainingTo: rows.at(-1)!.start_ts });
  assertEquals((stored[0].last_fit_attempt as { learning: { method: string } }).learning.method,
    "interval_mean_transition_holdout_v1");
});
