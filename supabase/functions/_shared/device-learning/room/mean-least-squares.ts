/** Small column-scaled QR solve. Operates on observations, never a normal
 * matrix, so conditioning is not squared and a nuisance projection cannot
 * manufacture rank through subtraction of nearly equal covariance matrices. */
export function columnNorm(values: readonly number[]): number {
  let norm = 0;
  for (const value of values) norm = Math.hypot(norm, value);
  return norm;
}

export function factorLeastSquares(
  matrix: readonly (readonly number[])[], target: readonly number[],
  originalScales?: readonly number[], observationCount?: number,
): { matrix: number[][]; target: number[] } | null {
  const n = matrix.length, p = matrix[0]?.length ?? 0;
  if (!p || n < p || target.length !== n) return null;
  const scales = originalScales ?? Array.from({ length: p }, (_, j) => columnNorm(matrix.map(row => row[j])));
  if (scales.some(scale => !(scale > 0) || !Number.isFinite(scale))) return null;
  const columns = scales.map((scale, j) => matrix.map(row => row[j] / scale));
  const order = Array.from({ length: p }, (_, j) => j);
  const upper = Array.from({ length: p }, () => Array<number>(p).fill(0));
  const projected = Array<number>(p).fill(0);
  const tolerance = Number.EPSILON * Math.max(observationCount ?? n, p) * 16;
  const dot = (a: readonly number[], b: readonly number[]) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[i] * b[i];
    return sum;
  };
  for (let j = 0; j < p; j++) {
    let pivot = j, norm = columnNorm(columns[j]);
    for (let z = j + 1; z < p; z++) {
      const candidate = columnNorm(columns[z]);
      if (candidate > norm) { pivot = z; norm = candidate; }
    }
    [columns[j], columns[pivot]] = [columns[pivot], columns[j]];
    [order[j], order[pivot]] = [order[pivot], order[j]];
    for (let i = 0; i < j; i++) [upper[i][j], upper[i][pivot]] = [upper[i][pivot], upper[i][j]];
    if (!Number.isFinite(norm) || norm <= tolerance) return null;
    upper[j][j] = norm;
    const unit = columns[j].map(value => value / norm);
    projected[j] = dot(unit, target);
    for (let z = j + 1; z < p; z++) {
      // Reorthogonalize: nearly dependent columns must stay dependent even
      // after a long observation history has accumulated rounding error.
      for (let pass = 0; pass < 2; pass++) {
        const coefficient = dot(unit, columns[z]);
        upper[j][z] += coefficient;
        for (let i = 0; i < n; i++) columns[z][i] -= coefficient * unit[i];
      }
    }
  }
  const transformed = upper.map(row => {
    const result = Array<number>(p).fill(0);
    for (let j = 0; j < p; j++) result[order[j]] = row[j] * scales[order[j]];
    return result;
  });
  return { matrix: transformed, target: projected };
}

export function leastSquares(matrix: readonly (readonly number[])[], target: readonly number[],
  originalScales?: readonly number[]): number[] | null {
  const factor = factorLeastSquares(matrix, target, originalScales);
  if (!factor) return null;
  // The factor is in original column order. Recover its pivot order from the
  // upper-triangular row supports, then substitute in that order.
  const p = factor.target.length, coefficients = Array<number>(p).fill(0), solved = new Set<number>();
  for (let i = p - 1; i >= 0; i--) {
    const row = factor.matrix[i];
    const pivot = row.findIndex((value, j) => value !== 0 && !solved.has(j));
    if (pivot < 0) return null;
    let value = factor.target[i];
    for (const j of solved) value -= row[j] * coefficients[j];
    coefficients[pivot] = value / row[pivot];
    solved.add(pivot);
  }
  return coefficients.every(Number.isFinite) ? coefficients : null;
}
