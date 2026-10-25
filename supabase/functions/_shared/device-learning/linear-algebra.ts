/**
 * Solve a small symmetric normal-equation system by Gauss-Jordan elimination
 * with partial pivoting. Returns null when the design is rank-deficient,
 * which happens when a zone's heater never ran or the outdoor difference
 * never varied — both of which make the parameters unidentifiable rather
 * than merely imprecise.
 */
export function solveLinearSystem(
  matrix: number[][],
  vector: number[],
): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (
        Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])
      ) {
        pivotRow = row;
      }
    }
    const pivot = augmented[pivotRow][column];
    if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-12) return null;
    [augmented[column], augmented[pivotRow]] = [
      augmented[pivotRow],
      augmented[column],
    ];
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column] / augmented[column][column];
      if (factor === 0) continue;
      for (let target = column; target <= size; target += 1) {
        augmented[row][target] -= factor * augmented[column][target];
      }
    }
  }

  // Elimination cleared every off-diagonal entry but left the diagonal
  // unnormalised, so each unknown is its row's constant over its own pivot.
  return augmented.map((row, index) => row[size] / row[index]);
}
