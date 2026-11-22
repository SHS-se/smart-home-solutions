import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { syntheticRoomPlant } from "./native-mean.fixture.ts";
import { calibrateRoomRuns, recentRoomRunRows, roomHeatingRuns } from "./run-calibration.ts";
import type { DynamicThermalZoneModel } from "../../planner/models/room/thermal.ts";

const model: DynamicThermalZoneModel = { response_family: "finite", gain_c_per_wh: .002,
  cooling_constant_per_h: .035, house_coupling_per_h: .04, background_gain_c_per_h: .02,
  solar_gain_c_per_h_per_wm2: .0001, heat_lag_h: .5, thermal_capacity_wh_per_c: 500,
  heat_loss_w_per_c: 37.5, time_constant_h: 1 / .075, heating_rate_c_per_h: 1,
  sample_count: 1, r2: 1, residual_std_c: 0 };

/** Independent RK4 observations, not output from the production mean kernel. */
function plant(events = 16, durations: (900 | 3600)[] = [900]) {
  return syntheticRoomPlant(durations, events * 32, .5, .0001, {
    gain: .002, houseGain: .04, outdoorGain: .035, background: .02, roomStart: 19,
    startMs: Date.UTC(2025, 0, 1), steps: 600,
    forcing: i => ({ outdoor: -7 + .4 * Math.sin(i / 17), house: 20 + .4 * Math.cos(i / 30),
      watts: i % 32 >= 2 && i % 32 < 15 ? 500 : 0,
      solar: Math.max(0, 200 * Math.sin(i / 96 * 2 * Math.PI)) }),
  }).rows;
}

Deno.test("run calibration requires three events, not three quarters or fragments", () => {
  const rows = plant(3), original = structuredClone(rows);
  assertEquals(roomHeatingRuns(rows.slice(0, 32), () => true).length, 1);
  assertEquals(calibrateRoomRuns(rows.slice(0, 64), model, () => true).evidence.fitted_runs, 0);
  const fitted = calibrateRoomRuns(rows, model, () => true);
  assertEquals(fitted.evidence.fitted_runs, 3);
  for (const run of fitted.evidence.runs) assertAlmostEquals(run.gain!, .002, 1e-7);
  assertEquals(rows, original);
  assertEquals(roomHeatingRuns(rows.slice(3, 13), () => true), []);
});

Deno.test("run working evidence rolls to the newest ten while preserving raw history", () => {
  const rows = plant(), oldRuns = roomHeatingRuns(rows, () => true), original = structuredClone(rows);
  const fit = calibrateRoomRuns(rows, model, () => true);
  assertEquals(fit.evidence.observed_runs, 16);
  assertEquals(fit.evidence.retained_runs, 10);
  assertEquals(fit.evidence.fitted_runs, 10);
  assertEquals(fit.evidence.runs[0].id, oldRuns[6].id);
  assert(recentRoomRunRows(rows, () => true).length < rows.length);
  assertEquals(rows, original);
});

Deno.test("native hourly runs retain their actual energy and cannot split at weather boundaries", () => {
  const rows = plant(4, [3600]);
  const all = roomHeatingRuns(rows, () => true), band = roomHeatingRuns(rows, c => c < -7);
  assertEquals(all.length, 4);
  for (const run of all) assertEquals(run.measured_wh, 13 * 500);
  assert(band.length <= all.length);
  assert(band.every(run => all.some(other => other.id === run.id)));
  const result = calibrateRoomRuns(rows, model, () => true);
  assertEquals(result.evidence.fitted_runs, 4);
});

Deno.test("missing input is unknown and cannot manufacture an independent event", () => {
  const rows = plant(3);
  rows[7].heat_w = null;
  const runs = roomHeatingRuns(rows, () => true);
  assertEquals(runs.length, 2);
  assertEquals(calibrateRoomRuns(rows, model, () => true).evidence.fitted_runs, 0);
});

Deno.test("unknown overlapping heat changes inside a run exclude that run and its cooldown", () => {
  const rows = plant(8);
  let warmth = 0;
  for (let i = 0; i < rows.length; i++) {
    const input = i >= 6 * 32 + 7 && i < 6 * 32 + 20 ? 1.4 : 0;
    const hours = rows[i].duration_s! / 3600, decay = Math.exp(-.075 * hours);
    rows[i].room_c! += warmth * (1 - decay) / (.075 * hours) + input / .075 * (1 - (1 - decay) / (.075 * hours));
    warmth = warmth * decay + input / .075 * (1 - decay);
  }
  const result = calibrateRoomRuns(rows, model, () => true);
  const suspect = result.evidence.runs.find(run => run.disposition === "suspect_change");
  assert(suspect);
  assertEquals(result.evidence.fitted_runs, 7);
  // A shared boundary mean can be context for the neighboring event. No
  // scored contiguous transition may lie in the excluded run/tail.
  assert(result.rows.every((row, i) => {
    const next = result.rows[i + 1];
    return !next || next.start_ms !== row.start_ms + row.duration_s! * 1000 ||
      row.start_ms < suspect.from_ms || next.start_ms >= suspect.to_ms;
  }));
});

Deno.test("three recent coherent changed responses replace the old regime rather than being rejected", () => {
  const rows = plant(10);
  let additional = 0, delivered = 0;
  for (let i = 0; i < rows.length; i++) {
    const input = i >= 7 * 32 ? .001 * rows[i].heat_w! : 0;
    // Independent two-state RK4 integration of extra gain with heater lag.
    // The declared additional source begins at the epoch; integrate its own
    // delayed input independently, including means, without production kernels.
    if (i >= 7 * 32) {
      let sum = 0;
      for (let step = 0; step < 600; step++) {
        const dt = .25 / 600;
        const rate = (t: number, d: number) => [d - .075 * t, (input - d) / .5];
        const a = rate(additional, delivered), b = rate(additional + a[0] * dt / 2, delivered + a[1] * dt / 2);
        const c = rate(additional + b[0] * dt / 2, delivered + b[1] * dt / 2), d = rate(additional + c[0] * dt, delivered + c[1] * dt);
        const next = additional + dt * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
        sum += (additional + next) / 2;
        additional = next; delivered += dt * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
      }
      rows[i].room_c! += sum / 600;
    }
  }
  const result = calibrateRoomRuns(rows, model, () => true);
  assertEquals(result.evidence.fitted_runs, 3);
  for (const run of result.evidence.runs.filter(run => run.disposition === "fitted")) assertAlmostEquals(run.gain!, .003, 1e-7);
  assertEquals(result.evidence.runs.filter(run => run.disposition === "older_response").length, 7);
});

Deno.test("temperature and weather gaps skip transitions without splitting the measured heating event", () => {
  const rows = plant(3);
  rows[7].room_c = null;
  rows[39].outdoor_c = null;
  rows[73].house_c = null;
  assertEquals(roomHeatingRuns(rows, () => true).length, 3);
  assertEquals(calibrateRoomRuns(rows, model, () => true).evidence.fitted_runs, 3);
});
