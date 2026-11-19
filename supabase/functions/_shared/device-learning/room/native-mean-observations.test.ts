import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { ROOM_BAND_FIT_CELL_COUNT, fitIndependentRoomBand, fitIndependentRoomBandCell, finalizeIndependentRoomBand, fitRoomBand,
  fitRoomMeans, parseRoomBandFitCells, prepareIndependentRoomBand, roomEquilibriumMeanPair, roomMeanObservation, roomMeanPair,
  type RoomBandFitCell, type RoomMeanQuarter } from "./mean-observations.ts";
import { prepareRoomMeanEvidence } from "./mean-evidence.ts";
import { leastSquares } from "./mean-least-squares.ts";
import { syntheticRoomPlant as plant } from "./native-mean.fixture.ts";

Deno.test("native mixed-duration mean kernel matches independent physics at both resolution boundaries", () => {
  const truth = plant([900, 3600, 3600, 900]);
  for (let i = 0; i + 1 < truth.rows.length; i++) {
    const q = truth.rows[i], next = truth.rows[i + 1];
    const op = roomMeanObservation(.05, truth.lag, q.duration_s! / 3600);
    const pair = roomMeanPair(op, roomMeanObservation(.05, truth.lag, next.duration_s! / 3600));
    const forcing = (row: RoomMeanQuarter) => truth.houseGain * row.house_c! + truth.outdoorGain * row.outdoor_c! + truth.background;
    const mean = pair.alpha * q.room_c! + truth.gain * (pair.memory * truth.memory[i] + pair.currentHeat * q.heat_w! + pair.nextHeat * next.heat_w!) +
      pair.L * forcing(q) + pair.nextForcing * forcing(next);
    assertAlmostEquals(mean, next.room_c!, 1e-6);
  }
});

Deno.test("the exact equilibrium operator is the finite operator's mixed-duration limit", () => {
  const exchange = 1e7;
  for (const lag of [0, .5, 2, 5]) for (const current of [.25, 1]) for (const next of [.25, 1]) {
    const finite = roomMeanPair(roomMeanObservation(exchange, lag, current), roomMeanObservation(exchange, lag, next));
    const limit = roomEquilibriumMeanPair(lag, current, next);
    for (const key of ["L", "nextForcing", "memory", "currentHeat", "nextHeat"] as const) {
      assertAlmostEquals(exchange * finite[key], limit[key], 1e-6);
    }
    if (lag === 0) assertEquals(finite.memory, 0);
  }
});

Deno.test("short identifiable cold bands retain measured solar forcing", () => {
  const truth = plant([3600], 72, 1, .0008);
  const result = fitIndependentRoomBand(truth.rows, c => c >= -10 && c < -5).result;
  assert(result.ok);
  assert(result.model.response_family !== "equilibrium");
  assertAlmostEquals(result.model.solar_gain_c_per_h_per_wm2!, .0008, 1e-6);
  assertAlmostEquals(result.model.gain_c_per_wh, truth.gain, 1e-6);
  assertEquals(result.model.heat_lag_h, truth.lag);
});

Deno.test("serialized band cells reproduce the mixed-interval fit and forecast after resuming", () => {
  const rows = plant([900, 3600, 900, 900], 240, 1, .001).rows;
  rows[84].heat_w = null;
  rows[130].room_c = null;
  rows.at(-1)!.heat_w = null;
  const cold = (c: number) => c >= -10 && c < -5;
  const synchronous = fitIndependentRoomBand(rows, cold, 500);
  assert(synchronous.result.ok);
  assertEquals(synchronous.result.learning_evidence?.selected_lag_h, 1);
  let prefix: RoomBandFitCell[] = [];
  for (let i = 0; i < ROOM_BAND_FIT_CELL_COUNT; i++) {
    const prepared = prepareIndependentRoomBand(rows, cold, 500);
    const cell = fitIndependentRoomBandCell(prepared, i);
    prefix = parseRoomBandFitCells(JSON.parse(JSON.stringify([...prefix, cell])));
    assertEquals(prefix.length, i + 1);
  }
  assertEquals(finalizeIndependentRoomBand(prepareIndependentRoomBand(rows, cold, 500), prefix), synchronous);
});

