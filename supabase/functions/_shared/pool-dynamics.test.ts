import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import history from "./pool-response-history.fixture.json" with { type: "json" };
import startup from "../../../src/lib/planner-bench/pool-heater-response.json" with { type: "json" };
import { fitPoolDynamics, type PoolDynamics } from "./device-learning/pool/response.ts";
import { poolPartialElectricity, poolResponseStateAt } from "./planner/models/pool/state.ts";
import { stepPool, stepPoolThermal, parseHeaterResponse, type HeaterState } from "./planner/device-models.ts";
import { poolPhysics } from "./planner/pool-physics.ts";
import { PoolSourceKernel } from "./planner/device-models.ts";
import { poolHeatGain } from "./planner/pool-response.ts";
import { dispatchedEvSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import type { PoolResponseSample } from "./device-learning/pool/thermal.ts";

// These reservoir tests explicitly supply observed OFF intervals between the
// stated heating intervals. The production reconstructor never invents them.
const poolPendingHeatAt = (model: PoolDynamics, capacity: number, history: Parameters<typeof poolResponseStateAt>[2], at: number) => {
  let cursor = Date.parse(model.state.at) <= at ? Date.parse(model.state.at) : Date.parse(model.initial_state.at);
  const intervals = [];
  for (const row of history) {
    if (row.start_ms > cursor) intervals.push({start_ms:cursor,hours:(row.start_ms-cursor)/3_600_000,electrical_kwh:0});
    intervals.push(row); cursor = row.start_ms + row.hours * 3_600_000;
  }
  if (at > cursor) intervals.push({start_ms:cursor,hours:(at-cursor)/3_600_000,electrical_kwh:0});
  return poolResponseStateAt(model, capacity, intervals, at).pending_heat_kwh;
};
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
  let state = { water_c: 30, pending_heat_kwh: 6, source_depletion_kwh: 0 };
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
  // A constant gain leaves the run-age fade at (numerically) nothing.
  assertAlmostEquals(model.heat_c_per_kwh * CAPACITY, 4.2, 1e-4);
  assert(!model.source || model.source.heat_loss_c_per_kwh_per_kwh * 3 / model.source.recovery_rate_per_h < model.heat_c_per_kwh * 1e-5);
  assertAlmostEquals(model.idle_c_per_h, -.04, 1e-6);
  assert(model.rmse_c < 1e-7);
  assert(model.instantaneous_rmse_c !== null && model.rmse_c < model.instantaneous_rmse_c / 100);
});

