// Empirical per-zone thermal model fitted from Home Assistant history.
//
// The model is the standard first-order (1R1C) lumped-capacitance zone,
// written in the same parameterisation EMHASS uses so a fitted zone stays
// portable and comparable:
//
//   T[k+1] = T[k] + a·P[k]·Δt − γ·Δt·(T[k] − T_out[k]) + g·Δt
//
// where P is the heat delivered into the zone (W), γ is the cooling constant
// (per hour, per °C of indoor-outdoor difference) and a is the temperature
// rise per watt-hour. EMHASS's `heating_rate` is a·P_nom and its
// `cooling_constant` is γ, so both fall straight out of the fit.
//
// The `g` term is the part hand-rolled heat-loss calculations usually omit,
// and omitting it is not a rounding error. A house is heated by far more than
// its heaters: every watt of lighting, cooking, refrigeration and electronics
// ends up as heat indoors, as do the occupants and any sun through the
// windows. Attribute the whole indoor-outdoor difference to heater output
// alone and the fitted heat loss comes out systematically low, because the
// envelope was really losing heater output *plus* all of that. Carrying `g`
// as a free parameter lets the regression discover those gains instead of
// silently folding them into the loss coefficient.
//
// Fitting the difference equation rather than a steady-state ratio also
// removes the other classic error. `UA = Q/ΔT` is only true when the zone is
// neither warming nor cooling; on any real day some energy goes into the
// structure instead of through the walls. Regressing the *rate of change*
// keeps that storage term where it belongs, in `a`.

export const SLOT_HOURS = 0.25;

/** Minimum quarters before a fit is offered at all. */
export const MIN_TRAINING_SAMPLES = 480; // five days of quarters
/** Minimum share of variance explained before a fit is published. */
export const MIN_FIT_R2 = 0.5;
/**
 * A room sensor tracking outdoor air this closely is not measuring a room.
 * This catches a zone mapped to an outdoor or unheated-space sensor, which
 * would otherwise fit a physically absurd model with high confidence.
 */
export const MAX_OUTDOOR_CORRELATION = 0.95;

/**
 * Accumulated regression sums for one zone.
 *
 * A month of quarters for a whole house is tens of thousands of rows, and
 * shipping them into a function only to reduce them to fourteen numbers is
 * pure waste. The database accumulates these directly, so the fit stays a
 * 3x3 solve regardless of how much history a home has.
 *
 * The design columns are heat input `P`, outdoor difference `D = T_out - T_in`
 * and a constant; the target `y` is the observed rate of change in °C/h.
 */
export interface ThermalMoments {
  n: number;
  s_pp: number;
  s_pd: number;
  s_p: number;
  s_dd: number;
  s_d: number;
  s_py: number;
  s_dy: number;
  s_y: number;
  s_yy: number;
  // Retained so the outdoor-tracking guard survives the move into SQL.
  s_in: number;
  s_out: number;
  s_inin: number;
  s_outout: number;
  s_inout: number;
}

export interface ThermalTrainingSample {
  /** Indoor temperature at the start of the quarter. */
  room_temperature_c: number;
  /** Indoor temperature at the start of the next quarter. */
  next_room_temperature_c: number;
  /** Outdoor temperature during the quarter. */
  outdoor_temperature_c: number;
  /** Mean heat delivered into the zone during the quarter, in watts. */
  heat_input_w: number;
}

export interface ThermalZoneModel {
  /** Temperature rise per watt-hour delivered, °C/Wh. */
  gain_c_per_wh: number;
  /** EMHASS cooling constant γ, per hour per °C. */
  cooling_constant_per_h: number;
  /** Steady background gain from appliances, occupants and sun, °C/h. */
  background_gain_c_per_h: number;
  /** Derived lumped heat capacity, Wh/°C. */
  thermal_capacity_wh_per_c: number;
  /** Derived envelope loss coefficient, W/°C. */
  heat_loss_w_per_c: number;
  /** Derived time constant, hours. */
  time_constant_h: number;
  /** EMHASS `heating_rate` at the zone's rated power, °C/h. */
  heating_rate_c_per_h: number | null;
  r2: number;
  sample_count: number;
  residual_std_c: number;
}

export type ThermalFitRejection =
  | "insufficient_samples"
  | "singular"
  | "poor_fit"
  | "non_physical"
  | "sensor_tracks_outdoor";

