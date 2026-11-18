import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { leastSquares } from "./mean-least-squares.ts";
import { solveNonnegativeNuisance, type NuisanceColumn } from "./mean-nuisance.ts";

function residual(matrix: number[][], target: number[], groups: NuisanceColumn[], beta: number[], initial: number[]) {
  const fitted = matrix.map(row => row.reduce((sum, value, j) => sum + value * beta[j], 0));
  groups.forEach((group, g) => group.indices.forEach((i, j) => { fitted[i] += initial[g] * group.values[j]; }));
  return target.reduce((sum, value, i) => sum + (value - fitted[i]) ** 2, 0);
}

/** Independent exhaustive face oracle, intended only for tiny synthetic tests. */
function exhaustive(matrix: number[][], target: number[], groups: NuisanceColumn[]) {
  const p = matrix[0].length;
  let optimum = Infinity;
  for (let mask = 0; mask < 2 ** groups.length; mask++) {
    const free = groups.flatMap((_, i) => mask & 2 ** i ? [i] : []);
    const design = matrix.map((row, i) => [...row, ...free.map(g => {
      const j = groups[g].indices.indexOf(i);
      return j < 0 ? 0 : groups[g].values[j];
    })]);
    const fit = leastSquares(design, target);
    if (!fit || fit.slice(p).some(value => value < 0)) continue;
    const initial = groups.map((_, i) => free.includes(i) ? fit[p + free.indexOf(i)] : 0);
    optimum = Math.min(optimum, residual(matrix, target, groups, fit.slice(0, p), initial));
  }
  return optimum;
}

Deno.test("negative initial heater storage is constrained and all thermal coefficients are refitted", () => {
  const matrix = Array.from({ length: 16 }, (_, i) => [1, Math.sin(i)]);
  const target = matrix.map((row, i) => 2 * row[0] + .7 * row[1] + (i < 8 ? -2 : 1) * Math.exp(-(i % 8) / 3));
  const groups = [0, 8].map(start => ({ indices: Array.from({ length: 8 }, (_, i) => start + i),
    values: Array.from({ length: 8 }, (_, i) => Math.exp(-i / 3)) }));
  const fitted = solveNonnegativeNuisance(matrix, target, groups, leastSquares);
  assert(fitted);
  assertEquals(fitted.initial[0], 0);
  assert(fitted.initial[1] > 1, "the other state must be re-estimated after activating the first boundary");
  const actual = residual(matrix, target, groups, fitted.beta, fitted.initial);
  assertAlmostEquals(actual, exhaustive(matrix, target, groups), 1e-10);
  assert(actual < residual(matrix, target, groups, [2, .7], [0, 1]), "clamping the unconstrained answer is not the constrained optimum");
});

Deno.test("orthogonal zero rows preserve the positive and constrained single-channel states", () => {
  const matrix = [[1, 0], [0, 1], [1, 1], [1, 2], [2, 1]];
  const groups = [{ indices: [3], values: [3] }, { indices: [4], values: [2] }];
  for (const sign of [1, -1]) {
    const target = [2, 1, 3, 4 + sign, 7];
    const fitted = solveNonnegativeNuisance(matrix, target, groups, leastSquares);
    assert(fitted);
    assertAlmostEquals(residual(matrix, target, groups, fitted.beta, fitted.initial), exhaustive(matrix, target, groups), 1e-10);
    if (sign > 0) {
      assertEquals(fitted.iterations, 1);
      assertAlmostEquals(fitted.initial[0], 1 / 3, 1e-12);
      assertAlmostEquals(fitted.initial[1], 1, 1e-12);
    } else assertEquals(fitted.initial[0], 0);
  }
});

Deno.test("correlated synthetic nuisance states require both boundary steps and constraint release", () => {
  let seed = 239;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  let boundaries = 0, releases = 0;
  // Four independently generated small systems, with correlated global/state
  // columns; the last requires a state to leave and re-enter the free set.
  for (let trial = 0; trial < 4; trial++) {
    const weights = Array.from({ length: 6 }, () => [random() * 2 - 1, random() * 2 - 1]);
    const matrix = Array.from({ length: 36 }, (_, i) => weights[Math.floor(i / 6)]
      .map(value => Math.exp(-(i % 6) / 2) * value + .03 * (random() * 2 - 1)));
    const groups = Array.from({ length: 6 }, (_, g) => ({ indices: Array.from({ length: 6 }, (_, i) => g * 6 + i),
      values: Array.from({ length: 6 }, (_, i) => Math.exp(-i / 2)) }));
    const amplitudes = Array.from({ length: 6 }, () => random() * 4 - 2);
    const target = Array.from({ length: 36 }, (_, i) => amplitudes[Math.floor(i / 6)] * Math.exp(-(i % 6) / 2) + .1 * (random() * 2 - 1));
    const fitted = solveNonnegativeNuisance(matrix, target, groups, leastSquares);
    assert(fitted);
    assert(fitted.initial.every(value => value >= 0));
    assertAlmostEquals(residual(matrix, target, groups, fitted.beta, fitted.initial), exhaustive(matrix, target, groups), 1e-10);
    boundaries += fitted.boundary_steps;
    releases += fitted.release_steps;
  }
  assert(boundaries > 0);
  assert(releases > 0);
});
