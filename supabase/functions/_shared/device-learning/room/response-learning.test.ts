import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { syntheticRoomPlant, syntheticRoomResponseEvidence } from "./native-mean.fixture.ts";
import {
  learnRoomResponse, prepareRoomResponse, advanceRoomResponseCells, finalizeRoomResponse,
  ROOM_RESPONSE_CELL_COUNT, ROOM_TRANSITION_POLICY, roomResponseTrainingLength,
} from "./response-learning.ts";
import {
  advanceIndependentRoomBandCell, evaluateRoomBandFiniteTrial, parseRoomBandFitCells, parseRoomHeatFitState, type RoomBandFitCell, type RoomHeatFitState,
} from "./mean-observations.ts";

import { hasRoomTransitionSupport } from "../../planner/models/room/run-evidence.ts";

function plant(events = 8) {
  return syntheticRoomPlant([900], events * 32, .5, .0001, {
    gain: .002, houseGain: .04, outdoorGain: .035, background: .02, roomStart: 19,
    startMs: Date.UTC(2025, 0, 1), steps: 600,
    forcing: i => ({ outdoor: -7 + .4 * Math.sin(i / 17), house: 20 + .4 * Math.cos(i / 30),
      watts: i % 32 >= 2 && i % 32 < 15 ? 500 : 0,
      solar: Math.max(0, 200 * Math.sin(i / 96 * 2 * Math.PI)) }),
  }).rows;
}

Deno.test("the shared fit uses transitions from two runs and publishes no uncontrolled background", () => {
  const rows = plant(2), fitted = learnRoomResponse(syntheticRoomResponseEvidence(rows), 500);
  assert(fitted.result.ok && fitted.result.model.response_family === "finite");
  assertEquals(fitted.run_ledger?.observed_runs, 2);
  assertEquals(fitted.result.model.sample_count, rows.length - 1);
  assertEquals(fitted.result.learning_evidence!.transition_calibration, {
    policy: ROOM_TRANSITION_POLICY, fitted_transitions: rows.length - 1,
  });
  assert(hasRoomTransitionSupport(fitted.result.learning_evidence));
  assertAlmostEquals(fitted.result.model.gain_c_per_wh, .002, .00001);
  assertEquals(fitted.result.model.background_gain_c_per_h, 0);
  assertAlmostEquals(fitted.result.learning_evidence!.forecast_nuisance!.fitted_offset, .02, .001);
  assert(fitted.result.warnings?.includes("insufficient_heating"), "sparse heating remains visible to the planner");
});

Deno.test("an always-on heater with changing output identifies a response without any complete runs", () => {
  const { rows } = syntheticRoomPlant([900, 900, 3600], 96, .5, 0, {
    gain: .002, houseGain: .04, outdoorGain: .035, background: -.02, roomStart: 19,
    startMs: Date.UTC(2025, 0, 1), steps: 400,
    forcing: i => ({ outdoor: -7 + 2 * Math.sin(i / 17), house: 20 + Math.cos(i / 30),
      watts: i % 7 < 3 ? 600 : 180, solar: null }),
  });
  const fit = learnRoomResponse(syntheticRoomResponseEvidence(rows), 600);
  assert(fit.result.ok && fit.result.model.response_family === "finite");
  assertAlmostEquals(fit.result.model.gain_c_per_wh, .002, .00001);
  assertEquals(fit.result.model.sample_count, rows.length - 1);
  assertEquals(fit.run_ledger, { policy: ROOM_TRANSITION_POLICY, observed_runs: 0, runs: [] });
  const singular = learnRoomResponse(syntheticRoomResponseEvidence(rows.slice(0, 2)), 600);
  assert(!singular.result.ok);
  assert(!hasRoomTransitionSupport(singular.result.learning_evidence));
  assertEquals(singular.run_ledger, null);
});