Deno.test("band cells reject invalid prefixes and retain an unidentified completed grid", () => {
  const prepared = prepareIndependentRoomBand([], () => true);
  const cells = Array.from({ length: ROOM_BAND_FIT_CELL_COUNT }, (_, i) => fitIndependentRoomBandCell(prepared, i));
  assertEquals(parseRoomBandFitCells(cells), cells);
  assertEquals(parseRoomBandFitCells([]), []);
  assertThrows(() => parseRoomBandFitCells([cells[1]]), Error, "Invalid staged room band fit cell");
  assertThrows(() => parseRoomBandFitCells([{ ...cells[0], fits: { ...cells[0].fits, finite: {
    k: 1, beta: [1, 1, null], mse: 0, n: 100, dof: 97,
  } } }]), Error, "Invalid staged room band fit summary");
  assertThrows(() => finalizeIndependentRoomBand(prepared, cells.slice(0, -1)), Error, "Room band fit is incomplete");
  const { result, minC, maxC } = finalizeIndependentRoomBand(prepared, cells);
  assert(!result.ok);
  assertEquals(result.reason, "insufficient_samples");
  assertEquals([minC, maxC], [null, null]);
});

Deno.test("a short holdout publishes the selected equilibrium family and its own diagnostics", () => {
  // Independent synthetic algebraic room with a two-hour delivered-power
  // reservoir. There is no finite room heat capacity to recover.
  let seed = 19, delivered = 0;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  const rows: RoomMeanQuarter[] = [];
  for (let i = 0; i < 34; i++) {
    const house = 21 + .3 * Math.sin(i / 5), outdoor = -12 + Math.sin(i / 7), power = i % 8 < 2 ? 500 : 0;
    let integral = 0;
    for (let second = 0; second < 3600; second++) {
      integral += house + .006 * delivered + .2 * (outdoor - house) + 5;
      delivered += (power - delivered) / 2 / 3600;
    }
    rows.push({ start_ms: i * 3600000, duration_s: 3600,
      room_c: integral / 3600 + .1 * (random() + random() + random() + random() - 2),
      house_c: house, outdoor_c: outdoor, heat_w: power, cooling: false, solar_w_per_m2: null });
  }
  const result = fitIndependentRoomBand(rows, () => true).result;
  assert(result.ok);
  assertEquals(result.model.response_family, "equilibrium");
  assert(result.model.response_family === "equilibrium");
  const selection = result.learning_evidence!.response_selection!;
  assertEquals(selection.selected, "equilibrium_response");
  assertEquals(result.model.heater_c_per_w, selection.steady_response!.heater_c_per_w);
  assertEquals(result.model.heat_lag_h, selection.equilibrium_lag_h);
  assertEquals(result.learning_evidence!.selected_lag_h, selection.equilibrium_lag_h);
  assertEquals(result.learning_evidence!.validation_pairs, selection.equilibrium_validation_pairs);
  assertEquals(result.learning_evidence!.validation_mse_c2, selection.equilibrium_validation_mse_c2);
  assert(Number.isFinite(result.model.prediction_error_c));
  assert(result.model.prediction_error_c! < .2);
  const prepared = prepareIndependentRoomBand(rows, () => true);
  const cells = Array.from({ length: ROOM_BAND_FIT_CELL_COUNT }, (_, i) => fitIndependentRoomBandCell(prepared, i));
  assertEquals(finalizeIndependentRoomBand(prepared, parseRoomBandFitCells(JSON.parse(JSON.stringify(cells))))
    .result, result);
  assertEquals(selection.equilibrium_holdout_selected_lag_h, 1.5);
  assertEquals(selection.equilibrium_lag_h, 2);
  assertEquals(selection.equilibrium_validation_pairs, 9);
  assert(selection.equilibrium_aicc! < selection.finite_aicc!);
  assertAlmostEquals(selection.steady_response!.heater_c_per_w, .006, .0003);
});

