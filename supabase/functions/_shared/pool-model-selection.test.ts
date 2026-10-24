import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { fitPoolDynamics } from "./pool-dynamics.ts";
import { selectPoolDynamics } from "./pool-model-selection.ts";
import { syntheticPoolHistory as synthetic, SYNTHETIC_POOL_CAPACITY as CAPACITY } from "./pool-model-selection.fixture.ts";


Deno.test("prospective selection keeps learned water lag without invented recovery for constant truth", () => {
  const result = selectPoolDynamics(synthetic(false), CAPACITY);
  assert("fitted" in result);
  assertEquals(result.selection.selected, "constant_gain");
  assertEquals(result.fitted.source, null);
  assertAlmostEquals(result.fitted.response_time_constant_h, .7, .001);
  assertEquals(result.selection.hours, 7 * 24);
  assertEquals(result.selection.days, 7);
});

Deno.test("recovery must predict later hours and publishes the evaluated coefficients without refitting", () => {
  const samples = synthetic(true), result = selectPoolDynamics(samples, CAPACITY);
  assert("fitted" in result);
  assertEquals(result.selection.selected, "recovering_source");
  assertEquals(result.selection.reason, "supported");
  assert(result.selection.lower_mse_improvement! > 0);
  const train = samples.slice(0, 14 * 96), fitted = fitPoolDynamics(train, CAPACITY);
  assert("fitted" in fitted);
  assertEquals(result.fitted.source, fitted.fitted.source);
  assertEquals(result.fitted.heat_c_per_kwh, fitted.fitted.heat_c_per_kwh);
  assertEquals(result.fitted.initial_state, fitted.fitted.initial_state);
  assertEquals(result.fitted.sample_count, train.length);
  assertEquals(result.fitted.state.at, new Date(21 * 86400000).toISOString());
  // Later water labels influence scores, never the carried physical memory.
  const shifted = samples.map((s, i) => i < train.length ? s : { ...s,
    water_temperature_c: s.water_temperature_c + .0001 * i,
    next_water_temperature_c: s.next_water_temperature_c + .0001 * (i + 1) });
  const changed = selectPoolDynamics(shifted, CAPACITY);
  assert("fitted" in changed);
  assertEquals(changed.selection.selected, "recovering_source");
  assertEquals(changed.fitted, result.fitted);
  assert(changed.selection.recovery_rmse_c !== result.selection.recovery_rmse_c);
});

Deno.test("missing held-out electricity never becomes an idle interval or fitted validation state", () => {
  const samples = synthetic(true);
  samples[14 * 96 + 8].electrical_kwh = NaN;
  const result = selectPoolDynamics(samples, CAPACITY);
  assert("fitted" in result);
  assertEquals(result.selection.reason, "insufficient_continuity");
  assertEquals(result.selection.selected, "constant_gain");
  assertEquals(result.selection.hours, 0);
  assertEquals(result.fitted.source, null);
  assertEquals(result.fitted.sample_count, samples.length - 1);
});

Deno.test("unidentifiable calibration remains explicit without an assumed recovery constant", () => {
  assertEquals(selectPoolDynamics([], CAPACITY).selection.reason, "unidentifiable");
  assert("rejected" in selectPoolDynamics(synthetic(false), Infinity));
});
Deno.test("correlated noisy constant-gain synthetic histories do not become restart recovery", () => {
  for (let seed = 1; seed <= 4; seed++) {
    let random = seed, error = 0;
    const samples = synthetic(false);
    const offsets = Array.from({length:samples.length + 1}, (_, i) => {
      random = (Math.imul(random,1664525) + 1013904223) >>> 0;
      error = .85 * error + .02 * (random / 4294967296 - .5);
      return error + .015 * Math.sin(i / (96 * 5));
    });
    const noisy = samples.map((s,i) => ({...s,water_temperature_c:s.water_temperature_c+offsets[i],
      next_water_temperature_c:s.next_water_temperature_c+offsets[i+1]}));
    const fit = selectPoolDynamics(noisy,CAPACITY);
    assert("fitted" in fit);
    assertEquals(fit.selection.selected,"constant_gain",`synthetic null seed ${seed}`);
  }
});
