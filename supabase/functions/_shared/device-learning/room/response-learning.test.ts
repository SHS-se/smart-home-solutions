import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { syntheticRoomPlant } from "./native-mean.fixture.ts";
import {
  learnRoomResponse, prepareRoomResponse, advanceRoomResponseCell, advanceRoomResponseCells, finalizeRoomResponse,
  ROOM_RESPONSE_CELL_COUNT,
} from "./response-learning.ts";
import {
  parseRoomBandFitCells, parseRoomHeatFitState, ROOM_BAND_FIT_CELL_COUNT, type RoomBandFitCell, type RoomHeatFitState,
} from "./mean-observations.ts";

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
  const short = learnRoomResponse(plant(2), 500);
  assert(!short.result.ok);
  assertEquals(short.result.reason, "insufficient_heating_runs");
  const fitted = learnRoomResponse(plant(3), 500);
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
  const original = structuredClone(rows), result = learnRoomResponse(rows, 500);
  assert(result.result.ok && result.result.model.response_family === "finite");
  assertEquals(result.run_ledger?.fitted_runs, 7);
  assertEquals(result.run_ledger?.suspect_runs, 1);
  assertAlmostEquals(result.result.model.gain_c_per_wh, .002, .0001);
  assertEquals(rows, original);
});

Deno.test("future held-out temperatures cannot change the training screening cells", () => {
  const rows = plant(), changed = structuredClone(rows);
  changed.slice(Math.floor(rows.length * 2 / 3)).forEach((row, i) => { row.room_c! += 2 * Math.sin(i / 4); });
  const a = prepareRoomResponse(rows, 500), b = prepareRoomResponse(changed, 500);
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
  const fit = learnRoomResponse(rows, 500);
  assert(fit.result.ok && fit.result.model.response_family === "finite");
  assertEquals(fit.run_ledger!.fitted_runs, 3);
  assertAlmostEquals(fit.result.model.cooling_constant_per_h, .02, .001);
  assertAlmostEquals(fit.result.model.gain_c_per_wh, .002, .0001);
  assert(Date.parse(fit.run_ledger!.oldest_run_at!) >= rows[epoch].start_ms);
});

Deno.test("resumable calibration returns the same result through serialized bounded cells", () => {
  const rows = plant(3), prepared = prepareRoomResponse(rows, 500);
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

/** JSONB transport: sorted keys and a JSON roundtrip, as each worker request reads. */
function jsonb<T>(value: T): T {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)])) : input;
  return JSON.parse(JSON.stringify(normalize(value)));
}
const readCells = (stored: unknown[]) => [...parseRoomBandFitCells(stored.slice(0, ROOM_BAND_FIT_CELL_COUNT)),
  ...parseRoomBandFitCells(stored.slice(ROOM_BAND_FIT_CELL_COUNT))];

/** The previous production policy: one cell or iteration per fenced request. */
function oneCellPerRequest(prepared: ReturnType<typeof prepareRoomResponse>) {
  let stored: unknown[] = [], heat: unknown = null, requests = 0;
  while (stored.length < ROOM_RESPONSE_CELL_COUNT) {
    const cells = readCells(jsonb(stored));
    const step = advanceRoomResponseCell(prepared, cells, parseRoomHeatFitState(jsonb(heat), cells.length % ROOM_BAND_FIT_CELL_COUNT), 500);
    requests++;
    if (step.cell) { stored = [...stored, jsonb(step.cell)]; heat = null; } else heat = jsonb(step.state);
  }
  return { stored, requests };
}

function batched(prepared: ReturnType<typeof prepareRoomResponse>, budgetMs: number, start: unknown[] = []) {
  let stored = start, heat: unknown = null;
  const batches: number[] = [];
  while (stored.length < ROOM_RESPONSE_CELL_COUNT) {
    const cells = readCells(jsonb(stored));
    const batch = advanceRoomResponseCells(prepared, cells, parseRoomHeatFitState(jsonb(heat), cells.length % ROOM_BAND_FIT_CELL_COUNT), budgetMs);
    assert(batch.cells.length > 0 || batch.state !== null, "every request records progress");
    assertEquals(batch.state === null || batch.state.index === (cells.length + batch.cells.length) % ROOM_BAND_FIT_CELL_COUNT, true);
    stored = [...stored, ...jsonb(batch.cells)]; heat = jsonb(batch.state);
    batches.push(batch.cells.length);
  }
  return { stored, batches };
}

Deno.test("batched response cells equal one cell per request through serialized interruptions and the stage crossing", () => {
  const rows = plant(4), reference = oneCellPerRequest(prepareRoomResponse(rows, 500));
  const expected = finalizeRoomResponse(prepareRoomResponse(rows, 500), readCells(reference.stored));
  // A zero budget interrupts after every single microstep; an unbounded one
  // runs both stages in one request and therefore crosses cell eighteen.
  for (const budget of [0, 1e9]) {
    const actual = batched(prepareRoomResponse(rows, 500), budget);
    assertEquals(actual.stored, reference.stored, `budget ${budget} changes a fitted cell`);
    assertEquals(finalizeRoomResponse(prepareRoomResponse(rows, 500), readCells(actual.stored)), expected);
    if (budget === 0) {
      assert(actual.batches.every(count => count <= 1), "a zero budget runs exactly one microstep");
      assert(actual.batches.length > ROOM_RESPONSE_CELL_COUNT, "the fixture exercises partial additional-heat state");
    } else assertEquals(actual.batches, [ROOM_RESPONSE_CELL_COUNT], "cheap cells share one commit");
  }
  // Resume inside stage one from a persisted prefix and cross into stage two.
  const resumed = batched(prepareRoomResponse(rows, 500), 1e9, reference.stored.slice(0, 17));
  assertEquals(resumed.batches, [ROOM_RESPONSE_CELL_COUNT - 17]);
  assertEquals(resumed.stored, reference.stored);
  assertThrows(() => advanceRoomResponseCells(prepareRoomResponse(rows, 500), readCells(reference.stored), null, 1e9),
    Error, "already complete");
});

Deno.test("partial solar coverage keeps one observation design across both calibration stages", () => {
  const rows = plant(6);
  rows.slice(0, 32).forEach(row => { row.solar_w_per_m2 = null; });
  rows[71].room_c = null;
  const fit = learnRoomResponse(rows, 500);
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
  const fit = learnRoomResponse(rows, 500);
  assert(fit.result.ok && fit.result.model.response_family === "finite", JSON.stringify(fit));
  assertEquals(fit.run_ledger!.fitted_runs, 3);
  assertAlmostEquals(fit.result.model.cooling_constant_per_h, .035, .001);
  assertAlmostEquals(fit.result.model.background_gain_c_per_h, -.02, .001);
});
