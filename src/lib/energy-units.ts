/**
 * Energy unit helpers.
 * All power values are stored in W in the database.
 * Display converts to kW when value >= 1000 W.
 */

export interface FormattedPower {
  value: number;
  unit: 'W' | 'kW';
  display: string;
}

/** Format watts for display – switches to kW when >= 1000 W */
export function formatPower(watts: number): FormattedPower {
  if (Math.abs(watts) >= 1000) {
    const kw = watts / 1000;
    return {
      value: parseFloat(kw.toFixed(1)),
      unit: 'kW',
      display: `${parseFloat(kw.toFixed(1))} kW`,
    };
  }
  return {
    value: Math.round(watts),
    unit: 'W',
    display: `${Math.round(watts)} W`,
  };
}

/** Convert kW to W */
export function toWatts(kw: number): number {
  return kw * 1000;
}

/** Convert W to kW */
export function toKw(w: number): number {
  return w / 1000;
}
