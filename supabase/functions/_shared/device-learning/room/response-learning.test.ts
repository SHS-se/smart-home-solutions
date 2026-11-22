import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { syntheticRoomPlant } from "./native-mean.fixture.ts";
import { learnRoomResponse, prepareRoomResponse, advanceRoomResponseCell, ROOM_RESPONSE_CELL_COUNT } from "./response-learning.ts";
import type { RoomBandFitCell, RoomHeatFitState } from "./mean-observations.ts";

function plant(events = 8) {
  return syntheticRoomPlant([900], events * 32, .5, .0001, {
    gain: .002, houseGain: .04, outdoorGain: .035, background: .02, roomStart: 19,
    startMs: Date.UTC(2025, 0, 1), steps: 600,
    forcing: i => ({ outdoor: -7 + .4 * Math.sin(i / 17), house: 20 + .4 * Math.cos(i / 30),
      watts: i % 32 >= 2 && i % 32 < 15 ? 500 : 0,
      solar: Math.max(0, 200 * Math.sin(i / 96 * 2 * Math.PI)) }),
  }).rows;
}

Deno.test("the publication owner requires three runs and publishes no uncontrolled background", () => {
  const short = learnRoomResponse(plant(2), () => true, 500);
  assert(!short.result.ok);
  assertEquals(short.result.reason, "insufficient_heating_runs");
  const fitted = learnRoomResponse(plant(3), () => true, 500);
  assert(fitted.result.ok && fitted.result.model.response_family === "finite");
  assertEquals(fitted.run_ledger?.fitted_runs, 3);
  assertAlmostEquals(fitted.result.model.gain_c_per_wh, .002, .00001);
  assertEquals(fitted.result.model.background_gain_c_per_h, 0);
  assertAlmostEquals(fitted.result.learning_evidence!.forecast_nuisance!.fitted_offset, .02, .001);
  assert(!fitted.result.warnings?.includes("insufficient_heating"));
});

Deno.test("actual learning excludes overlapping unknown heat and its tail before publishing", () => {
  const rows = plant();
  let warmth = 0;
  for (let i = 0; i < rows.length; i++) {
    const input = i >= 6 * 32 + 7 && i < 6 * 32 + 20 ? 1.4 : 0;
    const decay = Math.exp(-.075 * .25), share = (1 - decay) / (.075 * .25);
    rows[i].room_c! += warmth * share + input / .075 * (1 - share);
    warmth = warmth * decay + input / .075 * (1 - decay);
  }
  const original = structuredClone(rows), result = learnRoomResponse(rows, () => true, 500);
  assert(result.result.ok && result.result.model.response_family === "finite");
  assertEquals(result.run_ledger?.fitted_runs, 7);
  assertEquals(result.run_ledger?.suspect_runs, 1);
  assertAlmostEquals(result.result.model.gain_c_per_wh, .002, .0001);
  assertEquals(rows, original);
});

Deno.test("future held-out temperatures cannot change the training screening cells", () => {
  const rows = plant(), changed = structuredClone(rows);
  changed.slice(Math.floor(rows.length * 2 / 3)).forEach((row, i) => { row.room_c! += 2 * Math.sin(i / 4); });
  const a = prepareRoomResponse(rows, () => true, 500), b = prepareRoomResponse(changed, () => true, 500);
  const firstCell = (prepared: typeof a) => {
    let state: RoomHeatFitState | null = null;
    for (;;) {
      const step = advanceRoomResponseCell(prepared, [], state);
      if (step.cell) return step.cell;
      state = step.state;
    }
  };
  assertEquals(firstCell(a), firstCell(b));
});

Deno.test("a recent physical heat-loss improvement is learned without averaging the old plant into it", () => {
  const epoch = 7 * 32;
  const rows = syntheticRoomPlant([900], 10 * 32, .5, .0001, {
    gain: .002, houseGain: .04, outdoorGain: .035, background: .02, roomStart: 19,
    startMs: Date.UTC(2025, 0, 1), steps: 600,
    dynamics: i => ({ gain: .002, houseGain: .04, outdoorGain: i >= epoch ? .02 : .035, background: .02 }),
    forcing: i => ({ outdoor: -7 + .4 * Math.sin(i / 17), house: 20 + .4 * Math.cos(i / 30),
      watts: i % 32 >= 2 && i % 32 < 15 ? 500 : 0,
      solar: Math.max(0, 200 * Math.sin(i / 96 * 2 * Math.PI)) }),
  }).rows;
  const fit = learnRoomResponse(rows, () => true, 500);
  assert(fit.result.ok && fit.result.model.response_family === "finite");
  assertEquals(fit.run_ledger!.fitted_runs, 3);
  assertAlmostEquals(fit.result.model.cooling_constant_per_h, .02, .001);
  assertAlmostEquals(fit.result.model.gain_c_per_wh, .002, .0001);
  assert(Date.parse(fit.run_ledger!.oldest_run_at!) >= rows[epoch].start_ms);
});

Deno.test("resumable calibration returns the same result through serialized bounded cells", () => {
  const rows = plant(3), prepared = prepareRoomResponse(rows, () => true, 500);
  const cells: RoomBandFitCell[] = [];
  while (cells.length < ROOM_RESPONSE_CELL_COUNT) {
    let state: RoomHeatFitState | null = null;
    for (;;) {
      const result = advanceRoomResponseCell(prepared, cells, state);
      if (result.cell) { cells.push(JSON.parse(JSON.stringify(result.cell))); break; }
      state = JSON.parse(JSON.stringify(result.state));
    }
  }
  assertEquals(cells.length, 36);
});

Deno.test("partial solar coverage keeps one observation design across both calibration stages", () => {
  const rows = plant(6);
  rows.slice(0, 32).forEach(row => { row.solar_w_per_m2 = null; });
  rows[71].room_c = null;
  const fit = learnRoomResponse(rows, () => true, 500);
  assert(fit.result.ok, JSON.stringify(fit));
  assert(fit.run_ledger!.fitted_runs >= 3);
});

Deno.test("a declining room response also replaces the old plant after three coherent recent events", () => {
  const epoch = 7 * 32;
  const rows = syntheticRoomPlant([900], 10 * 32, .5, .0001, {
    gain: .002, houseGain: .04, outdoorGain: .02, background: -.02, roomStart: 19,
    startMs: Date.UTC(2025, 0, 1), steps: 600,
    dynamics: i => ({ gain: .002, houseGain: .04, outdoorGain: i >= epoch ? .035 : .02, background: -.02 }),
    forcing: i => ({ outdoor: -7 + .4 * Math.sin(i / 17), house: 20 + .4 * Math.cos(i / 30),
      watts: i % 32 >= 2 && i % 32 < 15 ? 500 : 0,
      solar: Math.max(0, 200 * Math.sin(i / 96 * 2 * Math.PI)) }),
  }).rows;
  const fit = learnRoomResponse(rows, () => true, 500);
  assert(fit.result.ok && fit.result.model.response_family === "finite", JSON.stringify(fit));
  assertEquals(fit.run_ledger!.fitted_runs, 3);
  assertAlmostEquals(fit.result.model.cooling_constant_per_h, .035, .001);
  assertAlmostEquals(fit.result.model.background_gain_c_per_h, -.02, .001);
});
