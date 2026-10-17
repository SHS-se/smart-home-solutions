import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import history from "./pool-response-history.fixture.json" with { type: "json" };
import startup from "../../../src/lib/planner-bench/pool-heater-response.json" with { type: "json" };
import { fitPoolDynamics, poolPartialElectricity, poolPendingHeatAt, type PoolDynamics } from "./pool-dynamics.ts";
import { stepPool, stepPoolThermal, parseHeaterResponse, type HeaterState } from "./planner/device-models.ts";
import { poolPhysics } from "./planner/pool-physics.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import type { PoolResponseSample } from "./pool-training.ts";

const CAPACITY = 63.965;
const recorded: PoolResponseSample[] = history.energy.map((electrical_kwh, i) => ({
  start_ms: history.start * 1000 + i * 900_000, water_temperature_c: history.temperature[i],
  next_water_temperature_c: history.temperature[i + 1], electrical_kwh,
}));
function fitted(samples: PoolResponseSample[]) {
  const result = fitPoolDynamics(samples, CAPACITY);
  assert("fitted" in result);
  return result.fitted;
}
function synthetic(tau: number) {
  const store = { capacity_kwh_per_c: CAPACITY, response_time_constant_h: tau,
    loss: { kind: "measured" as const, points: [{ at_c: 30, c_per_h: -.04 }] } };
  let state = { water_c: 30, pending_heat_kwh: 6 };
  return Array.from({ length: 240 }, (_, i) => {
    const power = i % 48 < 16 ? 3 : i % 48 < 20 ? 1 : 0;
    const before = state.water_c;
    state = stepPoolThermal(store, state, power * 4.2 * 1000, power * 4.2 * 1000, 0, .25);
    return { start_ms: i * 900_000, water_temperature_c: before, next_water_temperature_c: state.water_c, electrical_kwh: power * .25 };
  });
}

Deno.test("pool dynamics jointly identifies lag, gain, cooling and unknown starting response", () => {
  const model = fitted(synthetic(.7));
  assertAlmostEquals(model.response_time_constant_h, .7, 1e-5);
  assertAlmostEquals(model.heat_c_per_kwh * CAPACITY, 4.2, 1e-5);
  assertAlmostEquals(model.idle_c_per_h, -.04, 1e-6);
  assert(model.rmse_c < 1e-7);
  assert(model.instantaneous_rmse_c !== null && model.rmse_c < model.instantaneous_rmse_c / 100);
});

Deno.test("the instantaneous model remains a nested physical model when history has no lag", () => {
  const samples = synthetic(0);
  // A direct model flushes the intentionally unknown initial pending amount
  // immediately. Its discontinuity is outside a direct-response calibration.
  const model = fitted(samples.slice(1));
  assertEquals(model.response_time_constant_h, 0);
  assertAlmostEquals(model.heat_c_per_kwh * CAPACITY, 4.2, 1e-8);
  assertAlmostEquals(model.idle_c_per_h, -.04, 1e-8);
  const lossless = fitted(samples.map((s, i) => ({ ...s, water_temperature_c: s.water_temperature_c + i * .01,
    next_water_temperature_c: s.next_water_temperature_c + (i + 1) * .01 })).slice(1));
  assertEquals(lossless.response_time_constant_h, 0);
  assertAlmostEquals(lossless.idle_c_per_h, 0, 1e-12);
  assert(lossless.rmse_c < 1e-10);
  assert("rejected" in fitPoolDynamics(samples, Infinity));
});

Deno.test("lossless direct heating is fitted on the zero-cooling boundary without inventing lag", () => {
  let water = 29;
  const samples = Array.from({ length: 240 }, (_, i) => {
    const electrical_kwh = i % 16 < 8 ? .75 : 0, before = water;
    water += .08 * electrical_kwh;
    return { start_ms: i * 900_000, water_temperature_c: before, next_water_temperature_c: water, electrical_kwh };
  });
  const model = fitted(samples);
  assertEquals(model.response_time_constant_h, 0);
  assertAlmostEquals(model.heat_c_per_kwh, .08, 1e-12);
  assertEquals(model.idle_c_per_h, -0);
  assert(model.rmse_c < 1e-12);
});

