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
export function fitThermalZone(
  samples: ThermalTrainingSample[],
  ratedPowerW: number | null = null,
): ThermalFitResult {
  const usable = samples.filter((sample) =>
    Number.isFinite(sample.room_temperature_c) &&
    Number.isFinite(sample.next_room_temperature_c) &&
    Number.isFinite(sample.outdoor_temperature_c) &&
    Number.isFinite(sample.heat_input_w)
  );
  if (usable.length < MIN_TRAINING_SAMPLES) {
    return {
      ok: false,
      reason: "insufficient_samples",
      sample_count: usable.length,
    };
  }

  const indoor = usable.map((sample) => sample.room_temperature_c);
  const outdoor = usable.map((sample) => sample.outdoor_temperature_c);
  if (Math.abs(correlation(indoor, outdoor)) > MAX_OUTDOOR_CORRELATION) {
    return {
      ok: false,
      reason: "sensor_tracks_outdoor",
      sample_count: usable.length,
    };
  }

  // Design columns: heat input (W), outdoor difference (°C), constant.
  const rows = usable.map((sample) => [
    sample.heat_input_w,
    sample.outdoor_temperature_c - sample.room_temperature_c,
    1,
  ]);
  const targets = usable.map((sample) =>
    (sample.next_room_temperature_c - sample.room_temperature_c) / SLOT_HOURS
  );

  const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const moment = [0, 0, 0];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    for (let i = 0; i < 3; i += 1) {
      moment[i] += row[i] * targets[index];
      for (let j = 0; j < 3; j += 1) normal[i][j] += row[i] * row[j];
    }
  }

  const solution = solveLinearSystem(normal, moment);
  if (solution === null) {
    return { ok: false, reason: "singular", sample_count: usable.length };
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
    return { ok: false, reason: "non_physical", sample_count: usable.length };
  }

  const targetMean = mean(targets);
  let residualSum = 0;
  let totalSum = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const predicted = rows[index][0] * gain + rows[index][1] * cooling +
      background;
    residualSum += (targets[index] - predicted) ** 2;
    totalSum += (targets[index] - targetMean) ** 2;
  }
  const r2 = totalSum > 0 ? 1 - residualSum / totalSum : 0;
  if (!(r2 >= MIN_FIT_R2)) {
    return { ok: false, reason: "poor_fit", sample_count: usable.length };
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
      sample_count: usable.length,
      residual_std_c: Math.sqrt(residualSum / usable.length) * SLOT_HOURS,
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
