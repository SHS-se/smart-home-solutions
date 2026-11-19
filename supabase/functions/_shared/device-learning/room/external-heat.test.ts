import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { externalHeatEmission, externalHeatTransition, inferExternalHeat, initializeExternalHeat, updateExternalHeat,
  type ExternalHeatParameters, type ExternalHeatResidual } from "./external-heat.ts";

/** Independently generated synthetic observations; no captured household data. */
function generator(seed: number) {
  const uniform = () => ((seed = (1664525 * seed + 1013904223) >>> 0) + .5) / 4294967296;
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}
const residuals = (values: number[], segment = 0) => values.map(residual_c => ({ residual_c, segment }));

/** Independent Simpson integration of the positive latent input, with no
 * truncated-normal formulas or HMM implementation used by the oracle. */
function quadrature(residual: number, sigma: number, mean: number) {
  const steps = 30_000, limit = Math.max(0, residual) + 15 * sigma + 25 * mean, width = limit / steps;
  const sums = [0, 0, 0];
  for (let i = 0; i <= steps; i++) {
    const s = i * width;
    const density = Math.exp(-s / mean - .5 * ((residual - s) / sigma) ** 2) / (mean * sigma * Math.sqrt(2 * Math.PI));
    const weight = i === 0 || i === steps ? 1 : i % 2 ? 4 : 2;
    for (let order = 0; order < 3; order++) sums[order] += weight * density * s ** order;
  }
  return { density: sums[0] * width / 3, mean: sums[1] / sums[0], second: sums[2] / sums[0] };
}

Deno.test("external-heat convolution and conditional moments match independent quadrature", () => {
  for (const r of [-2, -.8, -.05, 0, .5, 2]) {
    const actual = externalHeatEmission(r, .3, .8), expected = quadrature(r, .3, .8);
    assertAlmostEquals(Math.exp(actual.log_density), expected.density, Math.max(1e-14, expected.density * 1e-8));
    assertAlmostEquals(actual.mean_c, expected.mean, 1e-8);
    assertAlmostEquals(actual.second_moment_c2, expected.second, 1e-8);
    assert(actual.second_moment_c2 >= actual.mean_c ** 2 - 1e-12);
  }
});

Deno.test("external-heat emissions stay finite in extreme normal and exponential tails", () => {
  for (const sigma of [.01, 1, 100]) for (const mean of [1e-10, .1, 100]) {
    for (const r of [-1e6, -100, 0, 100, 1e6]) {
      const actual = externalHeatEmission(r, sigma, mean);
      assert(Number.isFinite(actual.log_density));
      assert(Number.isFinite(actual.mean_c) && actual.mean_c >= 0);
      assert(Number.isFinite(actual.second_moment_c2) && actual.second_moment_c2 >= 0);
      assert(actual.second_moment_c2 >= actual.mean_c ** 2 * (1 - 1e-8));
    }
  }
});

Deno.test("external-heat HMM likelihood matches exhaustive independent state enumeration", () => {
  const rows = residuals([-.1, .5, .9, -.2]);
  const parameters: ExternalHeatParameters = { sigma_c: .2, external_mean_c: .8,
    initial: [.8, .2], transition: [[.9, .1], [.3, .7]] };
  let likelihood = 0;
  const stateMass = Array<number>(rows.length).fill(0);
  for (let mask = 0; mask < 2 ** rows.length; mask++) {
    const states = rows.map((_, i) => mask >> i & 1);
    let weight = parameters.initial[states[0]];
    for (let i = 0; i < rows.length; i++) {
      if (i) weight *= parameters.transition[states[i - 1]][states[i]];
      const r = rows[i].residual_c;
      weight *= states[i] ? quadrature(r, .2, .8).density
        : Math.exp(-.5 * (r / .2) ** 2) / (.2 * Math.sqrt(2 * Math.PI));
    }
    likelihood += weight;
    states.forEach((state, i) => { if (state) stateMass[i] += weight; });
  }
  const actual = inferExternalHeat(rows, parameters);
  assertAlmostEquals(actual.nll, -Math.log(likelihood), 1e-8);
  actual.external_probability.forEach((p, i) => assertAlmostEquals(p, stateMass[i] / likelihood, 1e-8));
  assertAlmostEquals(actual.transition_counts.flat().reduce((sum, count) => sum + count, 0), rows.length - 1, 1e-12);
});

