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

import { solveLinearSystem } from "./planner/thermal-model.ts";
import { WATER_KWH_PER_M3_K } from "./planner/store-models.ts";

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

/**
 * Where a pool fit's training window starts.
 *
 * The rolling window alone assumes the machine at the end of it is the machine
 * at the start. Replacing a pool heat pump breaks that, and the blend does not
 * fail loudly: `MIN_POOL_FIT_R2` is easy to clear because the cooling term
 * explains most of the variance unaided, so a window straddling two units
 * returns a confident COP for a machine that never existed. That is the same
 * failure `MIN_HEATED_POOL_SAMPLES` guards against, one level up.
 *
 * `epochStartMs` is the instant the current heat pump began serving the pool —
 * a commissioning fact, §9.1 "hard installation" class, never inferred. Samples
 * before it describe different hardware and are excluded, whatever the rolling
 * window would otherwise admit. Null leaves the window as it was.
 *
 * The loss coefficient is a property of the pool rather than of the machine
 * heating it, so in principle it could be fitted across the boundary. It is not,
 * because `fitPoolModel` solves loss and COP together in one regression. Until
 * that splits, a home crossing an epoch waits for post-epoch data and plans on
 * seeded figures meanwhile — which is what it already does before any fit
 * converges.
 */
export function poolTrainingWindowStartMs(
  nowMs: number,
  epochStartMs: number | null,
  windowDays: number,
): number {
  const rolling = nowMs - windowDays * 86_400_000;
  if (epochStartMs === null || !Number.isFinite(epochStartMs)) return rolling;
  return Math.max(rolling, epochStartMs);
}

/**
 * Whether a pool refit is due.
 *
 * Normally a fixed interval, because a fit that moves faster than the physics
 * is noise. The exception is an epoch recorded after the standing fit was
 * made: that fit describes the previous machine, and waiting out the interval
 * would plan against it for up to a day after someone stated it was wrong.
 */
export function poolRefitIsDue(
  nowMs: number,
  fittedAtMs: number,
  epochStartMs: number | null,
  intervalHours: number,
): boolean {
  if (epochStartMs !== null && Number.isFinite(epochStartMs)) {
    if (epochStartMs > fittedAtMs) return true;
  }
  return nowMs - fittedAtMs >= intervalHours * 3_600_000;
}

/** Quarters after heating stops before the water reading describes cooling again. */
export const POOL_LOSS_SETTLE_QUARTERS = 8;
/** Settled idle quarters an unbroken stretch needs before it counts. */
export const MIN_POOL_LOSS_RUN_QUARTERS = 16;
/** Settled idle hours needed before a loss is offered at all. */
export const MIN_POOL_LOSS_HOURS = 24;

export interface PoolLossSample extends PoolTrainingSample {
  /** Start of the quarter, so unbroken stretches can be told from gaps. */
  start_ms: number;
}

export interface PoolLossFit {
  loss_kw_per_k: number;
  hours: number;
  run_count: number;
}

export type PoolLossFitResult =
  | { fitted: PoolLossFit }
  | { rejected: "insufficient_idle" | "unphysical"; hours: number; run_count: number };

/**
 * The pool's heat loss from the stretches when nothing was heating it.
 *
 * Split from `fitPoolModel` because the two answers need different evidence:
 * the COP needs heating across a spread of air temperatures, which a season can
 * withhold for months, while the loss is measured every night the heater is off.
 * Tying them together left the planner on its seeded 0.35 kW/K for a pool whose
 * unheated nights measured 0.07–0.16, and a pool believed to leak several times
 * too fast is one the planner never heats early.
 *
 * Each unbroken idle stretch is judged end to end — how far the water fell
 * against how much water-to-air difference it spent — rather than quarter by
 * quarter, because a reading that jumps a tenth of a degree when the pump stops
 * swamps a fifteen-minute rate but not a ten-hour one. The first
 * `POOL_LOSS_SETTLE_QUARTERS` after heating are left out: the water is still
 * mixing and the sensor still settling.
 *
 * There is no background or solar term. The planner's pool model has neither,
 * so the loss it needs is the net one: what the pool actually lost per kelvin,
 * sunshine included. Fitting a gain it cannot use would make the loss right and
 * the plan wrong.
 */
