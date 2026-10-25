import { assert, assertAlmostEquals } from "@std/assert";
import { fitPoolDynamics } from "../../supabase/functions/_shared/device-learning/pool/response.ts";
import { selectPoolDynamics } from "../../supabase/functions/_shared/device-learning/pool/selection.ts";
import { poolQuarterMean } from "../../supabase/functions/_shared/device-learning/pool/observations.ts";
import { fitPoolModel, type PoolTrainingSample } from "../../supabase/functions/_shared/device-learning/pool/thermal.ts";

/** Synthetic constant-power ODE integration, independent of production transitions. */
function history(source: boolean) {
  const capacity = 40, lag = .6, gain = .1, rate = .8, loss = .12;
  let water = 25, pending = 0, depletion = 0, seed = 51;
  const quarters: { mean: number; power: number }[] = [];
  for (let q = 0; q < 14 * 96; q++) {
    seed = seed * 16807 % 2147483647;
    const power = seed / 2147483647 > .45 ? 3 : 0;
    let sum = 0;
    for (let second = 0; second < 900; second++) {
      const waterRate = pending / lag / capacity - .02;
      sum += water + waterRate / 7200;
      water += waterRate / 3600;
      pending += (gain * capacity * power * (source ? 1 - loss * depletion : 1) - pending / lag) / 3600;
      depletion += (power - rate * depletion) / 3600;
    }
    quarters.push({ mean: sum / 900, power });
  }
  return quarters.slice(0, -1).map((q, i) => ({ start_ms: i * 900_000,
    water_temperature_c: q.mean, next_water_temperature_c: quarters[i + 1].mean,
    electrical_kwh: q.power / 4, next_electrical_kwh: quarters[i + 1].power / 4 }));
}

Deno.test("pool recorder means identify known delay and heat conservation instead of a shifted response", () => {
  const samples = history(false);
  const wrong = fitPoolDynamics(samples, 40, "constant_gain");
  assert("fitted" in wrong);
  assert(Math.abs(wrong.fitted.response_time_constant_h - .6) > .1);
  const correct = fitPoolDynamics(samples, 40, "constant_gain", "quarter_mean");
  assert("fitted" in correct);
  assertAlmostEquals(correct.fitted.response_time_constant_h, .6, .002);
  assertAlmostEquals(correct.fitted.heat_c_per_kwh, .1, .0001);
  assertAlmostEquals(correct.fitted.idle_c_per_h, -.02, .0001);
});

Deno.test("the interval-mean observer includes recovering source and pending heat", () => {
  for (const lag of [0, .6, 1.25]) {
    let water = 27, pending = lag ? 2 : 0, depletion = 1;
    let sum = 0;
    for (let step = 0; step < 9000; step++) {
      const heat = 4 * 3 * (1 - .12 * depletion);
      const waterRate = (lag ? pending / lag : heat) / 40 - .02;
      sum += water + waterRate / 72000;
      water += waterRate / 36000;
      if (lag) pending += (heat - pending / lag) / 36000;
      depletion += (3 - .8 * depletion) / 36000;
    }
    const predicted = poolQuarterMean(27, lag ? 2 : 0, 1, 3, .25, 40, lag, 4, -.02,
      { recovery_rate_per_h: .8, heat_loss_per_kwh: .12 });
    assertAlmostEquals(predicted, sum / 9000, .000002);
  }
});

Deno.test("recorder mean response identifies source recovery without resetting memory", () => {
  const fitted = fitPoolDynamics(history(true), 40, "recovering_source", "quarter_mean");
  assert("fitted" in fitted);
  assert(fitted.fitted.source);
  assertAlmostEquals(fitted.fitted.response_time_constant_h, .6, .01);
  assertAlmostEquals(fitted.fitted.heat_c_per_kwh, .1, .002);
  assertAlmostEquals(fitted.fitted.source.recovery_rate_per_h, .8, .03);
  assertAlmostEquals(fitted.fitted.source.heat_loss_c_per_kwh_per_kwh, .012, .0005);
});

Deno.test("static COP learning aligns adjacent mean intervals with both electrical inputs", () => {
  const volume = 35, capacity = volume * 1.163;
  let water = 28, seed = 93;
  const quarters: { water: number; power: number; air: number }[] = [];
  for (let q = 0; q < 14 * 96; q++) {
    seed = seed * 16807 % 2147483647;
    const power = seed / 2147483647 > .5 ? 3 : 0, air = 15 + 7 * Math.sin(q / 97);
    let sum = 0;
    for (let second = 0; second < 900; second++) {
      const rate = (power * (4 + .1 * (air - 20)) - .08 * (water - air) + .1) / capacity;
      sum += water + rate / 7200; water += rate / 3600;
    }
    quarters.push({ water: sum / 900, power, air });
  }
  const samples: PoolTrainingSample[] = quarters.slice(0, -1).map((q, i) => ({
    water_temperature_c: q.water, next_water_temperature_c: quarters[i + 1].water,
    outdoor_temperature_c: q.air, next_outdoor_temperature_c: quarters[i + 1].air,
    electrical_kwh: q.power / 4, next_electrical_kwh: quarters[i + 1].power / 4,
  }));
  const fit = fitPoolModel(samples, volume, "quarter_mean");
  assert("fitted" in fit);
  assertAlmostEquals(fit.fitted.rated_cop, 4, .01);
  assertAlmostEquals(fit.fitted.cop_per_air_c, .025, .0003);
  assertAlmostEquals(fit.fitted.loss_kw_per_k, .08, .001);
});

Deno.test("prospective pool selection scores the recorder mean rather than endpoint temperatures", () => {
  const result = selectPoolDynamics(history(false), 40, "quarter_mean");
  assert("fitted" in result);
  assert(result.selection.hours >= 72);
  assert(result.selection.constant_rmse_c! < .0001);
  assertAlmostEquals(result.fitted.heat_c_per_kwh, .1, .0002);
});