Deno.test("a noisy slow room still identifies its finite capacity", () => {
  let seed = 42;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  const truth = plant([3600], 240, 1);
  const rows = truth.rows.map(row => ({ ...row, room_c: row.room_c! + .05 * (random() + random() + random() + random() - 2) }));
  const result = fitIndependentRoomBand(rows, () => true).result;
  assert(result.ok);
  assert(result.model.response_family !== "equilibrium");
  assertEquals(result.learning_evidence!.response_selection!.selected, "finite_response");
  assertAlmostEquals(result.model.gain_c_per_wh, truth.gain, .0001);
});

Deno.test("a zero-exchange room publishes the fitted integrator response without inventing finite loss", () => {
  // Independent synthetic zero-exchange room. The exact interval mean is
  // linear within each hour; mild observation noise can create a spurious
  // finite profile minimum even though no loss timescale exists in the data.
  let seed = 1, temperature = 20;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  const rows: RoomMeanQuarter[] = [];
  for (let i = 0; i < 72; i++) {
    const power = i % 11 < 3 ? 500 : 0, rate = .0015 * power - .2;
    rows.push({ start_ms: i * 3600000, duration_s: 3600,
      room_c: temperature + rate / 2 + .03 * (random() + random() + random() + random() - 2),
      heat_w: power, house_c: 21 + .2 * Math.cos(i / 19), outdoor_c: -7 + .5 * Math.sin(i / 13),
      solar_w_per_m2: null, cooling: false });
    temperature += rate;
  }
  const result = fitIndependentRoomBand(rows, () => true).result;
  assert(result.ok);
  assert(result.model.response_family === "integrator");
  const selection = result.learning_evidence!.response_selection!;
  assertEquals(selection.selected, "integrator_response");
  assertEquals(result.model.gain_c_per_wh, selection.integrator_response!.heater_c_per_wh);
  assertEquals(result.model.cooling_constant_per_h, 0);
  assertEquals(result.model.house_coupling_per_h, 0);
  assertEquals(result.model.time_constant_h, null);
  assertEquals(result.learning_evidence!.selected_lag_h, selection.integrator_lag_h);
  assertEquals(result.learning_evidence!.validation_pairs, selection.integrator_validation_pairs);
  assertEquals(result.learning_evidence!.validation_mse_c2, selection.integrator_validation_mse_c2);
  assert(Number.isFinite(result.model.prediction_error_c));
  assert(result.model.prediction_error_c! < .2);
  assertEquals(JSON.parse(JSON.stringify(result.model)), result.model);
  assert(selection.finite_aicc !== null);
  assert(selection.integrator_aicc! < selection.finite_aicc);
  assertEquals(selection.integrator_parameters, selection.finite_parameters! - 2);
  assertAlmostEquals(selection.integrator_response!.heater_c_per_wh, .0015, .0001);
  assertAlmostEquals(selection.integrator_response!.background_c_per_h, -.2, .01);
});

Deno.test("warm history cannot change a cold band's temperature correction or fitted response", () => {
  const cold = plant([3600]).rows.map((row, i) => i === 80 ? { ...row, room_c: row.room_c! + 30 } : row);
  // Independent synthetic warm-season variability would dominate a global
  // robust scale. It is outside the cold band's observation evidence.
  const warm = Array.from({ length: 720 }, (_, i) => ({ ...cold[i % cold.length], outdoor_c: 20,
    start_ms: cold.at(-1)!.start_ms + (i + 1) * 3_600_000, room_c: 20 + (i % 2) * 10 }));
  const original = fitIndependentRoomBand(cold, c => c < -5).result;
  const appended = fitIndependentRoomBand([...cold, ...warm], c => c < -5).result;
  assert(original.ok && appended.ok);
  assert(original.model.response_family !== "equilibrium" && appended.model.response_family !== "equilibrium");
  assertEquals(original.learning_evidence!.estimated_temperature_readings, 1);
  assertEquals(appended.learning_evidence!.estimated_temperature_readings, 1);
  assertAlmostEquals(appended.model.gain_c_per_wh, original.model.gain_c_per_wh, 1e-12);
  assertEquals(appended.model.heat_lag_h, original.model.heat_lag_h);
});

