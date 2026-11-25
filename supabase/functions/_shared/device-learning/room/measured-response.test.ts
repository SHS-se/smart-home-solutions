import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { learnMeasuredRoomResponse, prepareMeasuredRoomResponse, fitMeasuredRoomCell, parseMeasuredRoomCells, finalizeMeasuredRoomResponse, ROOM_MEASURED_CELL_COUNT } from "./measured-response.ts";
import { syntheticMeasuredRoom, measuredSyntheticEvidence } from "./measured-response.fixture.ts";
import { readThermalModel } from "../../planner/models/room/read-model.ts";
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { hasMeasuredRoomSupport } from "../../planner/models/room/measured-evidence.ts";
import { excludeUncontrolledRoomHeat } from "../../planner/models/room/thermal.ts";
import { syntheticOperationRoom } from "./measured-calibration.fixture.ts";

Deno.test("measured response identifies weather input gain and conserved delayed heat from native means", () => {
  const plant = syntheticMeasuredRoom(), fit = learnMeasuredRoomResponse(measuredSyntheticEvidence(plant.rows), 600);
  assert(fit.result.ok);
  const model = fit.result.learning_evidence.chronological_model;
  assert(model && model.response_family === "finite");
  assert(readThermalModel(JSON.parse(JSON.stringify(model))));
  assertAlmostEquals(model.cooling_constant_per_h, plant.outdoorK, .0001);
  assertAlmostEquals(model.house_coupling_per_h!, plant.houseK, .0001);
  assertAlmostEquals(model.heat_lag_h!, plant.lag, 1e-8);
  const gain = model.gain_c_per_wh * (1 + model.gain_outdoor_slope_per_c! * (plant.reference - model.gain_reference_outdoor_c!));
  assertAlmostEquals(gain, plant.gain, .00001);
  assertAlmostEquals(model.gain_c_per_wh * model.gain_outdoor_slope_per_c!, plant.gain * plant.weatherSlope, .000001);
  assertAlmostEquals(model.background_gain_c_per_h, plant.background, .0001);
  assert(hasMeasuredRoomSupport(fit.result.learning_evidence));
  assert(fit.result.learning_evidence.chronological_validation.trajectory_mae_c! < .001);
});

Deno.test("cells survive JSON checkpoints and exact observed counts pin publication", () => {
  const { rows } = syntheticMeasuredRoom(90, 0, 0);
  const prepared = prepareMeasuredRoomResponse(measuredSyntheticEvidence(rows), 600);
  const cells = Array.from({ length: ROOM_MEASURED_CELL_COUNT }, (_, i) => fitMeasuredRoomCell(prepared, i));
  const parsed = parseMeasuredRoomCells(JSON.parse(JSON.stringify(cells)));
  const fit = finalizeMeasuredRoomResponse(prepared, parsed);
  assert(fit.result.ok);
  assertEquals(fit.result.learning_evidence.measured_runs.fitted_observations, fit.result.model.sample_count);
  assertEquals(fit.run_ledger!.observed_runs, fit.result.learning_evidence.measured_runs.observed_runs);
  // The constrained weather endpoints may meet at exactly the same gain.
  // That boundary must still publish a model the planner can decode.
  const flatWeather = parsed.map(cell => ({ ...cell, fits: cell.fits
    .filter(candidate => candidate.family === "finite" && candidate.weather)
    .map(candidate => ({ ...candidate, beta: candidate.beta.map((v, i) => i === 1 ? candidate.beta[0] : v) })) }));
  const flat = finalizeMeasuredRoomResponse(prepared, flatWeather);
  assert(flat.result.ok);
  const flatModel = flat.result.learning_evidence.chronological_model;
  assert(flatModel && readThermalModel(flatModel));
  assertEquals((flatModel as { gain_outdoor_slope_per_c?: number }).gain_outdoor_slope_per_c, 0);
  assertThrows(() => parseMeasuredRoomCells([{ index: 1, fits: [] }]));
});

Deno.test("rank deficiency publishes measured evidence without invented physical response", () => {
  const fit = learnMeasuredRoomResponse(measuredSyntheticEvidence([]), null);
  assertEquals(fit.result.ok, false);
  assertEquals(fit.result.learning_evidence.measured_runs.fitted_observations, 0);
  assertEquals(fit.run_ledger!.runs, []);
  const calibration = fit.result.learning_evidence.measured_calibration;
  assert(calibration.status === "unidentified");
  assertEquals(calibration.reason, "no_native_pairs");
  assertEquals(calibration.uncredited_background_w, null);
});

Deno.test("missing later irradiance preserves solar candidate shape and known heater memory", () => {
  const plant = syntheticMeasuredRoom(240, .025, 1, 900, .0005);
  plant.rows[200].solar_w_per_m2 = null;
  plant.rows[180].room_c = null;
  const fit = learnMeasuredRoomResponse(measuredSyntheticEvidence(plant.rows), 600);
  const model = fit.result.learning_evidence.chronological_model;
  assert(fit.result.ok && model && model.response_family === "finite");
  assertAlmostEquals(model.solar_gain_c_per_h_per_wm2!, .0005, .00001);
  assertAlmostEquals(model.cooling_constant_per_h, plant.outdoorK, .0001);
  assertAlmostEquals(model.house_coupling_per_h!, plant.houseK, .0001);
  assert(fit.result.learning_evidence.chronological_validation.trajectory_mae_c! < .001);
});

