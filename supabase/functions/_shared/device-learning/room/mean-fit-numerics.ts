import { leastSquares, factorLeastSquares } from "./mean-least-squares.ts";
const finite = Number.isFinite;

/** A tiny box-constrained QR solve; active faces express physical coefficients. */
export function physicalSolve(matrix: number[][], target: number[], scales: number[], bounds: Map<number, readonly [number, number]>): number[] | null {
  const factor = factorLeastSquares(matrix, target, scales);
  if (!factor) return null;
  const constraints = [...bounds], fixed = new Map<number, number>();
  let best: number[] | null = null, objective = Infinity;
  const trial = (at: number) => {
    if (at < constraints.length) {
      const [j, [lo, hi]] = constraints[at];
      trial(at + 1); fixed.set(j, lo); trial(at + 1);
      if (Number.isFinite(hi) && hi !== lo) { fixed.set(j, hi); trial(at + 1); }
      fixed.delete(j); return;
    }
    const free = scales.map((_, j) => j).filter(j => !fixed.has(j));
    const adjusted = factor.target.map((y, i) => y - [...fixed].reduce((sum, [j, value]) => sum + value * factor.matrix[i][j], 0));
    const solved = free.length ? leastSquares(factor.matrix.map(row => free.map(j => row[j])), adjusted, free.map(j => scales[j])) : [];
    if (!solved) return;
    const beta = scales.map((_, j) => fixed.get(j) ?? solved[free.indexOf(j)]);
    if (!beta.every(Number.isFinite) || constraints.some(([j, [lo, hi]]) => beta[j] < lo || beta[j] > hi)) return;
    const error = factor.target.reduce((sum, y, i) => sum + (y - factor.matrix[i].reduce((s, x, j) => s + x * beta[j], 0)) ** 2, 0);
    if (error < objective) { best = beta; objective = error; }
  };
  trial(0); return best;
}
/** Profile an unbounded positive exchange coordinate, including exact limits separately. */
export function finiteProfile<T extends { mse: number }>(at: (k: number) => T | null): T | null {
  const evaluate = (x: number) => { const k = Math.exp(x); return finite(k) && k > 0 ? at(k) : null; };
  let center = 0, best = evaluate(center);
  if (!best) for (let distance = 1; distance < 32 && !best; distance++) for (const x of [-distance, distance]) {
    const candidate = evaluate(x); if (candidate) { center = x; best = candidate; break; }
  }
  if (!best) return null;
  let lo = center - 1, hi = center + 1, bracket = false;
  for (let step = 0; step < 64; step++) {
    const left = evaluate(lo), right = evaluate(hi);
    const tolerance = Number.EPSILON * 128 * Math.max(1, best.mse);
    if (left && left.mse < best.mse - tolerance && (!right || left.mse <= right.mse)) {
      best = left; hi = center; center = lo; lo--;
    } else if (right && right.mse < best.mse - tolerance) { best = right; lo = center; center = hi; hi++; }
    else { bracket = !!left && !!right && left.mse > best.mse + tolerance && right.mse > best.mse + tolerance; break; }
  }
  if (!bracket) return null;
  const ratio = (Math.sqrt(5) - 1) / 2;
  let l = hi - ratio * (hi - lo), r = lo + ratio * (hi - lo), left = evaluate(l), right = evaluate(r);
  for (let i = 0; i < 28; i++) {
    if (left && left.mse < best.mse) best = left;
    if (right && right.mse < best.mse) best = right;
    if ((left?.mse ?? Infinity) < (right?.mse ?? Infinity)) { hi = r; r = l; right = left; l = hi - ratio * (hi - lo); left = evaluate(l); }
    else { lo = l; l = r; left = right; r = lo + ratio * (hi - lo); right = evaluate(r); }
  }
  return best;
}