for (const durations of [[3600], [900, 3600]] as (900 | 3600)[][]) {
  Deno.test(`native ${durations.join("/")} second observations recover their own mean response and evidence`, () => {
    const truth = plant(durations);
    const result = fitRoomMeans(truth.rows, 500);
    assert(result.ok);
    assertEquals(result.model.heat_lag_h, truth.lag);
    assertAlmostEquals(result.model.gain_c_per_wh, truth.gain, 1e-6);
    assertAlmostEquals(result.model.cooling_constant_per_h, truth.outdoorGain, 1e-5);
    assertAlmostEquals(result.model.house_coupling_per_h!, truth.houseGain, 1e-5);
    assertAlmostEquals(result.model.background_gain_c_per_h, truth.background, 1e-4);
    assertEquals(result.model.sample_count, truth.rows.length - 1);
    assertEquals(result.learning_evidence!.observation_intervals, truth.rows.length);
    assertEquals(result.learning_evidence!.observation_hours, truth.rows.reduce((sum, row) => sum + row.duration_s! / 3600, 0));
    assert(result.learning_evidence!.residual_degrees_of_freedom! > 0);
    assert(result.model.prediction_error_c! < 1e-4);
  });
}

Deno.test("native cold band identifies complete coefficients without an inherited general gain", () => {
  const truth = plant([3600]);
  const fit = fitIndependentRoomBand(truth.rows, c => c >= -10 && c < -5, 500);
  assert(fit.result.ok);
  assert(fit.result.model.response_family !== "equilibrium");
  assertAlmostEquals(fit.result.model.gain_c_per_wh, truth.gain, 1e-6);
  assertEquals(fit.result.model.heat_lag_h, truth.lag);
  assert(fit.minC! >= -10 && fit.maxC! < -5);
});

Deno.test("a late winter band validates its own later observations with separate initial storage", () => {
  const truth = plant([3600]);
  // Synthetic warm history occupies the global calendar split. The cold
  // episode still has 160 training hours and 80 independent held-out hours.
  const prefix = Array.from({ length: 720 }, (_, i) => ({ ...truth.rows[i % truth.rows.length],
    start_ms: truth.rows[0].start_ms + i * 3_600_000, outdoor_c: 20 }));
  const cold = truth.rows.map(row => ({ ...row, start_ms: row.start_ms + 720 * 3_600_000 }));
  const result = fitIndependentRoomBand([...prefix, ...cold], c => c >= -10 && c < -5).result;
  assert(result.ok);
  assert(result.model.response_family !== "equilibrium");
  assertEquals(result.learning_evidence!.training_pairs, 159);
  // The first of the 79 validation transitions initializes unknown heat and
  // is excluded from every lag candidate's common scoring set.
  assertEquals(result.learning_evidence!.validation_pairs, 78);
  assertEquals(result.model.heat_lag_h, truth.lag);
  assertAlmostEquals(result.model.gain_c_per_wh, truth.gain, 1e-6);
});

Deno.test("general and constrained band fitting share isolated-temperature corrections", () => {
  const truth = plant([3600]);
  const reference = fitRoomMeans(truth.rows, 500);
  assert(reference.ok);
  const corrupted = truth.rows.map((row, i) => i === 80 || i === 200 ? { ...row, room_c: row.room_c! + 30 } : row);
  const general = fitRoomMeans(corrupted, 500), band = fitRoomBand(corrupted, reference.model, () => true, 500);
  assert(general.ok); assert(band);
  assertEquals(general.learning_evidence!.estimated_temperature_readings, 2);
  // Interpolating one missing temperature estimates a curved physical path.
  assertAlmostEquals(band.model.cooling_constant_per_h, truth.outdoorGain, 1e-4);
  assertAlmostEquals(band.model.background_gain_c_per_h, truth.background, .002);
  assertEquals(corrupted[80].room_c, truth.rows[80].room_c! + 30);
});