Deno.test("independent integrator and equilibrium observations distinguish causal forecasts from descriptive balance", () => {
  const integral: RoomMeanQuarter[] = [], algebraic: RoomMeanQuarter[] = [];
  let temperature = 20, delivered = 0;
  for (let i = 0; i < 100; i++) {
    const power = i % 13 < 4 ? 500 : 0, rate = .0015 * power - .2;
    const house = 21 + .4 * Math.cos(i / 11), outdoor = 3 + 3 * Math.sin(i / 17);
    const base = { start_ms: i * 3_600_000, duration_s: 3600 as const, heat_w: power,
      house_c: house, outdoor_c: outdoor, solar_w_per_m2: null, cooling: false };
    integral.push({ ...base, room_c: temperature + rate / 2 }); temperature += rate;
    const carry = Math.exp(-1 / 2), meanDelivered = power + (delivered - power) * 2 * (1 - carry);
    algebraic.push({ ...base, room_c: .8 * house + .2 * outdoor + 2 + .006 * meanDelivered });
    delivered = power + (delivered - power) * carry;
  }
  for (const [rows, family] of [[integral, "integrator"], [algebraic, "equilibrium"]] as const) {
    const fit = learnMeasuredRoomResponse(measuredSyntheticEvidence([...rows]), 500);
    assertEquals(fit.result.learning_evidence.descriptive_fit?.family, family);
    assertEquals(fit.result.learning_evidence.selection_scope, "state_carrying");
    const chronological = fit.result.learning_evidence.chronological_model;
    if (family === "integrator") assertEquals(chronological?.response_family, family);
    assert(chronological?.response_family !== "equilibrium");
    if (fit.result.ok) {
      assert(fit.result.model.response_family !== "equilibrium");
      assert(readThermalModel(JSON.parse(JSON.stringify(fit.result.model))));
    }
  }
});

Deno.test("descriptive candidates cannot shrink causal holdout support or supply an invented dynamical response", () => {
  const { rows } = syntheticMeasuredRoom(240, 0, 0, 900, .0005);
  rows[200].solar_w_per_m2 = null;
  const prepared = prepareMeasuredRoomResponse(measuredSyntheticEvidence(rows), 600);
  const cells = Array.from({ length: ROOM_MEASURED_CELL_COUNT }, (_, i) => fitMeasuredRoomCell(prepared, i));
  // These checkpoint candidates use different measured holdout support:
  // no-solar dynamics can score the quarter missing irradiance, solar balance cannot.
  const causal = cells.map(cell => ({ ...cell, fits: cell.fits.filter(fit => fit.family !== "equilibrium" && !fit.solar) }));
  const descriptive = cells.map(cell => ({ ...cell, fits: cell.fits.filter(fit => fit.family === "equilibrium" && fit.solar) }));
  const combinedCells = causal.map((cell, i) => ({ ...cell, fits: [...cell.fits, ...descriptive[i].fits] }));
  const combined = finalizeMeasuredRoomResponse(prepared, combinedCells), alone = finalizeMeasuredRoomResponse(prepared, causal);
  assert(combined.result.ok && alone.result.ok);
  assertEquals(combined.result.model, alone.result.model);
  assertEquals(combined.result.learning_evidence.measured_runs, alone.result.learning_evidence.measured_runs);
  assertEquals(combined.result.learning_evidence.chronological_validation, alone.result.learning_evidence.chronological_validation);
  assert(combined.result.learning_evidence.chronological_validation.observations > combined.result.learning_evidence.descriptive_fit!.observations);
  const algebraicOnly = finalizeMeasuredRoomResponse(prepared, descriptive);
  assertEquals(algebraicOnly.result.learning_evidence.chronological_model, null, "an algebraic balance is never a dynamical response");
  assertEquals(algebraicOnly.result.learning_evidence.descriptive_fit?.family, "equilibrium");
  // Native operation calibration does not depend on the chronological candidates.
  assertEquals(algebraicOnly.result.ok && algebraicOnly.result.model, alone.result.model);
});

Deno.test("native operation intervals supply the published planner response and the chronological fit stays as evidence", () => {
  const plant = syntheticMeasuredRoom(), fit = learnMeasuredRoomResponse(measuredSyntheticEvidence(plant.rows), 600);
  assert(fit.result.ok);
  assertEquals(fit.result.learning_evidence.planner_response, "measured_intervals");
  assert(fit.result.model.response_family === "finite");
  assert(fit.result.learning_evidence.chronological_model);
  assertEquals(fit.result.learning_evidence.measured_runs.fitted_observations, fit.result.model.sample_count);
  assert(hasMeasuredRoomSupport(fit.result.learning_evidence));
  const calibration = fit.result.learning_evidence.measured_calibration;
  assertEquals(calibration.status, "identified");
  assertEquals(calibration.fitted_pairs, fit.result.model.sample_count);
  assertAlmostEquals(calibration.uncredited_background_w!,
    Math.max(0, fit.result.learning_evidence.forecast_nuisance.fitted_offset) / fit.result.model.gain_c_per_wh, 1e-9);
});

Deno.test("unidentified operation support explains the unchanged chronological choice", () => {
  // This synthetic input never exceeds the existing 50 W operation threshold.
  // The chronological diagnostic still has independently varying measured input.
  const plant = syntheticOperationRoom({ count: 360, watts: hour => hour % 12 < 3 ? 40 : 0 });
  const fit = learnMeasuredRoomResponse(measuredSyntheticEvidence(plant.rows), 600);
  assert(fit.result.ok);
  const learning = fit.result.learning_evidence, calibration = learning.measured_calibration;
  assertEquals(learning.planner_response, "chronological_fit");
  assert(calibration.status === "unidentified");
  assertEquals(calibration.reason, "no_native_pairs");
  assertEquals(calibration.uncredited_background_w, null);
  assert(learning.chronological_model);
  assertEquals(fit.result.model, excludeUncontrolledRoomHeat(learning.chronological_model));
});
