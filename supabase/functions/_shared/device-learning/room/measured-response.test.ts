import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { learnMeasuredRoomResponse, measuredLineResponse, prepareMeasuredRoomResponse, fitMeasuredRoomCell, parseMeasuredRoomCells, finalizeMeasuredRoomResponse, ROOM_MEASURED_CELL_COUNT } from "./measured-response.ts";
import { syntheticMeasuredRoom, measuredSyntheticEvidence } from "./measured-response.fixture.ts";
import { readThermalModel } from "../../planner/models/room/read-model.ts";
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { hasMeasuredRoomSupport, type MeasuredRoomRun } from "../../planner/models/room/measured-evidence.ts";
import { roomHeaterGain } from "../../planner/models/room/thermal.ts";

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
  // The measured lines do not depend on the chronological candidates.
  assertEquals(algebraicOnly.result.ok && algebraicOnly.result.model, alone.result.model);
});

// Synthetic measured runs, independent of household observations.
function syntheticRuns(cooling = true): MeasuredRoomRun[] {
  return Array.from({ length: 12 }, (_, i) => {
    const outdoor = -6 + i, start = i * 86_400_000;
    return { id: String(start), from_ms: start, on_ms: start, off_ms: start + 3_600_000, to_ms: start + 4 * 3_600_000, energy_kwh: 1,
      heating: { on_ms: start, peak_ms: start + 3_600_000, peak_end_ms: start + 4_500_000, energy_kwh: 1, hours: 1,
        rise_c: 1 + .02 * outdoor, c_per_kwh: 1 + .02 * outdoor, room_start_c: 19, room_peak_c: 20, room_mean_c: 19.5,
        outdoor_c: outdoor, house_c: 19, native_seconds: [900] },
      cooling: cooling ? { from_ms: start + 7_200_000, to_ms: start + 14_400_000, hours: 2,
        c_per_h: .01 * (20 - outdoor), room_c: 20, outdoor_c: outdoor, house_c: 19, energy_kwh: 0 } : null,
      reasons: [] };
  });
}

Deno.test("the planner response takes cooling loss from the cooling points and adds each run's loss back to its net rise once", () => {
  const model = measuredLineResponse(syntheticRuns(), 1000);
  assert(model && model.response_family === "finite" && readThermalModel(JSON.parse(JSON.stringify(model))));
  for (const outdoor of [-6, 0, 5]) {
    // Net rise 1 + .02·outdoor over a one-hour, 1 kWh run at 19.5 °C, plus that hour's loss .01·(19.5 − outdoor).
    assertAlmostEquals(roomHeaterGain(model, outdoor) * 1000, 1 + .02 * outdoor + .01 * (19.5 - outdoor), 1e-6);
  }
  assertAlmostEquals(model.cooling_constant_per_h, .01, 1e-9, "cooling falls .01 °C/h per °C above outdoors");
  assertEquals([model.house_coupling_per_h, model.heat_lag_h], [0, 0]);
  assertAlmostEquals(model.background_gain_c_per_h, 0, 1e-9);
  assertEquals(measuredLineResponse(syntheticRuns(false), 1000), null, "no cooling points, no line response");
});

Deno.test("cooling points separate rest-of-home exchange from outdoor loss and a constant term", () => {
  const runs = syntheticRuns().map((run, i) => {
    const room = 20 + (i % 3) * .5, house = 19 + (i % 4) * .4, outdoor = run.cooling!.outdoor_c;
    return { ...run, cooling: { ...run.cooling!, room_c: room, house_c: house,
      c_per_h: .012 * (room - outdoor) + .05 * (room - house) - .02 } };
  });
  const model = measuredLineResponse(runs, 1000);
  assert(model && model.response_family === "finite");
  assertAlmostEquals(model.cooling_constant_per_h, .012, 1e-9);
  assertAlmostEquals(model.house_coupling_per_h!, .05, 1e-9);
  assertAlmostEquals(model.background_gain_c_per_h, .02, 1e-9);
});

Deno.test("measured lines become the published planner response and the chronological fit stays as evidence", () => {
  const plant = syntheticMeasuredRoom(), fit = learnMeasuredRoomResponse(measuredSyntheticEvidence(plant.rows), 600);
  assert(fit.result.ok);
  assertEquals(fit.result.learning_evidence.planner_response, "measured_lines");
  assert(fit.result.model.response_family === "finite");
  assert(fit.result.learning_evidence.chronological_model);
  assertEquals(fit.result.learning_evidence.measured_runs.fitted_observations, fit.result.model.sample_count);
  assert(hasMeasuredRoomSupport(fit.result.learning_evidence));
});
