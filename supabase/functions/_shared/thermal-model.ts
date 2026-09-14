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
/**
 * Minimum quarters in which the zone was actually heated.
 *
 * Rank deficiency is only the extreme case. A window holding one heated day
 * against twenty unheated ones is not singular, so it solves — and returns a
 * heating gain estimated from almost nothing, usually alongside a healthy R²,
 * because the cooling term explains most of the variance without help. That
 * is worse than a refusal, because it looks like an answer.
 *
 * This matters every autumn, not just at first install: the window refills
 * with unheated summer quarters and the heating gain becomes unidentifiable
 * again until the season is properly under way.
 */
export const MIN_HEATED_SAMPLES = 96; // a day's worth of heated quarters
/** Heat input below this is standby draw, not heating. */
export const HEATED_SAMPLE_MIN_W = 50;
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
  /** Quarters whose heat input exceeded HEATED_SAMPLE_MIN_W. */
  n_heated: number;
  /**
   * Whether the sums below were accumulated over quarters that all carry
   * irradiance, and so whether the solar sums mean anything.
   *
   * Mixing is what this guards against. Moments are only a valid regression
   * if every sum ran over the same rows, so a partly-covered window is
   * restricted to its covered quarters or falls back entirely — never
   * averaged, and never read as though an unrecorded hour had no sun.
   */
  uses_solar?: boolean;
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
  // Solar design column `I`, meaningful only when `uses_solar`.
  s_pi?: number;
  s_di?: number;
  s_ii?: number;
  s_i?: number;
  s_iy?: number;
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
  /** Global horizontal irradiance during the quarter, W/m², where known. */
  solar_w_per_m2?: number | null;
}