export function fitPoolLoss(
  samples: PoolLossSample[],
  volumeM3: number,
): PoolLossFitResult {
  const capacityKwhPerK = volumeM3 * WATER_KWH_PER_M3_K;
  const ordered = samples
    .filter((sample) =>
      Number.isFinite(sample.start_ms) &&
      Number.isFinite(sample.water_temperature_c) &&
      Number.isFinite(sample.next_water_temperature_c) &&
      Number.isFinite(sample.outdoor_temperature_c) &&
      Number.isFinite(sample.electrical_kwh)
    )
    .sort((a, b) => a.start_ms - b.start_ms);
  const runs: PoolLossSample[][] = [];
  let run: PoolLossSample[] = [];
  let idle = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];
    const unbroken = index > 0 &&
      sample.start_ms - ordered[index - 1].start_ms === SLOT_HOURS * 3_600_000;
    const heated = sample.electrical_kwh >= HEATED_SLOT_MIN_KWH;
    if (!unbroken || heated) {
      if (run.length) runs.push(run);
      run = [];
      idle = 0;
    }
    if (heated) continue;
    idle += 1;
    if (idle > POOL_LOSS_SETTLE_QUARTERS) run.push(sample);
  }
  if (run.length) runs.push(run);

  let fallC = 0;
  let exposureKh = 0;
  let quarters = 0;
  let runCount = 0;
  for (const stretch of runs) {
    if (stretch.length < MIN_POOL_LOSS_RUN_QUARTERS) continue;
    fallC += stretch[0].water_temperature_c -
      stretch[stretch.length - 1].next_water_temperature_c;
    exposureKh += stretch.reduce((total, sample) =>
      total + (sample.water_temperature_c - sample.outdoor_temperature_c) * SLOT_HOURS, 0);
    quarters += stretch.length;
    runCount += 1;
  }
  const hours = quarters * SLOT_HOURS;
  const counts = { hours, run_count: runCount };
  if (hours < MIN_POOL_LOSS_HOURS || capacityKwhPerK <= 0) {
    return { rejected: "insufficient_idle", ...counts };
  }
  const lossKwPerK = fallC * capacityKwhPerK / exposureKh;
  // A pool warmer than the air that warmed on its own, or one colder than it,
  // is not a loss coefficient however long it was watched.
  if (!(exposureKh > 0) || !(lossKwPerK > 0) || !(lossKwPerK < 20)) {
    return { rejected: "unphysical", ...counts };
  }
  return {
    fitted: { loss_kw_per_k: Number(lossKwPerK.toFixed(4)), ...counts },
  };
}

/** Width of the water-temperature bins the measured response is kept in, °C. */
export const POOL_RESPONSE_BIN_C = 0.25;
/** Settled idle hours a bin needs before its cooling rate is offered. */
export const MIN_POOL_RESPONSE_IDLE_HOURS = 3;
/** Heater energy a bin needs before its warming per kWh is offered. */
export const MIN_POOL_RESPONSE_HEATED_KWH = 3;

export type PoolResponseSample = Pick<
  PoolLossSample,
  "start_ms" | "water_temperature_c" | "next_water_temperature_c" | "electrical_kwh"
>;

export interface PoolResponseBin {
  /** Centre of the bin, °C of water. */
  at_c: number;
  /** How fast the unheated pool's reading moved here, °C per hour; null with too little idle time. */
  idle_c_per_h: number | null;
  idle_hours: number;
  /** What a kWh into the heater added to the reading here, over what idling would have done; null with too little heating. */
  heat_c_per_kwh: number | null;
  heated_kwh: number;
}