Deno.test("unknown cooling and missing heat break only their measured transition evidence", () => {
  const truth = plant([3600]);
  const missing = truth.rows.map((row, i) => i === 80 ? { ...row, heat_w: null } : i === 170 ? { ...row, cooling: null } : row);
  const result = fitRoomMeans(missing, 500);
  assert(result.ok);
  assertEquals(result.model.sample_count, truth.rows.length - 1 - 4);
  assertAlmostEquals(result.model.gain_c_per_wh, truth.gain, 1e-6);
  assertAlmostEquals(result.model.house_coupling_per_h!, truth.houseGain, 1e-5);
});

Deno.test("temperature evidence cannot interpolate across a supplied holdout edge or resolution change", () => {
  const rows = plant([900], 11).rows.map((row, i) => ({ ...row, room_c: i === 5 ? 80 : 20 }));
  assertEquals(prepareRoomMeanEvidence(rows).count, 1);
  assertEquals(prepareRoomMeanEvidence(rows.slice(0, 6)).count, 0);
  const mixed = rows.map((row, i) => ({ ...row, duration_s: i < 6 ? 900 as const : 3600 as const }));
  assertEquals(prepareRoomMeanEvidence(mixed).count, 0);
});

Deno.test("too few mean observations cannot interpolate more fitted unknowns into an identified model", () => {
  let seed = 123;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  const rows = Array.from({ length: 4 }, (_, i) => ({ start_ms: i * 900000, room_c: 20 + random() * .2,
    outdoor_c: 5 + random(), house_c: 21 + random() * .1, heat_w: random() * 20, solar_w_per_m2: null, cooling: false }));
  assertEquals(fitRoomMeans(rows).ok, false);
});

Deno.test("a sparse empirical fit is published with limited-evidence warnings instead of an undefined AICc gate", () => {
  const truth = plant([3600], 8, 0);
  const result = fitIndependentRoomBand(truth.rows, () => true).result;
  assert(result.ok);
  assert(result.model.response_family !== "equilibrium");
  // Eight observations support an empirical response, not precise recovery
  // of the generating plant's individual coefficients.
  assert(result.model.gain_c_per_wh > 0 && Number.isFinite(result.model.gain_c_per_wh));
  assertEquals(result.model.sample_count, truth.rows.length - 1);
  assertEquals(result.learning_evidence!.observation_intervals, truth.rows.length);
  assertEquals(result.learning_evidence!.response_selection!.criterion, "regularized_marginal_bic");
  assert(result.warnings?.includes("insufficient_samples"));
});

Deno.test("memoryless observations identify equilibrium ratios, not an arbitrary enormous finite exchange", () => {
  // Synthetic instantaneous equilibrium has no finite dynamic time constant.
  const rows = Array.from({ length: 200 }, (_, i) => {
    const power = i % 8 < 4 ? 500 : 0, outdoor = 2 + Math.sin(i / 13), house = 21 + Math.sin(i / 23);
    return { start_ms: i * 900000, room_c: .3 * house + .7 * outdoor + .001 * power + 2,
      outdoor_c: outdoor, house_c: house, heat_w: power, solar_w_per_m2: null, cooling: false };
  });
  assertEquals(fitRoomMeans(rows).ok, false);
});

Deno.test("square-root least squares preserves rank through scaling and column pivoting", () => {
  const matrix = Array.from({ length: 30 }, (_, i) => [1e6 * Math.sin(i), 1, .00001 * Math.cos(i / 3)]);
  const target = matrix.map(row => row[0] * .003 + row[1] * 20 + row[2] * 7);
  const fit = leastSquares(matrix, target);
  assert(fit);
  assertAlmostEquals(fit[0], .003, 1e-12); assertAlmostEquals(fit[1], 20, 1e-10); assertAlmostEquals(fit[2], 7, 1e-7);
  assertEquals(leastSquares(matrix.map(row => [row[0], row[0], row[1]]), target), null);
});