Deno.test("external-heat EM recovers persistent synthetic episodes without changing residual facts", () => {
  const random = generator(9241), rows: ExternalHeatResidual[] = [], external: boolean[] = [];
  let active = false;
  for (let i = 0; i < 2400; i++) {
    if (active ? random.uniform() < .06 : random.uniform() < .015) active = !active;
    external.push(active);
    rows.push({ residual_c: .1 * random.normal() + (active ? -.8 * Math.log(random.uniform()) : 0), segment: 0 });
  }
  const original = structuredClone(rows);
  let parameters = initializeExternalHeat(rows), previous = Infinity;
  for (let iteration = 0; iteration < 100; iteration++) {
    const step = updateExternalHeat(rows, parameters);
    assert(step.inference.objective <= previous + 1e-6, "MAP EM must not increase its likelihood-plus-prior objective");
    parameters = step.parameters;
    previous = step.inference.objective;
  }
  const inferred = inferExternalHeat(rows, parameters);
  assertAlmostEquals(parameters.sigma_c, .1, .012);
  assertAlmostEquals(parameters.external_mean_c, .8, .12);
  const labelledMean = (active: boolean) => inferred.external_probability.reduce((sum, p, i) => sum + (external[i] === active ? p : 0), 0) /
    external.filter(value => value === active).length;
  assert(labelledMean(true) > .9);
  assert(labelledMean(false) < .05);
  assert(parameters.transition[1][1] > .8);
  assertEquals(rows, original);
  assertEquals(JSON.parse(JSON.stringify(parameters)), parameters);
});

Deno.test("noise-only synthetic residuals do not acquire a substantial positive heat contribution", () => {
  const random = generator(481), rows = residuals(Array.from({ length: 1800 }, () => .1 * random.normal()));
  let parameters = initializeExternalHeat(rows);
  for (let iteration = 0; iteration < 120; iteration++) parameters = updateExternalHeat(rows, parameters).parameters;
  const inferred = inferExternalHeat(rows, parameters);
  assertAlmostEquals(parameters.sigma_c, .1, .012);
  assert(inferred.expected_c.reduce((sum, value) => sum + value, 0) / rows.length < .015);
  assert(inferred.external_probability.filter(p => p > .95).length / rows.length < .02);
});

Deno.test("causal external-heat evidence and predictive scores cannot see future held-out residuals", () => {
  const parameters: ExternalHeatParameters = { sigma_c: .1, external_mean_c: .5,
    initial: [.8, .2], transition: [[.95, .05], [.1, .9]] };
  const earlier = residuals([0, -.03, .5, .8, .2]);
  const first = inferExternalHeat([...earlier, ...residuals([-.1, -.2, -.1])], parameters, { causal: true });
  const second = inferExternalHeat([...earlier, ...residuals([3, 4, 5])], parameters, { causal: true });
  assertEquals(first.expected_c.slice(0, earlier.length), second.expected_c.slice(0, earlier.length));
  assertEquals(first.external_probability.slice(0, earlier.length), second.external_probability.slice(0, earlier.length));
  assertEquals(first.predictive_log_density.slice(0, earlier.length), second.predictive_log_density.slice(0, earlier.length));
  const one = inferExternalHeat(earlier, parameters);
  assertEquals(first.predictive_log_density.slice(0, earlier.length), one.predictive_log_density);
});

Deno.test("external-heat segment boundaries reset the state and exclude cross-gap transitions", () => {
  const parameters: ExternalHeatParameters = { sigma_c: .1, external_mean_c: .8,
    initial: [.9, .1], transition: [[.99, .01], [.01, .99]] };
  const after = residuals([.1, 0, -.1], 1);
  const joined = inferExternalHeat([...residuals([2, 3, 2]), ...after], parameters);
  const alone = inferExternalHeat(after, parameters);
  assertEquals(joined.external_probability.slice(3), alone.external_probability);
  assertEquals(joined.predictive_log_density.slice(3), alone.predictive_log_density);
  assertAlmostEquals(joined.transition_counts.flat().reduce((sum, count) => sum + count, 0), 4, 1e-12);
  assertAlmostEquals(joined.initial_counts[0] + joined.initial_counts[1], 2, 1e-12);
});