/**
 * What the pool's water temperature was measured to do, by the temperature it
 * was at: how fast it fell when nothing heated it, and how far a kWh raised it.
 *
 * A single loss coefficient says the pool cools in proportion to how much
 * warmer it is than the air, and a COP says a kWh always buys the same heat.
 * A real pool does neither everywhere. Phil's holds near 29 °C for half a day
 * on its way down, and takes some thirty kWh of heat to leave it again on the
 * way up, with both of its temperature sensors agreeing; either side of that
 * it cools at a steady rate and warms as its heat pump's output says it
 * should. Where the heat goes and comes back from is not known. What it does
 * to the reading is, and that is what a plan is judged on, so it is kept as
 * measured: one rate and one gain per quarter-degree bin, nothing assumed
 * about the shape between them.
 *
 * Both are ratios of sums over every quarter that started in the bin, not
 * averages of quarter rates, so a reading that steps a hundredth at a time
 * weighs what it should. The quarters just after a run, while the water is
 * still mixing, count toward the run's gain and not toward idle cooling.
 */
export function fitPoolResponse(samples: PoolResponseSample[]): PoolResponseBin[] {
  const ordered = samples
    .filter((sample) =>
      Number.isFinite(sample.start_ms) &&
      Number.isFinite(sample.water_temperature_c) &&
      Number.isFinite(sample.next_water_temperature_c) &&
      Number.isFinite(sample.electrical_kwh)
    )
    .sort((a, b) => a.start_ms - b.start_ms);
  const bins = new Map<number, { idleC: number; idleHours: number; heatC: number; heatHours: number; kwh: number }>();
  const binOf = (waterC: number) => {
    const key = Math.floor(waterC / POOL_RESPONSE_BIN_C);
    if (!bins.has(key)) bins.set(key, { idleC: 0, idleHours: 0, heatC: 0, heatHours: 0, kwh: 0 });
    return bins.get(key)!;
  };
  // Quarters since the heater last ran; a gap in the record starts the count again.
  let idle = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];
    const unbroken = index > 0 &&
      sample.start_ms - ordered[index - 1].start_ms === SLOT_HOURS * 3_600_000;
    const heated = sample.electrical_kwh >= HEATED_SLOT_MIN_KWH;
    if (!unbroken) idle = heated ? 0 : POOL_LOSS_SETTLE_QUARTERS + 1;
    else idle = heated ? 0 : idle + 1;
    const bin = binOf(sample.water_temperature_c);
    const change = sample.next_water_temperature_c - sample.water_temperature_c;
    if (heated || idle <= POOL_LOSS_SETTLE_QUARTERS) {
      bin.heatC += change;
      bin.heatHours += SLOT_HOURS;
      bin.kwh += Math.max(0, sample.electrical_kwh);
    } else {
      bin.idleC += change;
      bin.idleHours += SLOT_HOURS;
    }
  }
  const settled = [...bins.values()].filter((bin) => bin.idleHours >= MIN_POOL_RESPONSE_IDLE_HOURS);
  const idleHours = settled.reduce((sum, bin) => sum + bin.idleHours, 0);
  // Where a bin has no idle time of its own, heating there is set against the pool's usual cooling.
  const usualIdle = idleHours > 0 ? settled.reduce((sum, bin) => sum + bin.idleC, 0) / idleHours : 0;
  return [...bins.entries()].sort(([a], [b]) => a - b).map(([key, bin]) => {
    const idleRate = bin.idleHours >= MIN_POOL_RESPONSE_IDLE_HOURS ? bin.idleC / bin.idleHours : null;
    const gain = bin.kwh >= MIN_POOL_RESPONSE_HEATED_KWH
      ? (bin.heatC - (idleRate ?? usualIdle) * bin.heatHours) / bin.kwh
      : null;
    return {
      at_c: Number(((key + 0.5) * POOL_RESPONSE_BIN_C).toFixed(3)),
      idle_c_per_h: idleRate === null ? null : Number(idleRate.toFixed(4)),
      idle_hours: bin.idleHours,
      heat_c_per_kwh: gain === null ? null : Number(gain.toFixed(4)),
      heated_kwh: Number(bin.kwh.toFixed(2)),
    };
  }).filter((bin) => bin.idle_c_per_h !== null || bin.heat_c_per_kwh !== null);
}