export type ThermalFitResult =
  | { ok: true; model: ThermalZoneModel }
  | { ok: false; reason: ThermalFitRejection; sample_count: number };

const mean = (values: number[]) =>
  values.reduce((total, value) => total + value, 0) / values.length;

/** Pearson correlation; 0 when either series is constant. */
export function correlation(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 2) return 0;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const dl = left[index] - leftMean;
    const dr = right[index] - rightMean;
    covariance += dl * dr;
    leftVariance += dl * dl;
    rightVariance += dr * dr;
  }
  if (leftVariance <= 0 || rightVariance <= 0) return 0;
  return covariance / Math.sqrt(leftVariance * rightVariance);
}

/**
 * Solve a small symmetric normal-equation system by Gauss-Jordan elimination
 * with partial pivoting. Returns null when the design is rank-deficient,
 * which happens when a zone's heater never ran or the outdoor difference
 * never varied — both of which make the parameters unidentifiable rather
 * than merely imprecise.
 */
export function solveLinearSystem(
  matrix: number[][],
  vector: number[],
): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (
        Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])
      ) {
        pivotRow = row;
      }
    }
    const pivot = augmented[pivotRow][column];
    if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-12) return null;
    [augmented[column], augmented[pivotRow]] = [
      augmented[pivotRow],
      augmented[column],
    ];
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column] / augmented[column][column];
      if (factor === 0) continue;
      for (let target = column; target <= size; target += 1) {
        augmented[row][target] -= factor * augmented[column][target];
      }
    }
  }

  // Elimination cleared every off-diagonal entry but left the diagonal
  // unnormalised, so each unknown is its row's constant over its own pivot.
  return augmented.map((row, index) => row[size] / row[index]);
}

/**
 * Fit one zone by ordinary least squares on the difference equation.
 *
 * The regression target is the observed rate of change, and the three
 * regressors are heat input, the outdoor temperature difference, and a
 * constant. Solving for the rate rather than the next temperature keeps the
 * residual in physical units (°C/h) so `residual_std_c` is directly readable
 * as how far the model is typically wrong over a quarter.
 */
export function accumulateMoments(
  samples: ThermalTrainingSample[],
): ThermalMoments {
  const moments: ThermalMoments = {
    n: 0,
    s_pp: 0,
    s_pd: 0,
    s_p: 0,
    s_dd: 0,
    s_d: 0,
    s_py: 0,
    s_dy: 0,
    s_y: 0,
    s_yy: 0,
    s_in: 0,
    s_out: 0,
    s_inin: 0,
    s_outout: 0,
    s_inout: 0,
  };
  for (const sample of samples) {
    if (
      !Number.isFinite(sample.room_temperature_c) ||
      !Number.isFinite(sample.next_room_temperature_c) ||
      !Number.isFinite(sample.outdoor_temperature_c) ||
      !Number.isFinite(sample.heat_input_w)
    ) continue;
    const p = sample.heat_input_w;
    const d = sample.outdoor_temperature_c - sample.room_temperature_c;
    const y =
      (sample.next_room_temperature_c - sample.room_temperature_c) / SLOT_HOURS;
    moments.n += 1;
    moments.s_pp += p * p;
    moments.s_pd += p * d;
    moments.s_p += p;
    moments.s_dd += d * d;
    moments.s_d += d;
    moments.s_py += p * y;
    moments.s_dy += d * y;
    moments.s_y += y;
    moments.s_yy += y * y;
    moments.s_in += sample.room_temperature_c;
    moments.s_out += sample.outdoor_temperature_c;
    moments.s_inin += sample.room_temperature_c ** 2;
    moments.s_outout += sample.outdoor_temperature_c ** 2;
    moments.s_inout += sample.room_temperature_c * sample.outdoor_temperature_c;
  }
  return moments;
}

/** Pearson correlation reconstructed from accumulated sums. */
export function correlationFromMoments(moments: ThermalMoments): number {
  const { n, s_in, s_out, s_inin, s_outout, s_inout } = moments;
  if (n < 2) return 0;
  const covariance = s_inout - (s_in * s_out) / n;
  const indoorVariance = s_inin - (s_in * s_in) / n;
  const outdoorVariance = s_outout - (s_out * s_out) / n;
  if (indoorVariance <= 0 || outdoorVariance <= 0) return 0;
  return covariance / Math.sqrt(indoorVariance * outdoorVariance);
}