export interface ThermalZoneModel {
  /** Temperature rise per watt-hour delivered, °C/Wh. */
  gain_c_per_wh: number;
  /** EMHASS cooling constant γ, per hour per °C. */
  cooling_constant_per_h: number;
  /**
   * Steady background gain, °C/h.
   *
   * Appliances, lighting and occupants — and, on a model with no solar term,
   * the sun as well, averaged flat across bright days and dull ones alike.
   */
  background_gain_c_per_h: number;
  /**
   * Temperature rise per hour per W/m² of global horizontal irradiance.
   *
   * Null on a zone fitted without irradiance, which is the only difference
   * between the two model shapes: everything downstream reads the free-heat
   * rate through `backgroundRateForSlot` and neither knows nor cares which it
   * was given.
   */
  solar_gain_c_per_h_per_wm2?: number | null;
  /**
   * Mean irradiance across the window this zone was fitted on, W/m².
   *
   * Kept so a zone with a solar term can still be projected when no forecast
   * is available: at the mean it reproduces exactly the flat background the
   * three-regressor fit would have published, so losing the forecast costs
   * accuracy without changing the model's meaning.
   */
  solar_mean_w_per_m2?: number | null;
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
  | "insufficient_heating"
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
/**
 * Share of a window that must carry irradiance before the solar term is worth
 * fitting on the covered part alone.
 *
 * Below this the covered quarters are too small a slice of the window to
 * represent it, and a three-regressor fit over everything describes the zone
 * better than a four-regressor fit over a fifth of it.
 */
export const MIN_SOLAR_COVERAGE = 0.8;

export function accumulateMoments(
  samples: ThermalTrainingSample[],
): ThermalMoments {
  // Every sum must run over one set of rows, so the choice of set is made
  // once, up front, rather than per sum.
  const solar = samples.filter((sample) =>
    Number.isFinite(sample.room_temperature_c) &&
    Number.isFinite(sample.next_room_temperature_c) &&
    Number.isFinite(sample.outdoor_temperature_c) &&
    Number.isFinite(sample.heat_input_w) &&
    typeof sample.solar_w_per_m2 === "number" &&
    Number.isFinite(sample.solar_w_per_m2)
  );
  const usable = samples.filter((sample) =>
    Number.isFinite(sample.room_temperature_c) &&
    Number.isFinite(sample.next_room_temperature_c) &&
    Number.isFinite(sample.outdoor_temperature_c) &&
    Number.isFinite(sample.heat_input_w)
  );
  const usesSolar = solar.length >= MIN_TRAINING_SAMPLES &&
    solar.length >= usable.length * MIN_SOLAR_COVERAGE;
  const rows = usesSolar ? solar : usable;

  const moments: ThermalMoments = {
    n: 0,
    n_heated: 0,
    uses_solar: usesSolar,
    s_pi: 0,
    s_di: 0,
    s_ii: 0,
    s_i: 0,
    s_iy: 0,
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
  for (const sample of rows) {
    const p = sample.heat_input_w;
    const d = sample.outdoor_temperature_c - sample.room_temperature_c;
    const y = (sample.next_room_temperature_c - sample.room_temperature_c) /
      SLOT_HOURS;
    moments.n += 1;
    if (p > HEATED_SAMPLE_MIN_W) moments.n_heated += 1;
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
    if (usesSolar) {
      const i = sample.solar_w_per_m2 as number;
      moments.s_pi! += p * i;
      moments.s_di! += d * i;
      moments.s_ii! += i * i;
      moments.s_i! += i;
      moments.s_iy! += i * y;
    }
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

  if ((moments.n_heated ?? 0) < MIN_HEATED_SAMPLES) {
    return {
      ok: false,
      reason: "insufficient_heating",
      sample_count: sampleCount,
    };
  }

  const withoutSolar = () => {
    const solution = solveLinearSystem(
      [
        [moments.s_pp, moments.s_pd, moments.s_p],
        [moments.s_pd, moments.s_dd, moments.s_d],
        [moments.s_p, moments.s_d, sampleCount],
      ],
      [moments.s_py, moments.s_dy, moments.s_y],
    );
    if (solution === null) return null;
    const [gain, cooling, background] = solution;
    // Residual and total sums expand directly from the accumulated moments,
    // so the goodness-of-fit check never needs the original rows either.
    const residual = moments.s_yy -
      2 *
        (gain * moments.s_py + cooling * moments.s_dy +
          background * moments.s_y) +
      (gain * gain * moments.s_pp +
        cooling * cooling * moments.s_dd +
        background * background * sampleCount +
        2 * gain * cooling * moments.s_pd +
        2 * gain * background * moments.s_p +
        2 * cooling * background * moments.s_d);
    return { gain, cooling, background, solar: null, residual };
  };

  // With irradiance the zone gets a fourth column, `s·I`, and the sun stops
  // hiding inside the constant. Everything else about the fit is unchanged:
  // the same normal equations, one row and column wider.
  const withSolar = () => {
    if (!moments.uses_solar) return null;
    const { s_pi = 0, s_di = 0, s_ii = 0, s_i = 0, s_iy = 0 } = moments;
    const solution = solveLinearSystem(
      [
        [moments.s_pp, moments.s_pd, s_pi, moments.s_p],
        [moments.s_pd, moments.s_dd, s_di, moments.s_d],
        [s_pi, s_di, s_ii, s_i],
        [moments.s_p, moments.s_d, s_i, sampleCount],
      ],
      [moments.s_py, moments.s_dy, s_iy, moments.s_y],
    );
    if (solution === null) return null;
    const [gain, cooling, solar, background] = solution;
    // Sunshine cannot cool a room. A negative coefficient means the fit found
    // a correlation rather than the physics — south-facing blinds drawn on the
    // brightest afternoons would do it — so the zone falls back to the flat
    // background rather than being refused outright.
    if (!(solar >= 0) || !Number.isFinite(solar)) return null;
    const residual = moments.s_yy -
      2 *
        (gain * moments.s_py + cooling * moments.s_dy + solar * s_iy +
          background * moments.s_y) +
      (gain * gain * moments.s_pp +
        cooling * cooling * moments.s_dd +
        solar * solar * s_ii +
        background * background * sampleCount +
        2 * gain * cooling * moments.s_pd +
        2 * gain * solar * s_pi +
        2 * gain * background * moments.s_p +
        2 * cooling * solar * s_di +
        2 * cooling * background * moments.s_d +
        2 * solar * background * s_i);
    return { gain, cooling, background, solar, residual };
  };

  const fit = withSolar() ?? withoutSolar();
  if (fit === null) {
    return { ok: false, reason: "singular", sample_count: sampleCount };
  }
  const { gain, cooling, background, solar } = fit;

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

  const residualSum = fit.residual;
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
      solar_gain_c_per_h_per_wm2: solar,
      solar_mean_w_per_m2: solar === null
        ? null
        : (moments.s_i ?? 0) / sampleCount,
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
/**
 * Free heat reaching the zone in one slot, °C/h — everything no heater
 * delivered.
 *
 * The single place the two model shapes differ. Without a solar term this is
 * the flat background, as it always was. With one it is the background plus
 * whatever the sun is doing in that slot, and when no forecast is available it
 * falls back to the mean irradiance the zone was fitted on — which reproduces
 * the flat background exactly, so a missing forecast costs accuracy rather
 * than correctness.
 */
export function backgroundRateForSlot(
  model: ThermalZoneModel,
  index: number,
  solarWPerM2?: (number | null)[] | null,
): number {
  const coefficient = model.solar_gain_c_per_h_per_wm2;
  if (typeof coefficient !== "number" || !Number.isFinite(coefficient)) {
    return model.background_gain_c_per_h;
  }
  const forecast = solarWPerM2?.[index];
  const irradiance = typeof forecast === "number" && Number.isFinite(forecast)
    ? forecast
    : model.solar_mean_w_per_m2 ?? 0;
  return model.background_gain_c_per_h + coefficient * irradiance;
}

export function projectZoneTemperature(
  model: ThermalZoneModel,
  startTemperatureC: number,
  outdoorC: number[],
  heatInputW: number[],
  solarWPerM2?: (number | null)[] | null,
  durationHours?: number[],
): number[] {
  const projection: number[] = [];
  let temperature = startTemperatureC;
  for (let index = 0; index < outdoorC.length; index += 1) {
    projection.push(Math.round(temperature * 1000) / 1000);
    const power = heatInputW[index] ?? 0;
    temperature += (durationHours?.[index] ?? SLOT_HOURS) * (
      model.gain_c_per_wh * power +
      model.cooling_constant_per_h * (outdoorC[index] - temperature) +
      backgroundRateForSlot(model, index, solarWPerM2)
    );
  }
  return projection;
}

/** Convert a quarter's metered energy into the mean power it represents. */
export const quarterEnergyToWatts = (kwh: number): number =>
  (kwh * 1000) / SLOT_HOURS;
