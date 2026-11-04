/** Mean positive squared deficit along a linearly interpolated water segment. */
function meanSquaredDeficit(a: number, b: number): number {
  if (a <= 0 && b <= 0) return 0;
  return a >= 0 && b >= 0 ? (a*a + a*b + b*b) / 3
    : a > 0 ? a*a*a / (3 * (a-b)) : b*b*b / (3 * (b-a));
}

/** Cold exposure: d² up to 2°C shortfall, then its tangent 4d − 4.
 * Integrates linear interpolation between water readings, including crossings of
 * the target and the 2°C join; this is not a subquarter physics assertion. */
export function poolComfortExposure(targetC: number, beforeC: number, afterC: number, hours: number): number {
  const a = targetC - beforeC, b = targetC - afterC;
  // d₊² − (d − 2)₊² is quadratic near comfort, with a continuous, bounded slope.
  return (meanSquaredDeficit(a, b) - meanSquaredDeficit(a - 2, b - 2)) * hours;
}
