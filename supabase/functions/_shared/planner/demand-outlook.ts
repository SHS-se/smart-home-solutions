// How much the household will draw, against what its forecast says.
//
// The base-load forecast a plan arrives with is Home Assistant's average of the
// last ten days. Two things are wrong with planning a battery on it as given:
//
//   - **Level.** An average of ten days trails a change by five. Going into
//     autumn the house draws more every week and the forecast is short every
//     day; going into spring it is long. The recent days' own forecasts, set
//     beside what those days then drew, say by how much.
//   - **Spread.** Even a forecast at the right level is the middle of what can
//     happen, and a battery charged for the middle is empty on half the
//     evenings. What running short costs (the dear hour, bought from the grid)
//     and what holding too much costs (a kWh that waits for tomorrow, or takes
//     the place of sun that would have filled the pack for nothing) are not
//     equal, so the demand worth planning for is not the middle. Which point of
//     the spread it is follows from those two costs, quarter prices and the sun
//     ahead; no season is named anywhere.
//
// Both come from the same evidence: per matured day, what was forecast the day
// before and what was drawn. With no evidence the forecast is planned as given.

export interface DemandDay {
  /** Local day, YYYY-MM-DD. */
  day: string;
  /** What the forecast issued the day before said the day's base load would be. */
  forecast_kwh: number;
  /** What it was. */
  actual_kwh: number;
}

/** A day counts half as much towards the level this many days later. */
export const DEMAND_LEVEL_HALF_LIFE_DAYS = 5;
/** Days at "the forecast is right" the evidence has to outweigh. */
const LEVEL_PRIOR_DAYS = 1;
/** Fewer matured days than this say nothing yet. */
export const DEMAND_MIN_DAYS = 5;
/** Days older than this are another season. */
const EVIDENCE_WINDOW_DAYS = 28;
/** The level is a correction to a forecast, not a replacement for one. */
const LEVEL_BOUNDS = [0.75, 1.6] as const;
/** A margin beyond this is a forecast nobody should be planning on at all. */
const MAX_MARGIN = 1.5;
/**
 * The furthest point of the spread ever planned for: the demand exceeded three
 * days in ten. The two costs alone often say to go much further, but they leave
 * out that a kWh bought for a demand that does not come may have been bought
 * dearer than tomorrow's cheap hour turns out to be. On the planner bench,
 * planning past this point cost more than it saved (docs/planner-bench/demand.md).
 */
const MAX_QUANTILE = 0.7;
/**
 * What a kWh held one more day costs, SEK: standby loss and the chance that
 * tomorrow's cheap hour is cheaper still. Keeps "holding costs nothing" from
 * turning every plan into a full pack.
 */
const HOLDING_SEK_PER_KWH = 0.05;

export interface DemandLevel {
  /** Recent draw over recent forecast, shrunk towards 1; multiplies the base-load forecast. */
  factor: number;
  /** Day-to-day spread of draw around the levelled forecast, as a share of it. */
  spread: number;
  days: number;
  effective_days: number;
}

const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The level and spread the evidence supports for plans made on `today`, or null when it supports neither. */
export function demandLevel(days: readonly DemandDay[] | null | undefined, today: string): DemandLevel | null {
  const now = dayNumber(today);
  const usable = (days ?? []).flatMap((entry) => {
    const age = now - dayNumber(entry.day);
    return Number.isFinite(age) && age >= 1 && age <= EVIDENCE_WINDOW_DAYS &&
        Number.isFinite(entry.forecast_kwh) && entry.forecast_kwh > 0 &&
        Number.isFinite(entry.actual_kwh) && entry.actual_kwh > 0
      ? [{ ...entry, weight: 2 ** (-(age - 1) / DEMAND_LEVEL_HALF_LIFE_DAYS) }]
      : [];
  });
  if (usable.length < DEMAND_MIN_DAYS) return null;
  const weight = usable.reduce((sum, entry) => sum + entry.weight, 0);
  const meanForecast = usable.reduce((sum, entry) => sum + entry.weight * entry.forecast_kwh, 0) / weight;
  const meanActual = usable.reduce((sum, entry) => sum + entry.weight * entry.actual_kwh, 0) / weight;
  const factor = clamp(
    (weight * meanActual + LEVEL_PRIOR_DAYS * meanForecast) / ((weight + LEVEL_PRIOR_DAYS) * meanForecast),
    ...LEVEL_BOUNDS,
  );
  // Spread is what is left once the level is taken out, every day counted alike:
  // how far a day strays is not something the last week knows better than the month.
  const residuals = usable.map((entry) => entry.actual_kwh / (entry.forecast_kwh * factor) - 1);
  const spread = Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / residuals.length);
  return { factor, spread: Math.min(spread, 0.5), days: usable.length, effective_days: weight };
}

