import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fitRoomMeans, ROOM_EXCHANGE_FAMILY, type RoomMeanQuarter } from "./mean-observations.ts";

/** Independently generated synthetic plant, integrated in one-second steps. */
function observations(options: { house?: number; outdoor?: number; lag?: number; solar?: number; missing?: boolean; linkedSun?: boolean } = {}): RoomMeanQuarter[] {
  const kh = options.house ?? .14, ko = options.outdoor ?? .06, lag = options.lag ?? 2, sunGain = options.solar ?? .0003;
  let temperature = 20, delivered = 0, seed = 13;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  return Array.from({ length: 12 * 96 }, (_, q) => {
    const house = 21 + Math.sin(q / 81) + .3 * Math.cos(q / 137);
    const outdoor = 7 + 4 * Math.sin(q / 127) + 2 * Math.cos(q / 61);
    const sun = options.linkedSun ? 300 + 10 * (outdoor - house)
      : Math.max(0, 350 * Math.sin((q % 96 - 24) / 96 * 2 * Math.PI));
    const watts = random() > .65 ? 800 : 0;
    let integral = 0;
    for (let second = 0; second < 900; second++) {
      const rate = .002 * (lag ? delivered : watts) + kh * (house - temperature) + ko * (outdoor - temperature) + .04 + sunGain * sun;
      integral += temperature + rate / 7200;
      temperature += rate / 3600;
      if (lag) delivered += (watts - delivered) / lag / 3600;
    }
    return { start_ms: q * 900_000, room_c: integral / 900, house_c: house, outdoor_c: outdoor,
      solar_w_per_m2: sun, heat_w: options.missing && q >= 600 && q < 650 ? null : watts, cooling: false };
  });
}

for (const lag of [0, 2]) Deno.test(`joint room means recover internal, external and solar exchange with ${lag} h delay`, () => {
  const result = fitRoomMeans(observations({ lag }), 800);
  assert(result.ok);
  assertEquals(result.model.heat_lag_h, lag);
  assertAlmostEquals(result.model.gain_c_per_wh, .002, .00003);
  assertAlmostEquals(result.model.house_coupling_per_h!, .14, .002);
  assertAlmostEquals(result.model.cooling_constant_per_h, .06, .002);
  assertAlmostEquals(result.model.solar_gain_c_per_h_per_wm2!, .0003, .00001);
  assertAlmostEquals(result.model.background_gain_c_per_h, .04, .005);
  assertEquals(result.learning_evidence!.family, ROOM_EXCHANGE_FAMILY);
  assertEquals(result.learning_evidence!.selected_boundary, "house_outdoor");
  assert(result.learning_evidence!.validation_mse_c2! < 1e-6);
});

Deno.test("joint exchange retains heat-memory segments across unknown meter observations", () => {
  const result = fitRoomMeans(observations({ missing: true }), 800);
  assert(result.ok);
  assertEquals(result.model.heat_lag_h, 2);
  assertAlmostEquals(result.model.house_coupling_per_h!, .14, .003);
  assertAlmostEquals(result.model.cooling_constant_per_h, .06, .003);
  assertAlmostEquals(result.model.gain_c_per_wh, .002, .00003);
  assertEquals(result.model.sample_count, 12 * 96 - 1 - 51);
});

Deno.test("zero exchange and zero solar gain are learned physical limits without negative coefficients", () => {
  for (const options of [{ house: 0, solar: 0 }, { outdoor: 0, solar: 0 }]) {
    const result = fitRoomMeans(observations(options), 800);
    assert(result.ok);
    assertAlmostEquals(result.model.house_coupling_per_h!, options.house ?? .14, .002);
    assertAlmostEquals(result.model.cooling_constant_per_h, options.outdoor ?? .06, .002);
    assert(result.model.house_coupling_per_h! >= 0);
    assert(result.model.cooling_constant_per_h >= 0);
    assert(result.model.solar_gain_c_per_h_per_wm2! >= 0);
    assertAlmostEquals(result.model.solar_gain_c_per_h_per_wm2!, 0, .00001);
  }
});

Deno.test("missing boundaries and a confounded exchange split do not manufacture a single-boundary fit", () => {
  const rows = observations();
  for (const input of [rows.map(r => ({ ...r, house_c: null })), rows.map(r => ({ ...r, outdoor_c: null })),
    rows.map(r => ({ ...r, outdoor_c: r.house_c! - 10 }))]) {
    const result = fitRoomMeans(input, 800);
    assertEquals(result.ok, false);
    assertEquals(result.learning_evidence!.family, ROOM_EXCHANGE_FAMILY);
  }
});

Deno.test("solar confounding cannot manufacture an identified outdoor/solar split", () => {
  const result = fitRoomMeans(observations({ linkedSun: true }), 800);
  assertEquals(result.ok, false);
});

Deno.test("constant irradiance leaves solar unidentified while joint thermal learning continues", () => {
  const result = fitRoomMeans(observations({ solar: 0 }).map(row => ({ ...row, solar_w_per_m2: 0 })), 800);
  assert(result.ok);
  assertAlmostEquals(result.model.house_coupling_per_h!, .14, .002);
  assertAlmostEquals(result.model.cooling_constant_per_h, .06, .002);
  assertEquals(result.model.solar_gain_c_per_h_per_wm2, null);
});