Deno.test("independent bands do not inherit other bands' gain and delayed heat coordinates", () => {
  // Independent piecewise RK4 plant conserves temperature-equivalent stored
  // heat across changing gains/lags. Warm-band power must not be propagated
  // using the cold band's response when the weather next becomes cold.
  let temperature = 19, stored = .4;
  const rows: RoomMeanQuarter[] = [];
  for (let i = 0; i < 400; i++) {
    const cold = i % 40 < 24, gain = cold ? .0015 : .006, lag = cold ? 1 : 3;
    const outdoor = (cold ? -7 : 10) + .4 * Math.sin(i / 13), house = 21 + .2 * Math.cos(i / 19);
    const watts = i % 11 < 3 ? 500 : 0, steps = 300, dt = 1 / steps;
    const rate = (t: number, q: number) => [.02 * (house - t) + .03 * (outdoor - t) + .02 + q / lag,
      gain * watts - q / lag];
    let integral = 0;
    for (let j = 0; j < steps; j++) {
      const a = rate(temperature, stored), b = rate(temperature + a[0] * dt / 2, stored + a[1] * dt / 2);
      const c = rate(temperature + b[0] * dt / 2, stored + b[1] * dt / 2), d = rate(temperature + c[0] * dt, stored + c[1] * dt);
      const next = temperature + dt * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
      integral += (temperature + next) / 2;
      temperature = next; stored += dt * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
    }
    rows.push({ start_ms: i * 3600000, duration_s: 3600, room_c: integral / steps, outdoor_c: outdoor,
      house_c: house, solar_w_per_m2: null, heat_w: watts, cooling: false });
  }
  const result = fitIndependentRoomBand(rows, c => c >= -10 && c < -5).result;
  assert(result.ok);
  assert(result.model.response_family !== "equilibrium");
  assertEquals(result.model.heat_lag_h, 1);
  assertAlmostEquals(result.model.gain_c_per_wh, .0015, 1e-6);
  assertAlmostEquals(result.model.house_coupling_per_h!, .02, 1e-5);
  assertAlmostEquals(result.model.cooling_constant_per_h, .03, 1e-5);
});

Deno.test("immediate and delayed candidates score identical held-out indices after a missing heat interval", () => {
  const truth = plant([3600], 240, 0);
  const rows = truth.rows.map((row, i) => i === 170 ? { ...row, heat_w: null } : row);
  const fitted = fitRoomMeans(rows, 500);
  assert(fitted.ok);
  assertEquals(fitted.model.heat_lag_h, 0);
  // Eighty potential validation transitions, two touch the unknown meter,
  // and the first following transition initializes delayed candidates' heat.
  // It cannot validate only the immediate candidate's prediction.
  assertEquals(fitted.learning_evidence!.validation_pairs, 80 - 2 - 1);
  assertAlmostEquals(fitted.model.gain_c_per_wh, truth.gain, 1e-6);
});

