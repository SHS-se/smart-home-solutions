import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fitMeasuredRoomCalibration } from "./measured-calibration.ts";
import { syntheticImmediateInterval, syntheticOperationRoom } from "./measured-calibration.fixture.ts";
import { measureRoomRuns } from "./run-measurements.ts";
import { excludeUncontrolledRoomHeat, roomHeaterGain, roomTransition } from "../../planner/models/room/thermal.ts";

function fitted(plant: ReturnType<typeof syntheticOperationRoom>) {
  const fit = fitMeasuredRoomCalibration(plant.rows, 600);
  assert(fit.kind === "identified", JSON.stringify(fit));
  return fit;
}
function recovers(plant: ReturnType<typeof syntheticOperationRoom>) {
  const fit = fitted(plant), model = fit.model;
  assertAlmostEquals(model.cooling_constant_per_h, plant.outdoorK, 1e-6);
  assertAlmostEquals(model.house_coupling_per_h!, plant.houseK, 1e-6);
  assertAlmostEquals(model.background_gain_c_per_h, plant.background, 1e-6);
  for (const outdoor of [-2, 5, 12]) assertAlmostEquals(roomHeaterGain(model, outdoor),
    plant.gain * (1 + plant.weatherSlope * (outdoor - plant.reference)), 1e-8);
  const referenceGain = plant.gain * (1 + plant.weatherSlope * (model.gain_reference_outdoor_c! - plant.reference));
  assertAlmostEquals(fit.evidence.uncredited_background_w!, Math.max(0, plant.background) / referenceGain, .001);
  assert(fit.evidence.conditional_residual_std_c! < 1e-7);
  return fit;
}

Deno.test("native operation calibration recovers exact quarter, hour and mixed means", () => {
  for (const durations of [[900], [3600], [900, 3600, 900, 900]] as const) recovers(syntheticOperationRoom({ durations }));
});

Deno.test("OFF-class standby remains measured electricity in native calibration", () => {
  const zero = syntheticOperationRoom(), standby = syntheticOperationRoom({ standbyW: 30 });
  const fit = recovers(standby);
  assert(fit.evidence.measured_wh > fitted(zero).evidence.measured_wh);
  assert(fit.evidence.off_pairs > 0);
});

Deno.test("nonnegative coupling faces and constant gain are actual physical solutions", () => {
  recovers(syntheticOperationRoom({ outdoorK: 0, weatherSlope: 0 }));
  recovers(syntheticOperationRoom({ houseK: 0, weatherSlope: 0 }));
  const constantWeather = syntheticOperationRoom({ outdoorC: () => 5, weatherSlope: 0 });
  const fit = recovers(constantWeather);
  assertEquals(fit.model.gain_outdoor_slope_per_c, 0);
});

Deno.test("each complete operation balances its powered and whole-coast support by energy", () => {
  const plant = syntheticOperationRoom(), fit = recovers(plant), evidence = fit.evidence;
  assertAlmostEquals(evidence.weighted_powered_support_kwh, evidence.weighted_coast_support_kwh, 1e-10);
  assertAlmostEquals(evidence.weighted_powered_support_kwh, evidence.measured_wh / 1000, 1e-10);
  assert(evidence.off_pairs > evidence.heater_input_pairs * 4);
  assert(evidence.operation_spans > 0);
});

Deno.test("unanchored passive history cannot dominate an observed operation calibration", () => {
  const plant = syntheticOperationRoom(), before = fitted(plant);
  const prefix: typeof plant.rows = Array.from({ length: 96 * 90 }, (_, i) => ({ ...plant.rows[0],
    start_ms: plant.rows[0].start_ms - (96 * 90 - i) * 900_000, heat_w: 0,
    room_c: 35 + Math.sin(i / 23), outdoor_c: 30, house_c: 32 }));
  // End the passive prehistory before the single adjacent pre-ON mean owned by the operation.
  prefix[prefix.length - 1].heat_w = null;
  const after = fitMeasuredRoomCalibration([...prefix, ...plant.rows], 600);
  assert(after.kind === "identified");
  assertEquals(after.model, before.model);
  assert(after.evidence.unanchored_off_pairs > 8000);
});

