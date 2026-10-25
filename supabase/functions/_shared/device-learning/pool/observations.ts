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
  return new PoolMeanObservation(hours, capacity, responseHours, cop, coolingCPerH, source)
    .read(water, pendingKwh, depletionKwh, powerKw);
}

/** A candidate's fixed observation coefficients. Preparing once avoids
 * recalculating the same exponentials for every quarter and regression basis.
 * Per-reading operations retain their original order; this is not a new model.
 */
export class PoolMeanObservation {
  private readonly rate: number;
  private readonly q: number;
  private readonly J: number;
  private readonly sourceIntegral: number;
  private readonly delayedExponential: number;
  constructor(
    private readonly hours: number,
    private readonly capacity: number,
    private readonly responseHours: number,
    private readonly cop: number,
    private readonly coolingCPerH: number,
    private readonly source: { recovery_rate_per_h: number; heat_loss_per_kwh: number } | null,
  ) {
    const r = this.rate = source?.recovery_rate_per_h ?? 0;
    this.sourceIntegral = source ? integratedExponential(r, hours) : 0;
    this.q = responseHours > 0 ? 1 / responseHours : 0;
    this.J = responseHours > 0 ? integratedExponential(this.q, hours) : 0;
    let delayedExponential = 0;
    if (source && responseHours > 0) {
      const q = this.q, J = this.J;
      if (Math.abs((q - r) * hours) < 1e-6) {
        const x = q * hours;
        delayedExponential = Math.abs(x) < 1e-3
          ? hours * (x / 6 - x * x / 12 + x ** 3 / 40 - x ** 4 / 180)
          : (1 + Math.exp(-x) + 2 * Math.expm1(-x) / x) / q;
      } else delayedExponential = q * (this.sourceIntegral - J) / (q - r);
    }
    this.delayedExponential = delayedExponential;
  }
  read(water: number, pendingKwh: number, depletionKwh: number, powerKw: number): number {
    const { hours, capacity, cop, coolingCPerH, source } = this;
    let constantHeat = cop * powerKw, exponentialHeat = 0;
    if (source) {
      const equilibrium = powerKw / this.rate;
      constantHeat *= 1 - source.heat_loss_per_kwh * equilibrium;
      exponentialHeat = cop * powerKw * source.heat_loss_per_kwh * (equilibrium - depletionKwh);
    }
    if (!(this.responseHours > 0)) {
      return water + (constantHeat * hours / 2 + (source ? exponentialHeat * this.sourceIntegral : 0)) / capacity + coolingCPerH * hours / 2;
    }
    const releasedMean = pendingKwh * this.q * this.J + constantHeat * (hours / 2 - this.J) + exponentialHeat * this.delayedExponential;
    return water + releasedMean / capacity + coolingCPerH * hours / 2;
  }
}
