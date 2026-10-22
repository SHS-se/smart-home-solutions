/** Fixed-lambda ridge with training-only standardization and an unpenalized intercept. */
export interface RidgeFit {
  lambda: 1;
  means: number[];
  scales: number[];
  /** Intercept first, then coefficients for standardized features. */
  coefficients: number[];
}
export function fitRidge(inputs: readonly (readonly number[])[], values: readonly number[]): RidgeFit {
  if (!inputs.length || inputs.length !== values.length) throw new Error('Ridge requires a nonempty paired training cohort.');
  const width = inputs[0].length;
  if (inputs.some(row => row.length !== width || row.some(value => !Number.isFinite(value))) || values.some(value => !Number.isFinite(value))) {
    throw new Error('Ridge features and labels must be finite and have matching widths.');
  }
  const means = inputs[0].map((_, column) => inputs.reduce((sum, row) => sum + row[column], 0) / inputs.length);
  const scales = means.map((mean, column) => Math.sqrt(inputs.reduce((sum, row) => sum + (row[column] - mean) ** 2, 0) / inputs.length) || 1);
  const x = inputs.map(row => [1, ...row.map((value, column) => (value - means[column]) / scales[column])]);
  const matrix = Array.from({ length: width + 1 }, (_, left) =>
    Array.from({ length: width + 2 }, (_, right) => right > width
      ? x.reduce((sum, row, index) => sum + row[left] * values[index], 0)
      : x.reduce((sum, row) => sum + row[left] * row[right], 0) + (left === right && left > 0 ? 1 : 0)));
  for (let column = 0; column <= width; column++) {
    const pivot = matrix[column][column];
    for (let right = column; right <= width + 1; right++) matrix[column][right] /= pivot;
    for (let row = 0; row <= width; row++) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let right = column; right <= width + 1; right++) matrix[row][right] -= factor * matrix[column][right];
    }
  }
  const coefficients = matrix.map(row => row[width + 1]);
  if ([...means, ...scales, ...coefficients].some(value => !Number.isFinite(value))) throw new Error('Ridge fit is not numerically finite.');
  return { lambda: 1, means, scales, coefficients };
}
export function predictRidge(fit: RidgeFit, target: readonly number[]): number {
  if (target.length !== fit.means.length || target.some(value => !Number.isFinite(value))) throw new Error('Ridge target features must match the fitted finite feature schema.');
  const transformed = [1, ...target.map((value, column) => (value - fit.means[column]) / fit.scales[column])];
  const prediction = transformed.reduce((sum, value, column) => sum + value * fit.coefficients[column], 0);
  if (!Number.isFinite(prediction)) throw new Error('Ridge prediction is not numerically finite.');
  return prediction;
}
/** Existing retrospective caller retains its exact numerical operations. */
export function ridge(inputs: number[][], values: number[], target: number[]): number {
  return predictRidge(fitRidge(inputs, values), target);
}
