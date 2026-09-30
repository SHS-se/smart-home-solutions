import { marginalValue, validateCurve, type UtilityCurve } from '../../../supabase/functions/_shared/planner/store-value';

/** Only an explicit resize changes the number of points. Preserve the end points. */
export function resizeCurve(curve: UtilityCurve, count: number): UtilityCurve {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Choose a positive whole number of points');
  if (count === curve.points.length) return curve;
  const first = curve.points.length === 1 && count > 1 ? 0 : curve.points[0].at;
  const last = curve.points.at(-1)!.at;
  if (count > 1 && first === last) throw new Error('Give the curve two different energy coordinates before adding points');
  return { unit: curve.unit, points: Array.from({ length: count }, (_, index) => {
    const at = count === 1 ? last : first + (last - first) * index / (count - 1);
    return { at, sek_per_unit: marginalValue(curve, at) };
  }) };
}

/** Pointer and keyboard motion respect the planner's existing diminishing-value rule. */
export function moveCurvePoint(curve: UtilityCurve, index: number, at: number, value: number): UtilityCurve {
  const before = curve.points[index - 1];
  const after = curve.points[index + 1];
  const point = {
    at: Math.max(0, at),
    sek_per_unit: Math.max(after?.sek_per_unit ?? 0, Math.min(before?.sek_per_unit ?? Infinity, value)),
  };
  const next = { unit: curve.unit, points: curve.points.map((p, i) => i === index ? point : p) };
  return validateCurve(next) ? curve : next;
}
