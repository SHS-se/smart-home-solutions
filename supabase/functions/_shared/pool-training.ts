// Fit the pool's heat loss and its heat pump's COP from measured history.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.10 says these are learned, not asked
// for, and the reason is that neither can honestly be entered. A pool's real
// loss is dominated by evaporation and by whether the cover is on, which no
// surface-area formula knows; and a heat pump's COP in situ is not the number
// on its datasheet.
//
// The model is the same first-order energy balance the room fit uses, written
// for water rather than air:
//
//   ΔT = [ COP(T_air)·E − U·(T_water − T_air)·Δt + g·Δt ] / C
//
// where E is the electrical energy delivered in the slot (kWh), U the loss
// coefficient (kW/K), C the water's heat capacity (kWh/K) and g a background
// term. Dividing through by Δt makes the regression target a rate in °C/h, so
// the residual is readable as how far the model is typically wrong over an hour.
//
// COP is not constant — it falls with air temperature, which is the whole
// reason pool heating is seasonal — so it enters as two regressors rather than
// one: a rated gain and a slope against air temperature. That is exactly the
// `rated_cop` / `cop_per_air_c` pair the planner's model already carries, so a
// fit drops straight into it.

import { solveLinearSystem } from "./thermal-model.ts";
import { WATER_KWH_PER_M3_K } from "./store-models.ts";

export const SLOT_HOURS = 0.25;

/** Air temperature the fitted COP is quoted at, so the slope has an origin. */
export const COP_REFERENCE_AIR_C = 20;

/** Below this a pool is not being heated, it is idling. */
export const HEATED_SLOT_MIN_KWH = 0.05;
/** Quarters needed before a fit is offered at all: two days. */
export const MIN_POOL_SAMPLES = 192;
/**
 * Heated quarters needed before the COP terms mean anything.
 *
 * Rank deficiency is only the extreme case. A window holding four heated
 * quarters against two hundred idle ones is not singular, so it solves — and
 * returns a COP estimated from almost nothing, usually alongside a healthy R²,
 * because the cooling term explains most of the variance unaided. That is worse
 * than a refusal, because it looks like an answer.
 */
export const MIN_HEATED_POOL_SAMPLES = 48;
/** Air-temperature spread needed before the COP *slope* is identifiable. */
export const MIN_AIR_SPREAD_C = 4;
export const MIN_POOL_FIT_R2 = 0.4;

export interface PoolTrainingSample {
  water_temperature_c: number;
  next_water_temperature_c: number;
  outdoor_temperature_c: number;
  /** Electrical energy into the heat pump during the slot, kWh. */
  electrical_kwh: number;
}

export interface PoolFit {
  loss_kw_per_k: number;
  rated_cop: number;
  cop_per_air_c: number;
  background_kw: number;
  r2: number;
  sample_count: number;
  heated_sample_count: number;
}

export type PoolFitRejection =
  | "insufficient_samples"
  | "insufficient_heating"
  | "insufficient_air_spread"
  | "singular"
  | "poor_fit"
  | "unphysical";

export type PoolFitResult =
  | { fitted: PoolFit }
  | { rejected: PoolFitRejection; sample_count: number; heated_sample_count: number };

/**
 * Fit by ordinary least squares on the rate of change.
 *
 * Four regressors: energy, energy scaled by air temperature above the reference
 * (which is the COP slope), the water-to-air difference, and a constant.
 */