Deno.test("external-heat likelihood preserves exact zero-state boundaries and rejects malformed evidence", () => {
  const parameters: ExternalHeatParameters = { sigma_c: .1, external_mean_c: .8,
    initial: [1, 0], transition: [[1, 0], [0, 1]] };
  const rows = residuals([0, -.1, .1]);
  const actual = inferExternalHeat(rows, parameters);
  assertEquals(actual.external_probability, [0, 0, 0]);
  assertEquals(actual.expected_c, [0, 0, 0]);
  assertThrows(() => inferExternalHeat([], parameters));
  assertThrows(() => inferExternalHeat(residuals([NaN]), parameters));
  assertThrows(() => inferExternalHeat(rows, { ...parameters, sigma_c: 0 }));
});

Deno.test("external-heat empirical initializer preserves both states and edges on short same-sign samples", () => {
  for (const values of [[1], [1, 1, 1], [-1, -1, -1], [0, 0, 0], [-1, 1]]) {
    const parameters = initializeExternalHeat(residuals(values));
    for (const pair of [parameters.initial, ...parameters.transition]) {
      assert(pair.every(p => p > 0 && p < 1));
      assertEquals(pair[0] + pair[1], 1);
    }
    assert(Number.isFinite(inferExternalHeat(residuals(values), parameters).nll));
  }
});

Deno.test("clock-time external persistence composes four quarter-hours into one hour", () => {
  const parameters: ExternalHeatParameters = { sigma_c: .1, external_mean_c: .5,
    initial: [.8, .2], transition: [[.96, .04], [.12, .88]] };
  const quarter = externalHeatTransition(parameters, .25);
  let result = [[1, 0], [0, 1]];
  for (let i = 0; i < 4; i++) result = result.map(row => [0, 1].map(j => row[0] * quarter[0][j] + row[1] * quarter[1][j]));
  result.forEach((row, i) => row.forEach((value, j) => assertAlmostEquals(value, parameters.transition[i][j], 1e-12)));
  assertEquals(externalHeatTransition({ transition: [[1, 0], [0, 1]] }, .25), [[1, 0], [0, 1]]);
  const absorbing = externalHeatTransition({ transition: [[1, 0], [.2, .8]] }, .25);
  assertEquals(absorbing[0], [1, 0]);
  assertAlmostEquals(absorbing[1][1] ** 4, .8, 1e-12);
});

Deno.test("external forcing exposure and independent noise classes enter the exact likelihood and moments", () => {
  const parameters: ExternalHeatParameters = { sigma_c: .4, sigma_by_class: { quarter: .03, hour: .08 },
    external_mean_c: .7, initial: [0, 1], transition: [[1, 0], [0, 1]] };
  const rows = [
    { residual_c: .2, segment: 0, forcing_scale: .25, duration_h: .25, noise_class: "quarter" },
    { residual_c: .5, segment: 1, forcing_scale: 1, duration_h: 1, noise_class: "hour" },
  ];
  const actual = inferExternalHeat(rows, parameters);
  rows.forEach((row, i) => {
    const sigma = parameters.sigma_by_class![row.noise_class];
    const oracle = quadrature(row.residual_c, sigma, parameters.external_mean_c * row.forcing_scale);
    assertAlmostEquals(actual.predictive_log_density[i], Math.log(oracle.density), 1e-8);
    assertAlmostEquals(actual.expected_c[i], oracle.mean, 1e-8);
    assertAlmostEquals(actual.second_moment_c2[i], oracle.second, 1e-8);
    assertAlmostEquals(actual.precision[i], 1 / sigma ** 2, 1e-12);
  });
  const updated = updateExternalHeat(rows, parameters).parameters;
  assertAlmostEquals(updated.external_mean_c, (actual.expected_c[0] / .25 + actual.expected_c[1]) / 2, 1e-12);
});

