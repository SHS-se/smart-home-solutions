import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fitDoorwayShadow, projectDoorwayShadow, type DoorwayObservation } from "./doorway-shadow.ts";
import { validateDoorwayShadow } from "../../../../../scripts/validate-doorway-shadow.ts";
import type { ThermalZoneModel } from "../../planner/models/room/thermal.ts";

const baseline: ThermalZoneModel = {
  gain_c_per_wh: .0015, cooling_constant_per_h: .09, house_coupling_per_h: .2,
  background_gain_c_per_h: .12, heat_lag_h: 1.5,
  solar_gain_c_per_h_per_wm2: .0002, thermal_capacity_wh_per_c: 1 / .0015,
  heat_loss_w_per_c: .29 / .0015, time_constant_h: 1 / .29,
  heating_rate_c_per_h: 1.2, r2: 0, sample_count: 0, residual_std_c: 0,
};

/** Synthetic room solved independently with one-second physical integration. */
function syntheticRoom(exchange: number, constantContrast = false): DoorwayObservation[] {
  let room = 19, delivered = 190;
  return Array.from({ length: 320 }, (_, q) => {
    const rest = 20 + Math.sin(q / 40);
    const neighbour = rest + (constantContrast ? 2 : 3 * Math.sin(q / 13));
    const outdoor = 5 + 3 * Math.cos(q / 32);
    const heat = q % 23 < 10 ? 800 : 0;
    const sun = Math.max(0, 250 * Math.sin(q / 15));
    let mean = 0;
    for (let second = 0; second < 900; second++) {
      const rate = .0015 * delivered + .09 * (outdoor - room) +
        (.2 - exchange) * (rest - room) + exchange * (neighbour - room) + .24 + .0002 * sun;
      mean += room + rate / 7200;
      room += rate / 3600;
      delivered += (heat - delivered) / 1.5 / 3600;
    }
    return { start_ms: q * 900_000, room_c: mean / 900, heat_w: heat, cooling: false, house_c: 20,
      rest_of_house_c: rest, neighbour_c: neighbour, outdoor_c: outdoor, solar_w_per_m2: sun };
  });
}

Deno.test("shadow splits the indoor exchange and preserves delayed heating across an unknown meter segment", () => {
  const input = syntheticRoom(.14);
  for (let i = 80; i < 90; i++) input[i].heat_w = null;
  input[130].neighbour_c = null;
  input.pop();
  const original = structuredClone(input);
  const result = fitDoorwayShadow(input, baseline);
  assert(result.status === "fitted");
  assertEquals(result.pairs, 305);
  assertAlmostEquals(result.neighbour_per_h, .14, .001);
  assertAlmostEquals(result.rest_of_house_per_h, .06, .001);
  assertAlmostEquals(result.background_c_per_h, .24, .001);
  assertEquals(input, original);
});

Deno.test("no doorway exchange estimates as zero with usable contrasting observations", () => {
  const result = fitDoorwayShadow(syntheticRoom(0), baseline);
  assert(result.status === "fitted");
  assertAlmostEquals(result.neighbour_per_h, 0, .001);
});

Deno.test("constant contrast and absent probes are different from learned zero exchange", () => {
  const rows = syntheticRoom(.14, true);
  assertEquals(fitDoorwayShadow(rows, baseline),
    { status: "unidentified", pairs: 319, reason: "no_independent_contrast" });
  assertEquals(fitDoorwayShadow(rows.map(row => ({ ...row, neighbour_c: null })), baseline),
    { status: "unidentified", pairs: 0, reason: "no_paired_observations" });
});


Deno.test("only pre-origin observations inform the paired forecast comparison", () => {
  const rows = syntheticRoom(.14);
  const cutoff = 252;
  const start = rows[cutoff].start_ms;
  const forecast = rows.slice(cutoff, cutoff + 24).map(row => ({
    start_ms: row.start_ms, outdoor_c: row.outdoor_c!, house_c: row.house_c!,
    rest_of_house_c: row.rest_of_house_c!, neighbour_c: row.neighbour_c!,
    solar_w_per_m2: row.solar_w_per_m2!, heat_w: row.heat_w!,
  }));
  const origin = { start_ms: start, forecast, training: rows, initial_temperature_c: rows[cutoff - 1].room_c!, initial_delivered_w: 375 };
  const before = validateDoorwayShadow({ outcomes: rows, origins: [origin] });
  assertEquals(before.fitted_origins, 1);
  assertEquals(before.scores.map(s => s.compared_origins), [1, 1, 0, 0]);
  const changed = rows.map(r => r.start_ms < start ? r : { ...r, neighbour_c: 140, house_c: 180, heat_w: 99_000 });
  assertEquals(validateDoorwayShadow({ outcomes: changed, origins: [{ ...origin, training: changed }] }), before);
  changed[cutoff + 3].room_c = null;
  assertEquals(validateDoorwayShadow({ outcomes: changed, origins: [{ ...origin, training: changed }] }).scores[0].compared_origins, 0);
});

Deno.test("zero neighbour exchange leaves the same forecast with identical rest and house forcing", () => {
  const fit = { status: "fitted" as const, pairs: 50, neighbour_per_h: 0, rest_of_house_per_h: .2, background_c_per_h: .12 };
  const origin = { start_ms: 0, initial_temperature_c: 19, initial_delivered_w: 200, forecast: [{
    start_ms: 0, outdoor_c: 0, house_c: 20, rest_of_house_c: 20, neighbour_c: 0,
    solar_w_per_m2: 200, heat_w: 500,
  }] };
  const [estimate] = projectDoorwayShadow(origin, baseline, fit);
  assertAlmostEquals(estimate.doorway_c, estimate.baseline_c);
});
