import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { syntheticRoomPlant } from "./native-mean.fixture.ts";
import { assessRoomHeatingRuns, describeHeatingRun, roomHeatingRuns, RUN_COOLDOWN_WINDOW_H } from "./run-calibration.ts";
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

const assess = (rows: ReturnType<typeof plant>) => assessRoomHeatingRuns(rows, model, .01, model.background_gain_c_per_h);

Deno.test("a single completed run has its own gain assessment and a capture-edge fragment has none", () => {
  const rows = plant(1);
  const assessment = assess(rows);
  assertEquals(assessment.observed_runs, 1);
  assertEquals(assessment.runs[0].disposition, "assessed");
  assertAlmostEquals(assessment.runs[0].gain!, .002, 1e-7);
  assertEquals(assess(rows.slice(3, 13)).runs, []);
});

Deno.test("the ledger describes each observed run throughout the chronological history", () => {
  const rows = plant(30), events = roomHeatingRuns(rows), original = structuredClone(rows);
  const ledger = assess(rows);
  assertEquals(ledger.observed_runs, 30);
  assertEquals(ledger.runs.map(run => run.id), events.map(run => run.id));
  for (const run of ledger.runs) {
    assertEquals(run.disposition, "assessed");
    assertAlmostEquals(run.gain!, .002, 1e-7);
  }
  assertEquals(rows, original);
});

Deno.test("native hourly runs keep their measured energy across weather changes", () => {
  const rows = plant(4, [3600]), all = roomHeatingRuns(rows);
  assertEquals(all.length, 4);
  const changingWeather = rows.map((row, i) => ({ ...row, outdoor_c: i % 2 ? 6 : -12 }));
  assertEquals(roomHeatingRuns(changingWeather), all);
  const ledger = assess(changingWeather);
  assertEquals(ledger.runs.map(run => run.measured_wh), Array(4).fill(13 * 500));
});

Deno.test("missing input is unknown and cannot manufacture an independent event", () => {
  const rows = plant(3);
  rows[7].heat_w = null;
  const runs = roomHeatingRuns(rows);
  assertEquals(runs.length, 2);
  assertEquals(assess(rows).runs.map(run => run.id), runs.map(run => run.id));
});

Deno.test("a change in unmeasured heat is reported within the affected run while every completed event remains in the ledger", () => {
  const rows = plant(8);
  let warmth = 0;
  for (let i = 0; i < rows.length; i++) {
    const input = i >= 6 * 32 + 7 && i < 6 * 32 + 20 ? 1.4 : 0;
    const hours = rows[i].duration_s! / 3600, decay = Math.exp(-.075 * hours);
    rows[i].room_c! += warmth * (1 - decay) / (.075 * hours) + input / .075 * (1 - (1 - decay) / (.075 * hours));
    warmth = warmth * decay + input / .075 * (1 - decay);
  }
  const result = assess(rows);
  assertEquals(result.observed_runs, 8);
  const affected = result.runs[6];
  assertEquals(affected.disposition, "suspect_change");
  assert(affected.change_at_ms !== null && affected.change_at_ms >= affected.from_ms && affected.change_at_ms < affected.to_ms);
  assert(affected.cooldown && affected.cooldown.hours >= 1);
  assertEquals(result.runs.filter(run => run.disposition === "assessed").length, 7);
});

Deno.test("a change in physical gain remains visible in the individual run assessments", () => {
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
  const result = assess(rows);
  assertEquals(result.observed_runs, 10);
  for (const [index, run] of result.runs.entries()) {
    assertAlmostEquals(run.gain!, index < 7 ? .002 : .003, 1e-7);
    assertEquals(run.disposition, "assessed");
  }
});

Deno.test("temperature and weather gaps skip transitions without splitting the measured heating event", () => {
  const rows = plant(3);
  rows[7].room_c = null;
  rows[39].outdoor_c = null;
  rows[73].house_c = null;
  assertEquals(roomHeatingRuns(rows).length, 3);
  const partial = assess(rows), complete = assess(plant(3));
  for (const [index, run] of partial.runs.entries()) {
    assertEquals(run.id, complete.runs[index].id);
    assertEquals(run.transitions, complete.runs[index].transitions - 2);
  }
});

Deno.test("each run records its observed outdoor temperature and cooldown", () => {
  const rows = plant(4);
  const runs = roomHeatingRuns(rows);
  const ledger = assess(rows);
  for (const [index, run] of ledger.runs.entries()) {
    const window = rows.slice(runs[index].from, runs[index].end + 1);
    const outdoor = window.reduce((sum, row) => sum + row.outdoor_c!, 0) / window.length;
    assertAlmostEquals(run.outdoor_c!, outdoor, 1e-9);
    assert(run.room_peak_c! > run.room_start_c!);
    // House at ~20 °C, room heated above it and outdoor near −7 °C: it cools.
    assert(run.cooldown && run.cooldown.c_per_h > 0 && run.cooldown.hours >= 1);
    assert(run.cooldown.hours <= RUN_COOLDOWN_WINDOW_H);
    assertEquals(run.on_from_ms, runs[index].on_from_ms);
  }
});

Deno.test("missing readings shorten a run description and never fill it", () => {
  const rows = plant(3);
  const [run] = roomHeatingRuns(rows);
  const complete = describeHeatingRun(rows, run, .5);
  // A hole in the middle of the cooldown leaves an estimate from what was seen.
  const holed = structuredClone(rows);
  holed[run.off + 4].room_c = null;
  holed[run.off + 5].outdoor_c = null;
  const middle = describeHeatingRun(holed, run, .5);
  assert(middle.cooldown && Math.abs(middle.cooldown.c_per_h - complete.cooldown!.c_per_h) < .05);
  // An unavailable outdoor sensor leaves the run unplaced, not at zero.
  const dark = structuredClone(rows);
  for (let i = run.from; i <= run.end; i++) dark[i].outdoor_c = null;
  const unplaced = describeHeatingRun(dark, run, .5);
  assertEquals(unplaced.outdoor_c, null);
  assertEquals(unplaced.cooldown, null);
  // The newest quarters are late: a cooldown shorter than an hour is not reported.
  const late = describeHeatingRun(rows, { ...run, end: run.off + 2 }, 0);
  assertEquals(late.cooldown, null);
  assert(late.room_end_c !== null);
});