Deno.test("fragmented noisy history can release an initial-memory coefficient from its boundary", () => {
  const energy = [[0, 0, .5, 0, .5, 1, 1, 1], [0, 0, 0, 0, .5, .5, 0, 0], [.5, 0, 0, .5, .5, 0, .5, 1]];
  const changes = [
    [-.0679349027198387, -.03971918730003488, .037518370192063624, -.027735150095172398, .01802678765114521, .03945293810901761, .029426710867693183, .046110401964051154],
    [.02154691373124688, -.025648198711194774, -.025665256183205247, -.016374569686764005, .007721762970206783, .041618108994498734, -.017171024624561448, -.034661630071912905],
    [.0034254027997468253, -.026070860710338536, .039677210843990514, -.005539536235441685, .03157224352260231, .022943749018761346, .01567636762912383, .048495211295573104],
  ];
  const samples = energy.flatMap((entries, day) => {
    let water = 30;
    return entries.map((electrical_kwh, i) => {
      const before = water; water += changes[day][i];
      return { start_ms: day * 86_400_000 + i * 900_000, water_temperature_c: before, next_water_temperature_c: water, electrical_kwh };
    });
  });
  const model = fitted(samples);
  // Independently enumerating all nuisance active sets at tau=.6 gives a
  // feasible SSE=.02657063844 over 39 quarter/hour observations. The old
  // permanent-clamp algorithm scored .02760 even after searching over tau.
  assert(model.rmse_c ** 2 * 39 <= .026570639, `constrained SSE ${model.rmse_c ** 2 * 39}`);
});

Deno.test("invalid rows are ignored individually and gaps have independently fitted memory", () => {
  const samples = synthetic(.7);
  const broken = [...samples.slice(0, 80), { ...samples[80], electrical_kwh: NaN }, ...samples.slice(81)];
  const model = fitted(broken);
  assertEquals(model.sample_count, samples.length - 1);
  assertAlmostEquals(model.response_time_constant_h, .7, 1e-4);
  assertEquals(fitPoolDynamics([], CAPACITY), { rejected: "unidentifiable", sample_count: 0 });
  assert("rejected" in fitPoolDynamics(samples.map(s => ({ ...s, electrical_kwh: 0 })), CAPACITY));
});

function modelForRun(model: PoolDynamics) {
  const response = parseHeaterResponse(startup);
  assert(response.kind === "bergvarme");
  return { store: { capacity_kwh_per_c: CAPACITY, response_time_constant_h: model.response_time_constant_h,
    loss: { kind: "measured" as const, points: [{ at_c: model.reference_c, c_per_h: model.idle_c_per_h }] } },
    heater: { compressor_w: 2990.5, auxiliary_w: 760, heat_w: model.heat_c_per_kwh * CAPACITY * 2990.5,
      response: { ...response, startup: response.startup.map(p => ({ ...p, heat_fraction: p.electric_fraction })) } } };
}
function predictRecordedRun(model: PoolDynamics) {
  const { store, heater } = modelForRun(model);
  let water = 29.64, pending = 0, state: HeaterState = { kind: "off_unobserved" };
  const temperatures: number[] = [];
  let compressorKwh = 0;
  for (let i = 0; i < 11; i++) {
    const q = stepPool(store, heater, state, i < 3, { water_c: water, pending_heat_kwh: pending, outdoor_c: 0, seconds: 900, stop_c: 34 });
    water = q.water_c; pending = q.pending_heat_kwh; state = q.next;
    compressorKwh += q.compressor_w * .25 / 1000;
    temperatures.push(water);
  }
  return { temperatures, compressorKwh };
}

