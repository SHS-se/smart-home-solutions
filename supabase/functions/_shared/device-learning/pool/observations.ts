/** Observation timing is part of calibration, never a different planning plant. */
export type PoolObservation = "interval_start" | "quarter_mean";

/** Mean integral of (1-exp(-rate*t))/rate, with its numerical zero-rate limit. */
function integratedExponential(rate: number, hours: number): number {
  const x = rate * hours;
  return Math.abs(x) < 1e-4
    ? hours * (.5 - x / 6 + x * x / 24 - x ** 3 / 120)
    : (1 + Math.expm1(-x) / x) / rate;
}

/** Exact mean water temperature during a constant-electricity interval.
 * Source heat is A+B*exp(-recoveryRate*t); pending heat filters that same
 * signal. This observes the existing ODE without changing its endpoint law.
 */
export function poolQuarterMean(
  water: number, pendingKwh: number, depletionKwh: number, powerKw: number,
  hours: number, capacity: number, responseHours: number, cop: number,
  coolingCPerH: number,
  source: { recovery_rate_per_h: number; heat_loss_per_kwh: number } | null,
): number {
  let constantHeat = cop * powerKw, exponentialHeat = 0;
  const r = source?.recovery_rate_per_h ?? 0;
  if (source) {
    const equilibrium = powerKw / r;
    constantHeat *= 1 - source.heat_loss_per_kwh * equilibrium;
    exponentialHeat = cop * powerKw * source.heat_loss_per_kwh * (equilibrium - depletionKwh);
  }
  if (!(responseHours > 0)) {
    return water + (constantHeat * hours / 2 + (source ? exponentialHeat * integratedExponential(r, hours) : 0)) / capacity + coolingCPerH * hours / 2;
  }
  const q = 1 / responseHours, J = integratedExponential(q, hours);
  let delayedExponential = 0;
  if (source) {
    if (Math.abs((q - r) * hours) < 1e-6) {
      const x = q * hours;
      delayedExponential = Math.abs(x) < 1e-3
        ? hours * (x / 6 - x * x / 12 + x ** 3 / 40 - x ** 4 / 180)
        : (1 + Math.exp(-x) + 2 * Math.expm1(-x) / x) / q;
    } else delayedExponential = q * (integratedExponential(r, hours) - J) / (q - r);
  }
  const releasedMean = pendingKwh * q * J + constantHeat * (hours / 2 - J) + exponentialHeat * delayedExponential;
  return water + releasedMean / capacity + coolingCPerH * hours / 2;
}
