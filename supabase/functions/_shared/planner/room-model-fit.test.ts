import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fitRoom, predictionError, type RoomTrainingQuarter } from "./room-model-fit.ts";
import { type RoomState, roomTransition, stepRoom, type ThermalZoneModel } from "./thermal-model.ts";

/** A floor-heated room in a house that cools overnight, simulated from a known model. */
const TRUTH: ThermalZoneModel = {
  gain_c_per_wh: 0.001, cooling_constant_per_h: 0, background_gain_c_per_h: -0.3, house_coupling_per_h: 0.15,
  heat_lag_h: 2, thermal_capacity_wh_per_c: 1000, heat_loss_w_per_c: 150, time_constant_h: 1 / 0.15,
  heating_rate_c_per_h: 0.7, r2: 1, sample_count: 0, residual_std_c: 0,
};
const DAYS = 14, START = Date.UTC(2026, 9, 1);

function room(model = TRUTH, noise = 0.01): RoomTrainingQuarter[] {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const rows: RoomTrainingQuarter[] = [];
  let state: RoomState = { temperature_c: 20, delivered_w: 0 };
  for (let k = 0; k < DAYS * 96; k++) {
    const hour = (k % 96) / 4;
    const house = hour >= 22 || hour < 5 ? 21.4 : 22.6;
    const outdoor = 8 + 4 * Math.sin((k % 96) / 96 * 2 * Math.PI) + random();
    // Morning and evening runs, each a different length every day.
    const heat_w = (hour >= 4 && hour < 6 + (k / 96 % 3)) || (hour >= 17 && hour < 18.5 + (k / 96 % 2)) ? 700 : 0;
    rows.push({ start_ms: START + k * 900_000, room_c: state.temperature_c + noise * random(), outdoor_c: outdoor,
      house_c: house, solar_w_per_m2: null, heat_w, cooling: false });
    state = stepRoom(roomTransition(model, { hours: 0.25, outdoor_c: outdoor, house_c: house,
      background_c_per_h: model.background_gain_c_per_h }), state, heat_w);
  }
  return rows;
}

Deno.test("the fit recovers a floor's delay and the house it loses heat into", () => {
  const fit = fitRoom(room(), 700);
  assert(fit.ok);
  assertEquals(fit.model.heat_lag_h, 2);
  assertEquals(fit.model.cooling_constant_per_h, 0);
  assertAlmostEquals(fit.model.house_coupling_per_h!, 0.15, 0.02);
  assertAlmostEquals(fit.model.gain_c_per_wh, 0.001, 0.0002);
  assert(fit.model.prediction_error_c! < 0.05, `12 h error ${fit.model.prediction_error_c}`);
  assertEquals(fit.warnings, undefined);
});

Deno.test("without a house temperature the room keeps the outdoor shape", () => {
  const fit = fitRoom(room().map(row => ({ ...row, house_c: null })), 700);
  if (!fit.ok) return; // The outdoor shape may refuse a room it cannot explain; it must never claim the house.
  assertEquals(fit.model.house_coupling_per_h ?? null, null);
  assert(Number.isFinite(fit.model.prediction_error_c));
});

Deno.test("a house reading for a slice of the window does not change the shape", () => {
  const rows = room().map((row, k) => k < 300 ? row : { ...row, house_c: null });
  const fit = fitRoom(rows, 700);
  if (fit.ok) assertEquals(fit.model.house_coupling_per_h ?? null, null);
});

Deno.test("the 12-hour error is measured from measured starts with measured heat", () => {
  const rows = room(TRUTH, 0);
  assertAlmostEquals(predictionError(TRUTH, rows)!, 0, 1e-9);
  assert(predictionError({ ...TRUTH, heat_lag_h: 0 }, rows)! > 0.05, "ignoring the delay is visibly wrong");
});