Deno.test("held-out 13 October short run and tail improve without a runtime or zero-heat period", () => {
  const start = Date.parse("2026-10-13T11:30:00Z"), end = Date.parse("2026-10-13T17:30:00Z");
  const model = fitted(recorded.filter(s => s.start_ms < start || s.start_ms >= end));
  const prediction = predictRecordedRun(model);
  const shutdown = prediction.temperatures[2];
  assert(Math.abs(shutdown - 29.65) < .015, `shutdown ${shutdown}`);
  assert(Math.abs(prediction.temperatures[10] - 29.64) < .02, "shutdown tail remains close after 2¾ hours");
  assert(prediction.temperatures[0] > 29.64 + model.idle_c_per_h * .25, "even the first quarter has a positive heat contribution");
  assertAlmostEquals(prediction.compressorKwh, 1.8435793280625, 1e-10);
  assert(model.instantaneous_rmse_c !== null && model.rmse_c < model.instantaneous_rmse_c);
});

Deno.test("leaving each complete day out improves hourly changes over direct response", () => {
  for (const day of [12, 13, 14, 15, 16, 17]) {
    const dayAt = (s: PoolResponseSample) => new Date(s.start_ms + 7_200_000).getUTCDate();
    const model = fitted(recorded.filter(s => dayAt(s) !== day));
    const fitStore = modelForRun(model).store, direct = { ...fitStore, response_time_constant_h: 0 };
    let response = { water_c: recorded[0].water_temperature_c, pending_heat_kwh: 3 * model.heat_c_per_kwh * CAPACITY * model.response_time_constant_h };
    const release = [0], instant = [0];
    for (const s of recorded) {
      const before = response.water_c;
      response = stepPoolThermal(fitStore, response, s.electrical_kwh * 4 * model.heat_c_per_kwh * CAPACITY * 1000,
        s.electrical_kwh * 4 * model.heat_c_per_kwh * CAPACITY * 1000, 0, .25);
      release.push(release.at(-1)! + response.water_c - before);
      const q = stepPoolThermal(direct, { water_c: 0, pending_heat_kwh: 0 },
        s.electrical_kwh * 4 * model.heat_c_per_kwh * CAPACITY * 1000,
        s.electrical_kwh * 4 * model.heat_c_per_kwh * CAPACITY * 1000, 0, .25);
      instant.push(instant.at(-1)! + q.water_c);
    }
    let delayedError = 0, directError = 0;
    for (let i = 0; i + 4 <= recorded.length; i++) if (recorded.slice(i, i + 4).every(s => dayAt(s) === day)) {
      const actual = recorded[i + 3].next_water_temperature_c - recorded[i].water_temperature_c;
      delayedError += (release[i + 4] - release[i] - actual) ** 2;
      directError += (instant[i + 4] - instant[i] - actual) ** 2;
    }
    assert(delayedError < directError, `held-out day ${day}: ${delayedError} vs ${directError}`);
  }
});

Deno.test("capture reconstructs heat through shutdown, missing quarters and partial intervals", () => {
  const model = fitted(synthetic(.7));
  model.state = { at: "2026-10-13T12:00:00Z", pending_heat_kwh: 6 };
  const start = Date.parse(model.state.at), tau = model.response_time_constant_h;
  assertAlmostEquals(poolPendingHeatAt(model, CAPACITY, [], start + 900_000), 6 * Math.exp(-.25 / tau), 1e-10);
  const intervals = [{ start_ms: start, hours: .25, electrical_kwh: .75 }];
  const end = poolPendingHeatAt(model, CAPACITY, intervals, start + 900_000);
  const halfway = poolPendingHeatAt(model, CAPACITY, intervals, start + 450_000);
  assert(halfway > 6 && end > halfway);
  assertAlmostEquals(poolPendingHeatAt(model, CAPACITY, intervals, start + 1800_000), end * Math.exp(-.25 / tau), 1e-10);
  const continued = { ...model, state: { at: new Date(start + 900_000).toISOString(), pending_heat_kwh: end } };
  assertAlmostEquals(poolPendingHeatAt(continued, CAPACITY, intervals, start + 1800_000), poolPendingHeatAt(model, CAPACITY, intervals, start + 1800_000), 1e-10);
});

