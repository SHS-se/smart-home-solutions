import { assert, assertEquals } from "@std/assert";
import { advanceRoomHeatingBands } from "./heating-bands.ts";
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { roomHeatingBandAt, type RoomHeatingBands } from "../../planner/heating-bands.ts";
import type { ThermalZoneModel } from "../../planner/models/room/thermal.ts";

const quarter = 900_000, start = Date.UTC(2026, 0, 1);
const reference: ThermalZoneModel = {
  gain_c_per_wh: .001, cooling_constant_per_h: .01, house_coupling_per_h: .1, background_gain_c_per_h: 0,
  heat_lag_h: 0, heating_rate_c_per_h: .5, thermal_capacity_wh_per_c: 1000, heat_loss_w_per_c: 110,
  time_constant_h: 1 / .11, sample_count: 1000, r2: .99, residual_std_c: .1,
};

/** Synthetic independently integrated room, with different warm-weather response. */
function observations(): RoomMeanQuarter[] {
  let room = 21;
  return Array.from({ length: 96 * 8 }, (_, index) => {
    const outdoor = 2 + Math.sin(index / 16), house = 21 + Math.sin(index / 42);
    const heat = index % 24 < 9 ? 500 : 0;
    let sum = 0;
    for (let minute = 0; minute < 15; minute++) {
      const rate = .003 * heat - .03 * (room - outdoor) - .1 * (room - house) + .21;
      sum += room + rate / 120;
      room += rate / 60;
    }
    return { start_ms: start + index * quarter, room_c: sum / 15, outdoor_c: outdoor, house_c: house,
      solar_w_per_m2: null, heat_w: heat, cooling: false };
  });
}

Deno.test("the exact thermal candidate wins on later measured heating and cooldown without replacing an old cold band", () => {
  const rows = observations();
  const cold = { revision: "cold-fit", band_c: -10, observed_min_c: -9, observed_max_c: -6,
    training_from: "2025-01-01", training_to: "2025-01-08", model: reference };
  const current: RoomHeatingBands = { reference_revision: "general", binding: "synthetic-room",
    since: "2025-01-01", active: [cold], candidates: [], attempted: {} };
  const staged = advanceRoomHeatingBands(current, rows.slice(0, 96 * 4), reference, 500);
  assertEquals(staged.active, [cold]);
  assert(staged.candidates[0].model.gain_c_per_wh > .0029);
  const insufficient = rows.map((row, index) => index >= 96 * 4 ? { ...row, heat_w: null } : row);
  assertEquals(advanceRoomHeatingBands(staged, insufficient, reference, 500).active, [cold]);
  // A late newest quarter and a gap cannot poison the fit or erase existing bands.
  const incomplete = rows.slice(0, -1).map((row, index) => index === 450 ? { ...row, heat_w: null } : row);
  const promoted = advanceRoomHeatingBands(staged, incomplete, reference, 500);
  assertEquals(promoted.active, [cold, staged.candidates[0]]);
  assertEquals(roomHeatingBandAt(promoted.active, -7)?.revision, cold.revision);
  assertEquals(roomHeatingBandAt(promoted.active, 2)?.revision, staged.candidates[0].revision);
  assertEquals(roomHeatingBandAt(promoted.active, 4), undefined);
});