export function fitPoolModel(
  samples: PoolTrainingSample[],
  volumeM3: number,
): PoolFitResult {
  const capacityKwhPerK = volumeM3 * WATER_KWH_PER_M3_K;
  const usable = samples.filter((sample) =>
    Number.isFinite(sample.water_temperature_c) &&
    Number.isFinite(sample.next_water_temperature_c) &&
    Number.isFinite(sample.outdoor_temperature_c) &&
    Number.isFinite(sample.electrical_kwh) &&
    sample.electrical_kwh >= 0
  );
  const heated = usable.filter((sample) =>
    sample.electrical_kwh >= HEATED_SLOT_MIN_KWH
  );
  const counts = {
    sample_count: usable.length,
    heated_sample_count: heated.length,
  };
  if (usable.length < MIN_POOL_SAMPLES || capacityKwhPerK <= 0) {
    return { rejected: "insufficient_samples", ...counts };
  }
  if (heated.length < MIN_HEATED_POOL_SAMPLES) {
    return { rejected: "insufficient_heating", ...counts };
  }
  const heatedAir = heated.map((sample) => sample.outdoor_temperature_c);
  if (Math.max(...heatedAir) - Math.min(...heatedAir) < MIN_AIR_SPREAD_C) {
    // Without a spread of air temperatures during heating, the rated COP and
    // its slope are collinear: any pair that produces the same COP at the one
    // observed temperature fits equally well.
    return { rejected: "insufficient_air_spread", ...counts };
  }

  const rows = usable.map((sample) => {
    const powerKw = sample.electrical_kwh / SLOT_HOURS;
    return {
      // °C per hour, the quantity being explained.
      rate: (sample.next_water_temperature_c - sample.water_temperature_c) /
        SLOT_HOURS,
      x: [
        powerKw,
        powerKw * (sample.outdoor_temperature_c - COP_REFERENCE_AIR_C),
        sample.water_temperature_c - sample.outdoor_temperature_c,
        1,
      ],
    };
  });

  const size = 4;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
  const vector = new Array(size).fill(0);
  for (const row of rows) {
    for (let i = 0; i < size; i += 1) {
      vector[i] += row.x[i] * row.rate;
      for (let j = 0; j < size; j += 1) matrix[i][j] += row.x[i] * row.x[j];
    }
  }
  const solution = solveLinearSystem(matrix, vector);
  if (!solution || solution.some((value) => !Number.isFinite(value))) {
    return { rejected: "singular", ...counts };
  }

  const [gain, gainPerAir, cooling, background] = solution;
  const meanRate = rows.reduce((total, row) => total + row.rate, 0) / rows.length;
  let ssTotal = 0;
  let ssResidual = 0;
  for (const row of rows) {
    const predicted = row.x.reduce(
      (total, value, index) => total + value * solution[index],
      0,
    );
    ssTotal += (row.rate - meanRate) ** 2;
    ssResidual += (row.rate - predicted) ** 2;
  }
  const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;
  if (r2 < MIN_POOL_FIT_R2) return { rejected: "poor_fit", ...counts };

  // Convert the regression's coefficients back into physical parameters.
  // `gain` is °C per hour per kW, so multiplying by the heat capacity gives the
  // heat delivered per kW of electricity — the COP.
  const ratedCop = gain * capacityKwhPerK;
  const lossKwPerK = -cooling * capacityKwhPerK;
  const copPerAirC = ratedCop > 0
    ? (gainPerAir * capacityKwhPerK) / ratedCop
    : 0;

  // A pool that gains heat when it is warmer than the air, or a heat pump that
  // returns less heat than the electricity it drew, is not a model worth
  // planning against however well it fits.
  if (
    !(ratedCop > 1) || !(ratedCop < 12) ||
    !(lossKwPerK > 0) || !(lossKwPerK < 20) ||
    !Number.isFinite(copPerAirC) || Math.abs(copPerAirC) > 0.2
  ) {
    return { rejected: "unphysical", ...counts };
  }

  return {
    fitted: {
      loss_kw_per_k: Number(lossKwPerK.toFixed(4)),
      rated_cop: Number(ratedCop.toFixed(3)),
      cop_per_air_c: Number(copPerAirC.toFixed(5)),
      background_kw: Number((background * capacityKwhPerK).toFixed(4)),
      r2: Number(r2.toFixed(4)),
      ...counts,
    },
  };
}