for (const lag of [1, 2]) Deno.test(`one late observed heating pulse can identify a clean ${lag} h floor`, () => {
  // Independent one-second midpoint observations. The fixed training split is
  // before the only pulse, so the full observed response must still identify
  // a real delay rather than defaulting to an instantaneous heater.
  let temperature = 20, delivered = 0;
  const rows: RoomMeanQuarter[] = [];
  for (let i = 0; i < 240; i++) {
    const house = 21 + .1 * Math.sin(i / 14), outdoor = -3 + .3 * Math.sin(i / 13), watts = i === 180 ? 800 : 0;
    let integral = 0;
    for (let second = 0; second < 3600; second++) {
      // Integrate the continuous plant and its mean independently with RK4.
      // Euler's heater step changes the actual time constant off the tested
      // lag grid and can create a fictitious deterministic extra-heat tail.
      const rate = (t: number, d: number) => [.0015 * d + .03 * (outdoor - t) + .02 * (house - t) + .6,
        (watts - d) / lag];
      const dt = 1 / 3600, a = rate(temperature, delivered);
      const b = rate(temperature + a[0] * dt / 2, delivered + a[1] * dt / 2);
      const c = rate(temperature + b[0] * dt / 2, delivered + b[1] * dt / 2);
      const d = rate(temperature + c[0] * dt, delivered + c[1] * dt);
      integral += (temperature + 2 * (temperature + a[0] * dt / 2) +
        2 * (temperature + b[0] * dt / 2) + temperature + c[0] * dt) / 6;
      temperature += dt * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
      delivered += dt * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
    }
    rows.push({ start_ms: i * 3600000, duration_s: 3600, room_c: integral / 3600,
      house_c: house, outdoor_c: outdoor, heat_w: watts, cooling: false, solar_w_per_m2: null });
  }
  const fitted = fitRoomMeans(rows, 800);
  assert(fitted.ok);
  assertEquals(fitted.model.heat_lag_h, lag);
  assertAlmostEquals(fitted.model.gain_c_per_wh, .0015, 1e-6);
  const band = fitIndependentRoomBand(rows, () => true, 800).result;
  assert(band.ok);
  assert(band.model.response_family !== "equilibrium");
  assertEquals(band.model.heat_lag_h, lag);
  assertAlmostEquals(band.model.gain_c_per_wh, .0015, 1e-6);
  assertEquals(band.learning_evidence!.response_selection!.selected, "finite_response");
});

Deno.test("equilibrium fitting does not mistake auxiliary temperature rates for algebraic offsets", () => {
  // Independently generated synthetic equilibrium with continuously varying
  // boundaries and heater power. An external rate has zero temperature effect
  // at the exact zero-capacity limit, rather than becoming a degree offset.
  const rows: RoomMeanQuarter[] = Array.from({ length: 160 }, (_, i) => {
    const house = 21 + Math.sin(i / 23), outdoor = -7 + Math.cos(i / 17), power = i % 9 < 3 ? 500 : 0;
    return { start_ms: i * 3600000, duration_s: 3600,
      room_c: .8 * house + .2 * outdoor + 3 + .006 * power,
      house_c: house, outdoor_c: outdoor, heat_w: power, cooling: false, solar_w_per_m2: null,
      band_forcing_c_per_h: .7 * Math.sin(i / 7) };
  });
  const result = fitIndependentRoomBand(rows, () => true).result;
  assert(result.ok);
  assert(result.model.response_family === "equilibrium");
  assertAlmostEquals(result.model.outdoor_share, .2, 1e-8);
  assertAlmostEquals(result.model.heater_c_per_w, .006, 1e-8);
  assertAlmostEquals(result.model.offset_c, 3, 1e-8);
  assertAlmostEquals(result.model.prediction_error_c!, 0, 1e-8);
});

Deno.test("an identified zero equilibrium heater gain publishes finite diagnostics", () => {
  // Synthetic sensor follows only its boundary temperatures; measured heater
  // pulses are present but have no identifiable contribution to this sensor.
  const rows: RoomMeanQuarter[] = Array.from({ length: 160 }, (_, i) => {
    const house = 21 + Math.sin(i / 23), outdoor = -7 + Math.cos(i / 17), power = i % 9 < 3 ? 500 : 0;
    return { start_ms: i * 3600000, duration_s: 3600,
      room_c: .8 * house + .2 * outdoor + 3,
      house_c: house, outdoor_c: outdoor, heat_w: power, cooling: false, solar_w_per_m2: null };
  });
  const result = fitIndependentRoomBand(rows, () => true).result;
  assert(result.ok);
  assert(result.model.response_family === "equilibrium");
  assertAlmostEquals(result.model.heater_c_per_w, 0, 1e-12);
  assert(Number.isFinite(result.model.prediction_error_c));
  assertEquals(JSON.parse(JSON.stringify(result.model)), result.model);
});