Deno.test("temperature holes remove phase weight without concentrating missing evidence", () => {
  const plant = syntheticOperationRoom(), complete = fitted(plant);
  const hole = structuredClone(plant);
  hole.rows[25].room_c = null;
  const partial = fitted(hole);
  assertEquals(partial.evidence.unavailable_pairs.room, 2);
  assertAlmostEquals(partial.evidence.weighted_powered_support_kwh, complete.evidence.weighted_powered_support_kwh, 1e-10);
  assert(partial.evidence.weighted_coast_support_kwh < complete.evidence.weighted_coast_support_kwh);
  recovers(hole);
});

Deno.test("late tails, missing counters, unknown direction and real holes repair from native observations", () => {
  const plant = syntheticOperationRoom(), complete = fitted(plant);
  const variants = [plant.rows.slice(0, -1), structuredClone(plant.rows), structuredClone(plant.rows),
    plant.rows.filter((_, i) => i !== 145)];
  variants[1][145].heat_w = null;
  variants[2][145].cooling = null;
  for (const rows of variants) {
    const partial = fitMeasuredRoomCalibration(rows, 600);
    assert(partial.kind === "identified");
    assert(partial.evidence.fitted_pairs < complete.evidence.fitted_pairs);
    assertAlmostEquals(roomHeaterGain(partial.model, 5), plant.gain, 1e-8);
  }
  assertEquals(fitMeasuredRoomCalibration(plant.rows, 600), complete);
});

Deno.test("observed ON fragments and unfinished ON tails do not require complete runs", () => {
  const plant = syntheticOperationRoom(), rows = plant.rows.slice(1, 725);
  // Starts inside the first ON block and ends during a later metered operation.
  const fit = fitMeasuredRoomCalibration(rows, 600);
  assert(fit.kind === "identified");
  assertAlmostEquals(roomHeaterGain(fit.model, 5), plant.gain, 1e-8);
  assert(fit.evidence.heater_input_pairs > 0);
});

Deno.test("zero input and inseparable input/background cannot invent a heater response", () => {
  const zero = fitMeasuredRoomCalibration(syntheticOperationRoom({ watts: () => 0 }).rows, 600);
  assertEquals(zero.kind, "unidentified");
  const constant = fitMeasuredRoomCalibration(syntheticOperationRoom({ watts: () => 100, weatherSlope: 0 }).rows, 600);
  assertEquals(constant.kind, "unidentified");
});

Deno.test("late unrelated warming can move descriptive peaks without extending heater support", () => {
  const clean = syntheticOperationRoom();
  const warm = syntheticOperationRoom({ extraHeat: hour => hour >= 104 && hour < 106 ? 4 : 0 });
  const before = fitted(clean), after = fitted(warm);
  assertEquals(after.evidence.heater_input_pairs, before.evidence.heater_input_pairs);
  assertEquals(after.evidence.weighted_powered_support_kwh, before.evidence.weighted_powered_support_kwh);
  const cleanRun = measureRoomRuns(clean.rows).find(run => run.on_ms === clean.rows[96 * 4].start_ms);
  const warmRun = measureRoomRuns(warm.rows).find(run => run.on_ms === warm.rows[96 * 4].start_ms);
  assert(cleanRun?.heating && warmRun?.heating);
  assert(warmRun.heating.peak_ms > cleanRun.heating.peak_ms + 6 * 3_600_000);
  // One unrelated disturbance in ten days must not become intrinsic delivered heat.
  assertAlmostEquals(roomHeaterGain(after.model, 5), clean.gain, 0.00002);
});