Deno.test("mixed native intervals learn one forcing scale, distinct noise and clock-time persistence with monotone EM", () => {
  const random = generator(49182), rows: ExternalHeatResidual[] = [];
  // Independent continuous-time process sampled at irregular intervals.
  // Switching events use exponential waiting times, not matrix powers.
  const enterRate = .025, leaveRate = .16;
  let state = false, time = 0, event = -Math.log(random.uniform()) / enterRate;
  for (let i = 0; i < 4800; i++) {
    const duration = i % 64 < 48 ? .25 : 1;
    time += duration;
    while (event <= time) {
      state = !state;
      event += -Math.log(random.uniform()) / (state ? leaveRate : enterRate);
    }
    const scale = duration === .25 ? .24 : .94, sigma = duration === .25 ? .03 : .08;
    rows.push({ residual_c: sigma * random.normal() + (state ? -.7 * scale * Math.log(random.uniform()) : 0),
      segment: 0, duration_h: duration, forcing_scale: scale, noise_class: duration === .25 ? "quarter" : "hour" });
  }
  let parameters = initializeExternalHeat(rows), last = Infinity;
  for (let iteration = 0; iteration < 100; iteration++) {
    const next = updateExternalHeat(rows, parameters);
    assert(next.inference.objective <= last + 1e-5, "mixed-duration MAP EM must not decrease its regularized objective");
    last = next.inference.objective; parameters = next.parameters;
  }
  assertAlmostEquals(parameters.external_mean_c, .7, .12);
  assertAlmostEquals(parameters.sigma_by_class!.quarter, .03, .004);
  assertAlmostEquals(parameters.sigma_by_class!.hour, .08, .012);
  const moved = 1 - Math.exp(-enterRate - leaveRate);
  assertAlmostEquals(parameters.transition[0][1], moved * enterRate / (enterRate + leaveRate), .008);
  assertAlmostEquals(parameters.transition[1][0], moved * leaveRate / (enterRate + leaveRate), .04);
  assertEquals(rows[0].forcing_scale, .24);
});

Deno.test("proper empirical noise prior prevents a 29-pair zero-noise mixture singularity without a temperature cutoff", () => {
  const rows = residuals([...Array<number>(20).fill(0), ...Array.from({ length: 9 }, (_, i) => .2 + i * .08)]);
  const parameters: ExternalHeatParameters = { sigma_c: 1e-12, external_mean_c: .5, noise_reference_c2: .01,
    initial: [.8, .2], transition: [[.95, .05], [.1, .9]] };
  const collapsed = inferExternalHeat(rows, parameters);
  const step = updateExternalHeat(rows, parameters);
  const regularized = inferExternalHeat(rows, step.parameters);
  assert(step.parameters.sigma_c >= Math.sqrt(.01 / (rows.length + 3)) * (1 - 1e-10));
  assert(regularized.objective < collapsed.objective);
  assert(collapsed.noise_penalty > 1e20);
  assertEquals(step.parameters.noise_reference_c2, .01);
  assertAlmostEquals(regularized.objective, regularized.nll + regularized.noise_penalty, 1e-12);
  // Celsius-to-another-linear-unit conversion scales the fitted noise, rather
  // than encountering a fixed absolute temperature minimum.
  const factor = 100;
  const converted = updateExternalHeat(residuals(rows.map(row => row.residual_c * factor)), {
    ...parameters, sigma_c: parameters.sigma_c * factor, external_mean_c: parameters.external_mean_c * factor,
    noise_reference_c2: parameters.noise_reference_c2! * factor * factor,
  });
  assertAlmostEquals(converted.parameters.sigma_c / factor, step.parameters.sigma_c, 1e-10);
});

Deno.test("noise prior counts only actual noise classes and preserves its empirical calibration reference", () => {
  const rows = [
    { residual_c: -.1, segment: 0, noise_class: "quarter" },
    { residual_c: .2, segment: 1, noise_class: "hour" },
  ];
  const parameters: ExternalHeatParameters = { sigma_c: 3, sigma_by_class: { quarter: .1, hour: .2 },
    noise_reference_c2: .04, external_mean_c: .5, initial: [1, 0], transition: [[1, 0], [0, 1]] };
  const actual = inferExternalHeat(rows, parameters);
  assertEquals(actual.noise_penalty, inferExternalHeat(rows, { ...parameters, sigma_c: 30 }).noise_penalty);
  const expected = [.01, .04].reduce((sum, v) => sum + 1.5 * Math.log(v) + .02 / v + .5 * Math.log(Math.PI) - .5 * Math.log(.02), 0);
  assertAlmostEquals(actual.noise_penalty, expected, 1e-12);
  const updated = updateExternalHeat(rows, parameters).parameters;
  assertAlmostEquals(updated.sigma_by_class!.quarter ** 2, (.01 + .04) / 4, 1e-12);
  assertAlmostEquals(updated.sigma_by_class!.hour ** 2, (.04 + .04) / 4, 1e-12);
  assertEquals(updated.noise_reference_c2, .04);
});