export function fitThermalZone(
  samples: ThermalTrainingSample[],
  ratedPowerW: number | null = null,
): ThermalFitResult {
  return fitThermalZoneFromMoments(accumulateMoments(samples), ratedPowerW);
}

export function fitThermalZoneFromMoments(
  moments: ThermalMoments,
  ratedPowerW: number | null = null,
): ThermalFitResult {
  const sampleCount = moments.n;
  if (sampleCount < MIN_TRAINING_SAMPLES) {
    return {
      ok: false,
      reason: "insufficient_samples",
      sample_count: sampleCount,
    };
  }

  if (Math.abs(correlationFromMoments(moments)) > MAX_OUTDOOR_CORRELATION) {
    return {
      ok: false,
      reason: "sensor_tracks_outdoor",
      sample_count: sampleCount,
    };
  }

  const solution = solveLinearSystem(
    [
      [moments.s_pp, moments.s_pd, moments.s_p],
      [moments.s_pd, moments.s_dd, moments.s_d],
      [moments.s_p, moments.s_d, sampleCount],
    ],
    [moments.s_py, moments.s_dy, moments.s_y],
  );
  if (solution === null) {
    return { ok: false, reason: "singular", sample_count: sampleCount };
  }
  const [gain, cooling, background] = solution;

  // A zone that warms when heated and cools toward outdoor air has both
  // coefficients positive. A negative one means the fit latched onto a
  // correlation with no physical reading, so it is refused rather than
  // published with a caveat.
  if (
    !(gain > 0) || !(cooling > 0) || !Number.isFinite(background) ||
    !Number.isFinite(gain) || !Number.isFinite(cooling)
  ) {
    return { ok: false, reason: "non_physical", sample_count: sampleCount };
  }

  // Residual and total sums expand directly from the accumulated moments, so
  // the goodness-of-fit check never needs the original rows either.
  const residualSum = moments.s_yy -
    2 * (gain * moments.s_py + cooling * moments.s_dy + background * moments.s_y) +
    (gain * gain * moments.s_pp +
      cooling * cooling * moments.s_dd +
      background * background * sampleCount +
      2 * gain * cooling * moments.s_pd +
      2 * gain * background * moments.s_p +
      2 * cooling * background * moments.s_d);
  const totalSum = moments.s_yy - (moments.s_y * moments.s_y) / sampleCount;
  const r2 = totalSum > 0 ? 1 - residualSum / totalSum : 0;
  if (!(r2 >= MIN_FIT_R2)) {
    return { ok: false, reason: "poor_fit", sample_count: sampleCount };
  }

  // a = 1/C gives the lumped capacity directly, and UA follows from the time
  // constant. These are the numbers a heat-loss survey would quote, derived
  // rather than assumed.
  const capacity = 1 / gain;
  return {
    ok: true,
    model: {
      gain_c_per_wh: gain,
      cooling_constant_per_h: cooling,
      background_gain_c_per_h: background,
      thermal_capacity_wh_per_c: capacity,
      heat_loss_w_per_c: cooling * capacity,
      time_constant_h: 1 / cooling,
      heating_rate_c_per_h: ratedPowerW && ratedPowerW > 0
        ? gain * ratedPowerW
        : null,
      r2,
      sample_count: sampleCount,
      residual_std_c: Math.sqrt(Math.max(residualSum, 0) / sampleCount) *
        SLOT_HOURS,
    },
  };
}

/**
 * Roll a fitted zone forward over a planning horizon.
 *
 * Used both to draw the Thermal tab's projection and, once the executor
 * exists, to check that a candidate schedule keeps the zone inside its
 * comfort band.
 */
export function projectZoneTemperature(
  model: ThermalZoneModel,
  startTemperatureC: number,
  outdoorC: number[],
  heatInputW: number[],
): number[] {
  const projection: number[] = [];
  let temperature = startTemperatureC;
  for (let index = 0; index < outdoorC.length; index += 1) {
    projection.push(Math.round(temperature * 1000) / 1000);
    const power = heatInputW[index] ?? 0;
    temperature += SLOT_HOURS * (
      model.gain_c_per_wh * power +
      model.cooling_constant_per_h * (outdoorC[index] - temperature) +
      model.background_gain_c_per_h
    );
  }
  return projection;
}

/** Convert a quarter's metered energy into the mean power it represents. */
export const quarterEnergyToWatts = (kwh: number): number =>
  (kwh * 1000) / SLOT_HOURS;