Deno.test("shared publication uses the electric-trained response once and preserves startup draw", () => {
  const model = fitted(recorded), snapshot = dispatchedEvSnapshot();
  snapshot.pool = { water_temperature_c: 29.64, volume_m3: 55 };
  snapshot.pool_model = { thermal_dynamics: model, heater_response: parseHeaterResponse(startup), loss_kw_per_k: null, rated_cop: null, cop_per_air_c: null };
  const physics = poolPhysics(snapshot);
  assertEquals(physics.store.response_time_constant_h, model.response_time_constant_h);
  assertAlmostEquals(physics.heater.heat_w / physics.heater.compressor_w, model.heat_c_per_kwh * CAPACITY);
  assert(physics.heater.response.kind === "bergvarme");
  assert(physics.heater.response.startup.every(p => p.heat_fraction === p.electric_fraction));
  assertEquals(snapshot.pool_model.heater_response, parseHeaterResponse(startup), "publication never mutates captured calibration");
});

Deno.test("an older capture uses its earlier fitted checkpoint, never a future heat state", () => {
  const model = fitted(synthetic(.7));
  model.initial_state = { at: "2026-10-13T12:00:00Z", pending_heat_kwh: 3 };
  model.state = { at: "2026-10-13T13:00:00Z", pending_heat_kwh: 9 };
  const at = Date.parse("2026-10-13T12:30:00Z");
  assertAlmostEquals(poolPendingHeatAt(model, CAPACITY, [], at), 3 * Math.exp(-.5 / model.response_time_constant_h), 1e-10);
  assertThrows(() => poolPendingHeatAt(model, CAPACITY, [], at - 3_600_000), Error, "no observed starting state");
  assertThrows(() => poolPendingHeatAt({ ...model, state: { at: model.state.at, pending_heat_kwh: NaN } }, CAPACITY, [], at), Error, "malformed");
});

Deno.test("current-quarter actuator history retains completed runs and every observed cycle", () => {
  const at = Date.parse("2026-10-13T12:40:00Z");
  const pool = { water_temperature_c: 29.64, volume_m3: 55, heating_running: false,
    heating_history: { start: "2026-10-13T12:30:00Z", end: "2026-10-13T12:40:00Z", complete: true,
      intervals: [
        { start: "2026-10-13T12:30:00Z", end: "2026-10-13T12:35:00Z", elapsed_seconds_at_start: 1800, elapsed_basis: "confirmed_transition" as const },
        { start: "2026-10-13T12:36:00Z", end: "2026-10-13T12:38:00Z", elapsed_seconds_at_start: 0, elapsed_basis: "confirmed_transition" as const },
      ] } };
  const partial = poolPartialElectricity(pool, parseHeaterResponse(startup), 2990.5, at);
  assertEquals(partial.source, "actuator_history");
  assertEquals(partial.complete, true);
  assertEquals(partial.intervals.length, 2);
  assertAlmostEquals(partial.intervals[0].electrical_kwh, 2990.5 / 1000 / 12, 1e-12);
  assertEquals(partial.intervals[1].electrical_kwh, 0, "actual electrical startup still applies to the second run");
  const model = fitted(synthetic(.7));
  model.state = { at: pool.heating_history.start, pending_heat_kwh: 0 };
  assert(poolPendingHeatAt(model, CAPACITY, partial.intervals, at) > 0, "stopped run must not lose its pending response");
  const incomplete = poolPartialElectricity({ ...pool, heating_history: { ...pool.heating_history, complete: false } }, parseHeaterResponse(startup), 2990.5, at);
  assertEquals(incomplete.intervals, partial.intervals);
  assertEquals(incomplete.complete, false, "incomplete coverage is evidence, not a gate that discards known runs");
  const invalid = JSON.parse(JSON.stringify(pool));
  invalid.heating_history.intervals.push(null, { start: "bad", end: "bad", elapsed_seconds_at_start: 0 });
  const retained = poolPartialElectricity(invalid, parseHeaterResponse(startup), 2990.5, at);
  assertEquals(retained.intervals, partial.intervals);
  assertEquals(retained.ignored, 2);
  assertEquals(retained.complete, false);
  const direct = poolPartialElectricity({ water_temperature_c: 30, volume_m3: 55, heating_running: true, heating_elapsed_seconds: 600 }, { kind: "steady" }, 3000, at);
  assertAlmostEquals(direct.intervals[0].electrical_kwh, .5, 1e-12);
  assertEquals(direct.complete, false);
});
