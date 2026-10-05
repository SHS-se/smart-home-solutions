import type { UsedCurve } from './types';

/** Plot the reported piecewise curve, including its zero-valued right tail.
 * A vertical segment represents the right-hand limit at a positive endpoint;
 * interpolating from that endpoint to zero would invent additional utility.
 */
export function curvePlotPoints(curve: UsedCurve): UsedCurve['points'] {
  if (!curve.points.length) return [];
  const points = [...curve.points];
  const first = points[0], last = points.at(-1)!;
  if (curve.initial_state !== null && curve.initial_state < first.at) {
    points.unshift({ at: curve.initial_state, sek_per_unit: first.sek_per_unit });
  }
  const right = Math.max(last.at, curve.max_state ?? last.at, curve.initial_state ?? last.at);
  if (right > last.at) {
    if (last.sek_per_unit !== 0) points.push({ at: last.at, sek_per_unit: 0 });
    points.push({ at: right, sek_per_unit: 0 });
  }
  return points;
}
