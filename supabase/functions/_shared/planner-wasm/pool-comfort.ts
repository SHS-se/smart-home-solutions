/** Squared cold exposure (°C²·h), integrating linear interpolation between water readings.
 * This is a quadrature convention, not an assertion about the subquarter physical path. */
export function poolSquaredExposure(targetC: number, beforeC: number, afterC: number, hours: number): number {
  const a = targetC - beforeC, b = targetC - afterC;
  if (a <= 0 && b <= 0) return 0;
  const mean = a >= 0 && b >= 0 ? (a*a + a*b + b*b) / 3
    : a > 0 ? a*a*a / (3 * (a-b)) : b*b*b / (3 * (b-a));
  return mean * hours;
}