Deno.test("training calibration cannot read altered held-out observations or prior fitted state", () => {
  const plant = syntheticOperationRoom(), prefix = plant.rows.slice(0, 720);
  const observed = structuredClone(plant.rows);
  const first = fitMeasuredRoomCalibration(prefix, 600);
  assertEquals(plant.rows, observed, "fitting leaves source measurements unchanged");
  for (const row of plant.rows.slice(720)) { row.room_c = 40; row.heat_w = 900; }
  fitMeasuredRoomCalibration(plant.rows, 900);
  assertEquals(fitMeasuredRoomCalibration(prefix, 600), first);
});

Deno.test("delayed synthetic heat remains a visible mismatch rather than a new lag or solar model", () => {
  const immediate = fitted(syntheticOperationRoom());
  const delayed = fitted(syntheticOperationRoom({ lagHours: 1 }));
  assertEquals(delayed.model.heat_lag_h, 0);
  assertEquals(delayed.model.solar_gain_c_per_h_per_wm2, null);
  assert(delayed.evidence.first_post_off_pairs > 0);
  assert(delayed.evidence.first_post_off_bias_c! > 0);
  assert(delayed.evidence.conditional_residual_std_c! > immediate.evidence.conditional_residual_std_c!);
  // An error sign or a small gain does not assert correct energy for a delayed plant.
});

Deno.test("compiled immediate calibration uses the correct electricity at the same achieved comfort", () => {
  const plant = syntheticOperationRoom({ background: 0 }), fit = fitted(plant);
  const model = excludeUncontrolledRoomHeat(fit.model), target = 20;
  assert(model.response_family === "finite");
  let actual = target, plannedWh = 0, oracleWh = 0;
  for (let i = 0; i < 96; i++) {
    const outdoor = 5 + 4 * Math.sin(i / 21), house = 20 + .5 * Math.sin(i / 13), hours = .25;
    const op = roomTransition(model, { hours, outdoor_c: outdoor, house_c: house, background_c_per_h: model.background_gain_c_per_h });
    const watts = (target - op.decay * actual - op.offset_c) / op.gain_c_per_w;
    assert(watts > 0 && watts < 600);
    const trueGain = plant.gain * (1 + plant.weatherSlope * (outdoor - plant.reference));
    const oracle = (plant.outdoorK * (target - outdoor) + plant.houseK * (target - house)) / trueGain;
    actual = syntheticImmediateInterval(actual, hours, plant.outdoorK * outdoor + plant.houseK * house + trueGain * watts,
      plant.outdoorK + plant.houseK).end;
    assertAlmostEquals(actual, target, 1e-6);
    plannedWh += watts * hours; oracleWh += oracle * hours;
  }
  assertAlmostEquals(plannedWh, oracleWh, .01);
});

Deno.test("whole native coasts learn slower late cooling and warming toward the house", () => {
  const plant = syntheticOperationRoom({ initialC: 12, background: -.04 });
  const fit = recovers(plant), model = fit.model, outdoor = 5, house = 20;
  for (const entry of [25, 10]) {
    let actual = entry, predicted = entry, firstChange = 0, lastChange = 0;
    for (let hour = 0; hour < 18; hour++) {
      const op = roomTransition(model, { hours: 1, outdoor_c: outdoor, house_c: house,
        background_c_per_h: model.background_gain_c_per_h });
      predicted = op.decay * predicted + op.offset_c;
      const next = syntheticImmediateInterval(actual, 1, plant.outdoorK * outdoor + plant.houseK * house + plant.background,
        plant.outdoorK + plant.houseK).end;
      const change = next - actual;
      if (hour === 0) firstChange = change;
      lastChange = change; actual = next;
      assertAlmostEquals(predicted, actual, 1e-5);
    }
    assert(Math.abs(lastChange) < Math.abs(firstChange));
    assert(entry === 25 ? firstChange < 0 : firstChange > 0);
  }
});
