/** Degree-hours below target − 1°C, integrating linearly between water readings.
 * This quadrature convention is not an assertion about subquarter physics. */
export function poolComfortExposure(targetC: number, beforeC: number, afterC: number, hours: number): number {
  const a = targetC - beforeC - 1, b = targetC - afterC - 1;
  if (a <= 0 && b <= 0) return 0;
  if (a >= 0 && b >= 0) return (a + b) / 2 * hours;
  const positive = Math.max(a, b);
  return positive * (positive / Math.abs(b - a)) / 2 * hours;
}