Deno.test("persistent unknown heat is inferred from all transitions including its overlap with the heater", () => {
  const rows = plant();
  let warmth = 0;
  for (let i = 0; i < rows.length; i++) {
    const input = i >= 6 * 32 + 7 && i < 6 * 32 + 20 ? 1.4 : 0;
    const decay = Math.exp(-.075 * .25), share = (1 - decay) / (.075 * .25);
    rows[i].room_c! += warmth * share + input / .075 * (1 - share);
    warmth = warmth * decay + input / .075 * (1 - decay);
  }
  const original = structuredClone(rows), result = learnRoomResponse(syntheticRoomResponseEvidence(rows), 500);
  assert(result.result.ok && result.result.model.response_family === "finite");
  assertEquals(result.result.model.sample_count, rows.length - 1);
  assert(result.result.learning_evidence?.additional_heat?.selected);
  assertEquals(result.run_ledger!.observed_runs, 8);
  assertEquals(result.run_ledger!.runs[6].disposition, "suspect_change");
  assertAlmostEquals(result.result.model.gain_c_per_wh, .002, .0001);
  assertEquals(rows, original);
});

Deno.test("held-out cadence, temperatures and solar availability cannot change a training cell", () => {
  const evidence = syntheticRoomResponseEvidence(plant());
  const changed = { fullRows: structuredClone(evidence.fullRows), trainingRows: evidence.trainingRows };
  // Read-time qualification of the entire archive can revise an observation
  // already seen by the training prefix. Its independent read still stands.
  changed.fullRows[70].room_c = null;
  for (const [i, row] of changed.fullRows.slice(changed.trainingRows.length).entries()) {
    row.room_c! += 2 * Math.sin(i / 4);
    row.solar_w_per_m2 = null;
  }
  const a = prepareRoomResponse(evidence, 500), b = prepareRoomResponse(changed, 500);
  assert(a.solar && !b.solar && a.trainingSolar && b.trainingSolar);
  assertEquals(a.trainingRows, b.trainingRows);
  const firstCell = (prepared: typeof a) => {
    let state: RoomHeatFitState | null = null;
    for (;;) {
      const step = advanceIndependentRoomBandCell(prepared, 0, state);
      if (step.cell) return step.cell;
      state = step.state;
    }
  };
  assertEquals(firstCell(a), firstCell(b));
});

Deno.test("every eligible transition and complete event beyond twenty-four enters the shared result", () => {
  const rows = plant(26), result = learnRoomResponse(syntheticRoomResponseEvidence(rows), 500);
  assert(result.result.ok);
  assertEquals(result.result.model.sample_count, rows.length - 1);
  assertEquals(result.run_ledger!.runs.map(run => run.id), rows.filter((_, i) => i % 32 === 2).map(row => String(row.start_ms)));
  assertEquals(result.run_ledger!.observed_runs, 26);
});

/** JSONB transport: sorted keys and a JSON roundtrip, as each worker request reads. */
function jsonb<T>(value: T): T {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)])) : input;
  return JSON.parse(JSON.stringify(normalize(value)));
}
const readCells = parseRoomBandFitCells;

/** The previous production policy: one cell or iteration per fenced request. */
function oneCellPerRequest(prepared: ReturnType<typeof prepareRoomResponse>) {
  let stored: unknown[] = [], heat: unknown = null, requests = 0;
  while (stored.length < ROOM_RESPONSE_CELL_COUNT) {
    const cells = readCells(jsonb(stored));
    const step = advanceIndependentRoomBandCell(prepared, cells.length, parseRoomHeatFitState(jsonb(heat), cells.length), 500);
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
    const batch = advanceRoomResponseCells(prepared, cells, parseRoomHeatFitState(jsonb(heat), cells.length), budgetMs);
    assert(batch.cells.length > 0 || batch.state !== null, "every request records progress");
    assertEquals(batch.state === null || batch.state.index === (cells.length + batch.cells.length), true);
    stored = [...stored, ...jsonb(batch.cells)]; heat = jsonb(batch.state);
    batches.push(batch.cells.length);
  }
  return { stored, batches };
}

