/** Nonnegative initial heater states, with a small projected-QR active set.
 * The segment columns have disjoint supports. Project them once, retain their
 * scalar coordinates, and compress the orthogonal observations to p rows.
 * An inactive state adds just one scalar row to each subsequent QR solve.
 * No normal matrix, coefficient cap, or one-pass negative-state clamp. */
import { columnNorm, factorLeastSquares } from "./mean-least-squares.ts";
export interface NuisanceColumn {
  indices: number[];
  values: number[];
}
export function solveNonnegativeNuisance(
  matrix: readonly (readonly number[])[],
  target: readonly number[],
  columns: readonly NuisanceColumn[],
  solve: (
    matrix: number[][],
    target: number[],
    scales: number[],
  ) => number[] | null,
  observationCount?: number,
): {
  beta: number[];
  initial: number[];
  iterations: number;
  boundary_steps: number;
  release_steps: number;
} | null {
  const p = matrix[0]?.length ?? 0, n = observationCount ?? matrix.length;
  const scales = Array.from(
    { length: p },
    (_, j) => columnNorm(matrix.map((row) => row[j])),
  );
  const projected = matrix.map((row) => [...row]), y = [...target];
  const groups = columns.map(({ indices, values }) => {
    const norm = columnNorm(values), unit = values.map((value) => value / norm);
    return { indices, norm, unit, x: Array<number>(p).fill(0), y: 0 };
  });
  if (groups.some((g) => !(g.norm > 0) || !Number.isFinite(g.norm))) {
    return null;
  }
  for (const group of groups) {
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < p; j++) {
        const dot = group.indices.reduce(
          (sum, i, q) => sum + projected[i][j] * group.unit[q],
          0,
        );
        group.x[j] += dot;
        group.indices.forEach((i, q) => {
          projected[i][j] -= dot * group.unit[q];
        });
      }
      const dot = group.indices.reduce(
        (sum, i, q) => sum + y[i] * group.unit[q],
        0,
      );
      group.y += dot;
      group.indices.forEach((i, q) => {
        y[i] -= dot * group.unit[q];
      });
    }
  }
  // A segment with only one compressed duration channel projects its row
  // exactly to zero. Keep its scalar coordinate for the active set; the
  // zero row contributes neither rank nor residual to the orthogonal QR.
  const orthogonal: number[][] = [], orthogonalTarget: number[] = [];
  for (let i = 0; i < projected.length; i++) {
    if (y[i] === 0 && projected[i].every(value => value === 0)) continue;
    orthogonal.push(projected[i]);
    orthogonalTarget.push(y[i]);
  }
  const factor = factorLeastSquares(orthogonal, orthogonalTarget, scales, n);
  if (!factor) return null;
  const coordinates = (beta: number[]) => groups.map(({ x, y }) => {
    let fitted = 0;
    for (let j = 0; j < p; j++) fitted += x[j] * beta[j];
    return y - fitted;
  });
  const tolerance = (i: number, beta: number[]) => {
    const { x, y } = groups[i];
    let fitted = 0;
    for (let j = 0; j < p; j++) fitted += Math.abs(x[j] * beta[j]);
    return Number.EPSILON * Math.max(n, p) * 32 * Math.max(1, Math.abs(y) + fitted);
  };
  const unscale = (initial: number[]) => initial.map((v, i) => v / groups[i].norm);
  // Start from the unrestricted solution, but make the reservoir feasible.
  // The following boundary/release loop reoptimizes all coefficients; this
  // initialization is not a clamp of the final fitted state.
  let beta = solve(factor.matrix, factor.target, scales);
  if (!beta) return null;
  let initial = coordinates(beta).map((v) => Math.max(0, v));
  // A strictly feasible unrestricted optimum is already the NNLS optimum.
  // Waiting for the first all-free active solve would repeat the same QR.
  if (initial.every(value => value > 0)) {
    const values = unscale(initial);
    return values.every(Number.isFinite) ? { beta, initial: values, iterations: 1, boundary_steps: 0, release_steps: 0 } : null;
  }
  const free = new Set(initial.flatMap((value, i) => value > 0 ? [i] : []));
  let iterations = 0, boundary_steps = 0, release_steps = 0;
  for (;;) {
    iterations++;
    const active = groups.filter((_, i) => !free.has(i));
    const proposed = solve([...factor.matrix, ...active.map((g) => g.x)], [
      ...factor.target,
      ...active.map((g) => g.y),
    ], scales);
    if (!proposed) return null;
    const raw = coordinates(proposed),
      next = raw.map((v, i) => free.has(i) ? v : 0);
    let fraction = 1, hit = -1;
    for (const i of free) {
      if (next[i] < -tolerance(i, proposed)) {
        const a = initial[i] / (initial[i] - next[i]);
        if (a < fraction) {
          fraction = a;
          hit = i;
        }
      }
    }
    // Preserve feasibility until the first free state reaches its boundary.
    if (hit >= 0) {
      boundary_steps++;
      beta = beta.map((v, j) => v + fraction * (proposed[j] - v));
      initial = initial.map((v, i) =>
        Math.max(0, v + fraction * (next[i] - v))
      );
      initial[hit] = 0;
      free.delete(hit);
      continue;
    }
    beta = proposed;
    initial = next.map((v) => Math.max(0, v));
    // KKT: every zero-state residual gradient must be nonpositive. A state
    // fixed earlier may need releasing after the global response changes.
    let release = -1, gradient = 0;
    for (let i = 0; i < groups.length; i++) {
      if (!free.has(i) && raw[i] > tolerance(i, beta) && raw[i] > gradient) {
        release = i;
        gradient = raw[i];
      }
    }
    if (release < 0) {
      const values = unscale(initial);
      return values.every(Number.isFinite)
        ? { beta, initial: values, iterations, boundary_steps, release_steps }
        : null;
    }
    release_steps++;
    free.add(release);
  }
}