Deno.test("measured electricity identifies gradual source recovery and unknown initial depletion", () => {
  const source = { recovery_rate_per_h: .15, heat_loss_per_kwh: .02 };
  const kernel = new PoolSourceKernel(CAPACITY, .5, source, 4.2);
  let state = { water_c: 30, pending_heat_kwh: 6, source_depletion_kwh: 9 };
  const samples = Array.from({length: 480}, (_, i) => {
    const power = i % 96 < 40 ? 3 : i % 96 < 48 ? 1 : 0, before = state.water_c;
    state = kernel.piece(state.water_c, state.pending_heat_kwh, state.source_depletion_kwh, power, 0, .25, -.04);
    return {start_ms: i * 900_000, water_temperature_c: before, next_water_temperature_c: state.water_c, electrical_kwh: power / 4};
  });
  const model = fitted(samples);
  assert(model.source);
  assertAlmostEquals(model.response_time_constant_h, .5, .002);
  assertAlmostEquals(model.source.recovery_rate_per_h, .15, .002);
  assertAlmostEquals(model.source.heat_loss_c_per_kwh_per_kwh / model.heat_c_per_kwh, .02, .0001);
  assertAlmostEquals(model.initial_state.source_depletion_kwh, 9, .03);
  assertAlmostEquals(model.initial_state.pending_heat_kwh, 6, .03);
  const fragmented = fitted(samples.filter((_, i) => i < 120 || i >= 128));
  assert(fragmented.source);
  assertAlmostEquals(fragmented.source.recovery_rate_per_h, .15, .002);
  assert(fragmented.rmse_c < .00001);
  assert(model.rmse_c < .00001);
  const start = Date.parse(model.state.at), d = model.state.source_depletion_kwh;
  const short = poolResponseStateAt(model, CAPACITY, [{start_ms:start,hours:.25,electrical_kwh:0}], start + 900_000);
  const long = poolResponseStateAt(model, CAPACITY, [{start_ms:start,hours:5,electrical_kwh:0}], start + 18_000_000);
  assert(short.source_depletion_kwh > d * .95);
  assert(long.source_depletion_kwh < short.source_depletion_kwh);
  assert(poolHeatGain(model, long.source_depletion_kwh) > poolHeatGain(model, short.source_depletion_kwh));
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
      source: model.source ? { recovery_rate_per_h: model.source.recovery_rate_per_h, heat_loss_per_kwh: model.source.heat_loss_c_per_kwh_per_kwh / model.heat_c_per_kwh } : null,
      response: { ...response, startup: response.startup.map(p => ({ ...p, heat_fraction: p.electric_fraction })) } } };
}
function predictRecordedRun(model: PoolDynamics) {
  const { store, heater } = modelForRun(model);
  const memory = poolResponseStateAt(model, CAPACITY, recorded.map(s => ({start_ms:s.start_ms,hours:.25,electrical_kwh:s.electrical_kwh})), Date.parse("2026-10-13T11:30:00Z"));
  let water = 29.64, pending = memory.pending_heat_kwh, depletion = memory.source_depletion_kwh, state: HeaterState = { kind: "off_unobserved" };
  const temperatures: number[] = [];
  let compressorKwh = 0;
  for (let i = 0; i < 11; i++) {
    const q = stepPool(store, heater, state, i < 3, { water_c: water, pending_heat_kwh: pending, source_depletion_kwh: depletion, outdoor_c: 0, seconds: 900, stop_c: 34 });
    water = q.water_c; pending = q.pending_heat_kwh; depletion = q.source_depletion_kwh ?? 0; state = q.next;
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
  for (const day of [13, 14, 15, 16, 17]) {
    const dayAt = (s: PoolResponseSample) => new Date(s.start_ms + 7_200_000).getUTCDate();
    const model = fitted(recorded.filter(s => dayAt(s) !== day));
    const fitStore = modelForRun(model).store, direct = { ...fitStore, response_time_constant_h: 0 };
    let response = { water_c: recorded[0].water_temperature_c, pending_heat_kwh: 3 * model.heat_c_per_kwh * CAPACITY * model.response_time_constant_h };
    const release = [0], instant = [0];
    let depletion = model.initial_state.source_depletion_kwh;
    const kernel = new PoolSourceKernel(CAPACITY, model.response_time_constant_h, {recovery_rate_per_h: model.source?.recovery_rate_per_h ?? 1, heat_loss_per_kwh: model.source ? model.source.heat_loss_c_per_kwh_per_kwh / model.heat_c_per_kwh : 0}, model.heat_c_per_kwh * CAPACITY);
    for (const s of recorded) {
      const before = response.water_c, heatW = s.electrical_kwh * 4 * poolHeatGain(model, depletion) * CAPACITY * 1000;
      const next = kernel.piece(response.water_c, response.pending_heat_kwh, depletion, s.electrical_kwh * 4, 0, .25, model.idle_c_per_h);
      response = next; depletion = next.source_depletion_kwh;
      release.push(release.at(-1)! + response.water_c - before);
      const q = stepPoolThermal(direct, { water_c: 0, pending_heat_kwh: 0 }, heatW, heatW, 0, .25);
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
  model.state = { at: "2026-10-13T12:00:00Z", pending_heat_kwh: 6, source_depletion_kwh: 0 };
  const start = Date.parse(model.state.at), tau = model.response_time_constant_h;
  assertAlmostEquals(poolPendingHeatAt(model, CAPACITY, [], start + 900_000), 6 * Math.exp(-.25 / tau), 1e-10);
  const intervals = [{ start_ms: start, hours: .25, electrical_kwh: .75 }];
  const end = poolPendingHeatAt(model, CAPACITY, intervals, start + 900_000);
  const halfway = poolPendingHeatAt(model, CAPACITY, intervals, start + 450_000);
  assert(halfway > 6 && end > halfway);
  assertAlmostEquals(poolPendingHeatAt(model, CAPACITY, intervals, start + 1800_000), end * Math.exp(-.25 / tau), 1e-10);
  const continued = { ...model, state: { at: new Date(start + 900_000).toISOString(), pending_heat_kwh: end, source_depletion_kwh: 0 } };
  assertAlmostEquals(poolPendingHeatAt(continued, CAPACITY, intervals, start + 1800_000), poolPendingHeatAt(model, CAPACITY, intervals, start + 1800_000), 1e-10);
});

Deno.test("shared publication uses the electric-trained response once and preserves startup draw", () => {
  const model = fitted(recorded), snapshot = dispatchedEvSnapshot();
  snapshot.pool = { water_temperature_c: 29.64, volume_m3: 55 };
  // This thermal/startup assertion supplies equipment capability independently;
  // thermal calibration no longer grants electrical permission to a missing device.
  snapshot.device_models.push({ key: "synthetic-compressor", name: "Synthetic compressor", statistic_id: "sensor.synthetic_compressor",
    category: "pool", suggested_load_type: "binary", load_type: "binary", planning_role: "controllable", control_type: "switch_schedule",
    planning_service: "pool", pool_role: "heater", active_power_w: 3000, profile_sample_count: 100,
    forecast_w_by_slot: snapshot.slots.map(() => 3000) });
  snapshot.pool_model = { thermal_dynamics: model, heater_response: parseHeaterResponse(startup), loss_kw_per_k: null, rated_cop: null, cop_per_air_c: null };
  const physics = poolPhysics(snapshot);
  assertEquals(physics.store.response_time_constant_h, model.response_time_constant_h);
  assert(physics.heater.response.kind === "bergvarme");
  const curve = physics.heater.response.startup;
  assertAlmostEquals(physics.heater.heat_w / physics.heater.compressor_w, model.heat_c_per_kwh * CAPACITY);
  assertEquals(curve.map(p => p.heat_fraction), curve.map(p => p.electric_fraction));
  assertEquals(physics.heater.source?.recovery_rate_per_h ?? null, model.source?.recovery_rate_per_h ?? null);
  const original = parseHeaterResponse(startup);
  assert(original.kind === "bergvarme");
  assertEquals(curve.slice(0, original.startup.length).map(p => [p.elapsed_seconds, p.electric_fraction]),
    original.startup.map(p => [p.elapsed_seconds, p.electric_fraction]), "startup draw is preserved");
  assertEquals(snapshot.pool_model.heater_response, parseHeaterResponse(startup), "publication never mutates captured calibration");
});

Deno.test("an older capture uses its earlier fitted checkpoint, never a future heat state", () => {
  const model = fitted(synthetic(.7));
  model.initial_state = { at: "2026-10-13T12:00:00Z", pending_heat_kwh: 3, source_depletion_kwh: 0 };
  model.state = { at: "2026-10-13T13:00:00Z", pending_heat_kwh: 9, source_depletion_kwh: 0 };
  const at = Date.parse("2026-10-13T12:30:00Z");
  assertAlmostEquals(poolPendingHeatAt(model, CAPACITY, [], at), 3 * Math.exp(-.5 / model.response_time_constant_h), 1e-10);
  assertThrows(() => poolPendingHeatAt(model, CAPACITY, [], at - 3_600_000), Error, "no observed starting state");
  assertThrows(() => poolPendingHeatAt({ ...model, state: { at: model.state.at, pending_heat_kwh: NaN, source_depletion_kwh: 0 } }, CAPACITY, [], at), Error, "checkpoint");
});

Deno.test("current-quarter compressor memory uses meter deltas despite missing switch observations", () => {
  const at = Date.parse("2026-10-13T12:40:00Z");
  const pool = {water_temperature_c:30,volume_m3:55,heating_running:false,
    heating_history:{start:"2026-10-13T12:30:00Z",end:new Date(at).toISOString(),complete:false,intervals:[]},
    electrical_history:{start:"2026-10-13T12:30:00Z",end:new Date(at).toISOString(),counters:[
      {device_key:"heater",start_kwh:100,end_kwh:100}, {device_key:"pump",start_kwh:10,end_kwh:11}]}};
  const partial=poolPartialElectricity(pool,["heater"],at);
  assertEquals(partial.source,"metered_counter");
  assertEquals(partial.complete,true);
  assertEquals(partial.intervals,[{start_ms:at-600_000,hours:1/6,electrical_kwh:0}]);
  pool.electrical_history.counters[0].end_kwh=100.25;
  assertAlmostEquals(poolPartialElectricity(pool,["heater"],at).intervals[0].electrical_kwh,.25,1e-12);
  assertEquals(poolPartialElectricity(pool,["heater","missing"],at).complete,false);
  for(const end of [99,NaN,Infinity]){
    pool.electrical_history.counters[0].end_kwh=end;
    assertEquals(poolPartialElectricity(pool,["heater"],at).intervals,[]);
  }
  pool.electrical_history.counters[0].end_kwh=100;
  pool.electrical_history.counters.push({...pool.electrical_history.counters[0]});
  assertEquals(poolPartialElectricity(pool,["heater"],at).complete,false);
  assertEquals(poolPartialElectricity({water_temperature_c:30,volume_m3:55,heating_running:true,
    heating_elapsed_seconds:600},["heater"],at).complete,false,"runtime must not invent unmetered electricity");
});

Deno.test("missing metering cannot restore measured source efficiency", () => {
  const model = fitted(synthetic(.7));
  const start = Date.parse(model.state.at);
  assertThrows(() => poolResponseStateAt(model, CAPACITY, [], start + 900_000), Error, 'missing compressor history');
});