Deno.test("batched response cells equal one cell per request through serialized interruptions", () => {
  const rows = plant(4), reference = oneCellPerRequest(prepareRoomResponse(syntheticRoomResponseEvidence(rows), 500));
  const expected = finalizeRoomResponse(prepareRoomResponse(syntheticRoomResponseEvidence(rows), 500), readCells(reference.stored));
  // A zero budget checkpoints each microstep. An unbounded batch completes the whole fit.
  for (const budget of [0, 1e9]) {
    const actual = batched(prepareRoomResponse(syntheticRoomResponseEvidence(rows), 500), budget);
    assertEquals(actual.stored, reference.stored, `budget ${budget} changes a fitted cell`);
    assertEquals(finalizeRoomResponse(prepareRoomResponse(syntheticRoomResponseEvidence(rows), 500), readCells(actual.stored)), expected);
    if (budget === 0) {
      assert(actual.batches.every(count => count <= 1), "a zero budget runs exactly one microstep");
      assert(actual.batches.length > ROOM_RESPONSE_CELL_COUNT, "the fixture exercises partial additional-heat state");
    } else assertEquals(actual.batches, [ROOM_RESPONSE_CELL_COUNT], "cheap cells share one commit");
  }
  // Resume the last cell from its persisted prefix.
  const resumed = batched(prepareRoomResponse(syntheticRoomResponseEvidence(rows), 500), 1e9, reference.stored.slice(0, 17));
  assertEquals(resumed.batches, [ROOM_RESPONSE_CELL_COUNT - 17]);
  assertEquals(resumed.stored, reference.stored);
  assertThrows(() => advanceRoomResponseCells(prepareRoomResponse(syntheticRoomResponseEvidence(rows), 500), readCells(reference.stored), null, 1e9),
    Error, "already complete");
});

Deno.test("missing solar and power leave gaps in support; a repaired capture restores those transitions", () => {
  const rows = plant(6);
  rows.slice(0, 32).forEach(row => { row.solar_w_per_m2 = null; });
  const repair = rows[71].heat_w;
  rows[71].heat_w = null;
  const partial = learnRoomResponse(syntheticRoomResponseEvidence(rows), 500);
  assert(partial.result.ok);
  assertEquals(partial.result.model.sample_count, rows.length - 1 - 32 - 2);
  rows[71].heat_w = repair;
  const repaired = learnRoomResponse(syntheticRoomResponseEvidence(rows), 500);
  assert(repaired.result.ok);
  assertEquals(repaired.result.model.sample_count, rows.length - 1 - 32);
});

Deno.test("transition support requires a count certified by its fit and positive residual degrees of freedom", () => {
  const transition_calibration = { policy: ROOM_TRANSITION_POLICY, fitted_transitions: 7 };
  for (const dof of [undefined, 0, -1, 7, 8, 2.3, "2"]) {
    assert(!hasRoomTransitionSupport({ transition_calibration, residual_degrees_of_freedom: dof }));
  }
  assert(hasRoomTransitionSupport({ transition_calibration, residual_degrees_of_freedom: 1 }));
  assert(!hasRoomTransitionSupport({ transition_calibration: { ...transition_calibration, policy: "other" }, residual_degrees_of_freedom: 1 }));
});


Deno.test("a chronological training prefix has the same native intervals as its frozen capture", () => {
  assertEquals(roomResponseTrainingLength([3600, 900, 900]), 1);
  assertEquals(roomResponseTrainingLength([900, 900, 3600]), 3);
  assertEquals(roomResponseTrainingLength([]), 0);
  const evidence = syntheticRoomResponseEvidence(plant(1));
  assertThrows(() => prepareRoomResponse({ ...evidence, trainingRows: evidence.trainingRows.slice(1) }, 500), Error, "training prefix");
  const mismatched = structuredClone(evidence.trainingRows);
  mismatched[1].duration_s = 3600;
  assertThrows(() => prepareRoomResponse({ ...evidence, trainingRows: mismatched }, 500), Error, "training prefix");
});


Deno.test("a weather gap excludes its transitions while known power still carries the heater state", () => {
  const rows = plant(3);
  const evaluate = () => evaluateRoomBandFiniteTrial(prepareRoomResponse(syntheticRoomResponseEvidence(rows), 500), 3, .075);
  const full = evaluate();
  assert(full);
  rows[39].outdoor_c = null;
  const weatherGap = evaluate();
  assert(weatherGap);
  assertEquals(weatherGap.n, full.n - 2);
  assertEquals(weatherGap.dof, full.dof - 2);
  rows[39].heat_w = null;
  const meterGap = evaluate();
  assert(meterGap);
  assertEquals(meterGap.n, weatherGap.n);
  assertEquals(meterGap.dof, weatherGap.dof - 1, "unknown power creates one new nonnegative heater entry state");
});
