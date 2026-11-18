/** Shared exact continuous-time endpoint and interval-mean observation kernel. */
/** Exact endpoint and interval-mean coefficients of T'=-kT+gD+F, D'=(P-D)/lag. */
export function roomMeanObservation(k: number, lag: number, hours = .25) {
  const H = hours;
  if (H === 0) return { a: 1, effect: 0, E: 1, V: 0, C: 1, B: 0, U: 0 };
  const a = Math.exp(-k * H), effect = k === 0 ? H : -Math.expm1(-k * H) / k;
  const E = effect / H;
  // Series avoids cancellation as k tends to zero; this is numerical accuracy,
  // not a bound on admissible thermal parameters.
  const V = Math.abs(k * H) < 1e-4
    ? H * (0.5 - k * H / 6 + (k * H) ** 2 / 24 - (k * H) ** 3 / 120)
    : (1 - E) / k;
  if (lag === 0) return { a, effect, E, V, C: 0, B: 0, U: 0 };
  const r = 1 / lag, C = Math.exp(-r * H);
  const equal = Math.abs((k - r) * H) < 1e-7;
  const B = equal ? H * a : (C - a) / (k - r);
  const U = equal ? (1 - a * (1 + k * H)) / (H * k * k)
    : (lag * -Math.expm1(-r * H) - effect) / (H * (k - r));
  return { a, effect, E, V, C, B, U };
}