/** Standard normal quantile (Acklam's approximation; exact to 1e-9 over the range used here). */
function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const quantileOf = (sorted: readonly number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))];

export interface DemandMarginInput {
  /** Import price per quarter over the horizon, published or estimated. */
  importSekPerKwh: readonly number[];
  /** What a kWh sells for in each quarter. */
  exportSekPerKwh: readonly number[];
  /** Solar beyond the levelled fixed load in each quarter, kWh; zero where there is none. */
  surplusKwh: readonly number[];
  horizonHours: number;
  battery: { usable_kwh: number; charge_efficiency: number; discharge_efficiency: number; degradation_sek_per_kwh: number };
}

export interface DemandMargin {
  /** Multiplies the levelled forecast: the demand the battery is charged for. */
  factor: number;
  /** The point of the spread planned for; 0.5 is the forecast itself. */
  quantile: number;
  /** What a kWh short costs, SEK: the dear hour less a cheap hour's energy delivered. */
  short_sek_per_kwh: number;
  /** What a kWh too many costs, SEK. */
  over_sek_per_kwh: number;
  /** How much of the pack a day's surplus sun fills by itself, 0 to 1. */
  solar_refill_share: number;
}

/**
 * How far above the levelled forecast to plan, from what each mistake costs.
 *
 * The newsvendor's rule: plan for the point of the spread whose chance of being
 * exceeded equals `over / (short + over)`. Short is the dear tenth of the
 * horizon against energy bought in the cheap tenth and carried through the
 * pack. Over depends on the sun: a kWh too many either waits a day (cheap) or,
 * when the day's surplus would have filled the pack anyway, has displaced sun
 * that is now sold instead (the cheap hour's cost less the sale). So a dark
 * week with a wide price spread plans well above the forecast, a flat week
 * plans on the forecast, and a sunny one stays close to it.
 */
export function demandMargin(level: DemandLevel, input: DemandMarginInput): DemandMargin {
  const none: DemandMargin = { factor: 1, quantile: 0.5, short_sek_per_kwh: 0, over_sek_per_kwh: 0, solar_refill_share: 0 };
  const prices = input.importSekPerKwh.filter(Number.isFinite).slice().sort((left, right) => left - right);
  const { battery } = input;
  if (prices.length === 0 || battery.usable_kwh <= 0 || level.spread <= 0) return none;
  const roundTrip = battery.charge_efficiency * battery.discharge_efficiency;
  const deliveredCost = quantileOf(prices, 0.1) / roundTrip + battery.degradation_sek_per_kwh / battery.discharge_efficiency;
  const short = Math.max(0, quantileOf(prices, 0.9) - deliveredCost);
  const surplus = input.surplusKwh.reduce((sum, kwh) => sum + kwh, 0);
  const refill = clamp(surplus / Math.max(1, input.horizonHours / 24) / battery.usable_kwh, 0, 1);
  const sold = input.surplusKwh.reduce((sum, kwh, index) => sum + kwh * (input.exportSekPerKwh[index] ?? 0), 0);
  const saleSekPerKwh = surplus > 0 ? sold / surplus : 0;
  const over = refill * Math.max(HOLDING_SEK_PER_KWH, deliveredCost - saleSekPerKwh) + (1 - refill) * HOLDING_SEK_PER_KWH;
  const quantile = clamp(short / (short + over), 0.5, MAX_QUANTILE);
  return {
    factor: Math.min(MAX_MARGIN, 1 + normalQuantile(quantile) * level.spread),
    quantile, short_sek_per_kwh: short, over_sek_per_kwh: over, solar_refill_share: refill,
  };
}
