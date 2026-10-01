// What a kWh is worth in a slot the market has not priced yet.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §1.4.3. Nord Pool publishes day-ahead and
// the horizon is 72 hours, so two thirds of every plan is permanently unpriced.
// Those slots used to score on `gridW / 100` — no time preference, linear in
// power, and not denominated in money. This module supplies the missing number.
//
// **One estimator, no tiers** (rewritten 2026-08-18). The previous design had a
// coverage floor: a fortnight of archive got a by-quarter median, less than
// that got nothing, and nothing meant the planner priced the whole tail *flat*.
// That was the worst of the available outcomes and it is what every young
// installation got. A flat tail is not the absence of a claim — it asserts that
// a kWh at 03:00 is worth exactly what a kWh at 18:00 is worth, which is the
// one thing a price archive disproves immediately. And because the planner
// reasons entirely in these numbers, it is not a display problem: a flat tail
// removes time preference from the objective itself.
//
// There is now a single estimate, and every observation contributes to it with
// a weight:
//
//   - **recency** — an exponential decay, so three days of archive and three
//     years of it are the same computation with different weights, and there is
//     no threshold anywhere to fall off;
//   - **day type** — weekday and weekend samples are weighted, not partitioned,
//     so a home that has only ever seen weekdays still gets a weekend answer
//     instead of a hole;
//   - **season** — a circular distance through the year, so last February
//     informs this February once an archive is old enough to hold one, and is
//     inert before that rather than being a separate mode.
//
// Underneath all of it: the plan's own published day-ahead window is itself an
// observation. A home with an empty archive still has a day of real prices in
// front of it, so the shape can always be estimated from something measured.
// The one case left without a shape is a plan carrying no prices at all, which
// is a broken price source rather than a young one.

export interface StoredPriceRow {
  start_ts: string;
  import_price_sek_per_kwh: number;
}

export type DayType = "weekday" | "weekend";

export const QUARTERS_PER_DAY = 96;
/** Guards against a near-zero daily mean turning a normalisation into a spike. */
const MIN_LEVEL_SEK_PER_KWH = 0.01;

/**
 * Half-life of an observation, in days.
 *
 * Three weeks: long enough that a fortnight of archive still counts for most of
 * its weight, short enough that a structural change — a new tariff, a cold
 * snap — works through in about a month rather than a season.
 */
export const RECENCY_HALF_LIFE_DAYS = 21;

/**
 * Weight given to an observation from the other day type.
 *
 * Not zero, because a home that has only seen weekdays must still get a weekend
 * shape rather than a hole; not one, because weekend prices are genuinely
 * flatter. Where same-type samples are plentiful they outnumber the borrowed
 * ones and this barely shows.
 */
export const CROSS_DAY_TYPE_WEIGHT = 0.35;

/**
 * Width of the seasonal window, in days.
 *
 * Six weeks either side. Inert until an archive spans enough of a year to hold
 * samples at different seasonal distances, which is the point: one formula
 * covers a three-day archive and a three-year one.
 */
export const SEASON_SIGMA_DAYS = 45;

/**
 * Pseudo-count pulling a thinly sampled quarter back toward "no opinion".
 *
 * A quarter seen once should not assert its ratio as confidently as one seen
 * fifty times. This is what lets the estimator run on a single day of prices
 * without spiking wherever that day happened to be unusual.
 */
export const SHRINKAGE = 1.5;

/**
 * Floor on a shape multiplier once the amplitude is restored.
 *
 * Restoring depth is a rescale about the daily mean, and a large enough gain
 * would push the cheapest quarter through zero and out the other side. A
 * multiplier this small already says "as good as free"; nothing below it means
 * anything a planner can act on, and negative would mean the opposite.
 */
export const MIN_SHAPE_MULTIPLIER = 0.05;

export interface PriceShape {
  /** Multiplier per quarter of local day, mean 1 across the day. */
  byDayType: Record<DayType, number[]>;
  /**
   * Summed observation weight, expressed in days.
   *
   * A confidence figure for display only. Nothing in this module branches on
   * it: branching on confidence is exactly what produced the flat tail this
   * rewrite removes.
   */
  effectiveDays: number;
  /** Distinct local days that contributed anything. */
  observedDays: number;
}

export interface PriceOutlook {
  /** Shadow import price in SEK/kWh for each slot, in slot order. */
  shadowImportSekPerKwh: number[];
  /** Null when no published price was available to set the level from. */
  levelSekPerKwh: number | null;
  /** Distinct days of evidence behind the shape, for display. */
  observedDays: number;
  /** Weighted days of evidence behind the shape, for display. */
  effectiveDays: number;
  /** False only when a plan carries no published price at all. */
  shaped: boolean;
  /** What set the level of the unpublished days. */
  levelBasis?: LevelBasis;
}

/** `wind`: recent prices explained by wind; `recent_norm`: the fortnight's median; `published`: carried forward. */
export type LevelBasis = "wind" | "recent_norm" | "published";

/** The mean wind speed over a bidding zone for one UTC calendar day, observed or forecast. */
export interface WindDay {
  /** YYYY-MM-DD, UTC. */
  day: string;
  mean_speed_m_s: number;
}

interface LocalSlot {
  dayType: DayType;
  quarter: number;
  dayKey: string;
  /** Days since the start of the local year, for seasonal distance. */
  dayOfYear: number;
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string) => {
  const cached = FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  FORMATTER_CACHE.set(timeZone, created);
  return created;
};

const WEEKEND = new Set(["Sat", "Sun"]);

/**
 * Local day type, quarter-of-day and day-of-year.
 *
 * Quarter is derived from local wall-clock time, so the profile survives the
 * daylight-saving changeovers: the same clock hour keeps the same index even
 * though the day is 92 or 100 quarters long.
 */
export const localSlot = (startMs: number, timeZone: string): LocalSlot => {
  const parts = formatterFor(timeZone).formatToParts(new Date(startMs));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const hour = Number(values.hour) % 24;
  const minute = Number(values.minute);
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return {
    dayType: WEEKEND.has(values.weekday) ? "weekend" : "weekday",
    quarter: hour * 4 + Math.floor(minute / 15),
    dayKey: `${values.year}-${values.month}-${values.day}`,
    dayOfYear: Math.round(
      (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000,
    ),
  };
};

/** Days between two points in the year, the short way round. */
const seasonalDistance = (left: number, right: number): number => {
  const raw = Math.abs(left - right);
  return Math.min(raw, 365 - raw);
};

interface Observation {
  quarter: number;
  dayType: DayType;
  dayKey: string;
  dayOfYear: number;
  /** The price divided by its own day's mean, so level cancels out. */
  ratio: number;
  ageDays: number;
}

/**
 * Normalise every observation against its own day, and drop the incomplete.
 *
 * Dividing by the source day's own mean is what separates shape from level: a
 * cheap day and a dear day with the same profile contribute the same evidence,
 * which is why a summer archive can still say *when* a winter day is expensive
 * without claiming to know how expensive.
 */
function observationsFrom(
  rows: StoredPriceRow[],
  timeZone: string,
  asOfMs: number,
): Observation[] {
  const byDay = new Map<
    string,
    Array<{ slot: LocalSlot; price: number; ms: number }>
  >();
  for (const row of rows) {
    const price = row.import_price_sek_per_kwh;
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      continue;
    }
    const ms = Date.parse(row.start_ts);
    if (!Number.isFinite(ms)) continue;
    const slot = localSlot(ms, timeZone);
    const day = byDay.get(slot.dayKey);
    if (day) day.push({ slot, price, ms });
    else byDay.set(slot.dayKey, [{ slot, price, ms }]);
  }

  const observations: Observation[] = [];
  for (const entries of byDay.values()) {
    // A part-archived day is dropped: its few samples would define their own
    // quarters outright while contributing nothing to the rest, and the mean
    // they are normalised against would not describe the same day as the
    // ratios it produced.
    if (entries.length < QUARTERS_PER_DAY / 2) continue;
    const mean = entries.reduce((total, entry) => total + entry.price, 0) /
      entries.length;
    if (!Number.isFinite(mean) || mean < MIN_LEVEL_SEK_PER_KWH) continue;
    for (const entry of entries) {
      observations.push({
        quarter: entry.slot.quarter,
        dayType: entry.slot.dayType,
        dayKey: entry.slot.dayKey,
        dayOfYear: entry.slot.dayOfYear,
        ratio: entry.price / mean,
        // A published day-ahead lies in the future. It is aged as though it
        // were today rather than negatively, so tomorrow can inform the shape
        // without outweighing the days that have actually happened.
        ageDays: Math.max(0, (asOfMs - entry.ms) / 86_400_000),
      });
    }
  }
  return observations;
}

export interface ShapeInput {
  /** Everything archived, plus this plan's own published window. */
  observations: StoredPriceRow[];
  timeZone: string;
  /** The plan's capture time, never the wall clock. */
  asOf: number;
}

/**
 * One weighted estimate of the daily price shape, from whatever exists.
 *
 * Returns null only when there is nothing to estimate from. There is no
 * coverage floor and no second mode: the weights do continuously what a
 * threshold used to do abruptly, so a home on its third day and one on its
 * third year run the same code and differ only in how confident the answer is.
 */
export function estimatePriceShape(input: ShapeInput): PriceShape | null {
  const observations = observationsFrom(
    input.observations,
    input.timeZone,
    input.asOf,
  );
  if (observations.length === 0) return null;

  const today = localSlot(input.asOf, input.timeZone);
  const dayTypes: DayType[] = ["weekday", "weekend"];
  const byDayType = {} as Record<DayType, number[]>;
  let totalWeight = 0;

  for (const dayType of dayTypes) {
    const weighted = new Array(QUARTERS_PER_DAY).fill(0);
    const weights = new Array(QUARTERS_PER_DAY).fill(0);
    // How far a real day departs from its own mean, under the same weights.
    // Each day's ratios are centred on 1 by construction, so this is exactly
    // the within-day dispersion the observations show.
    let observedSquares = 0;
    let observedWeight = 0;
    for (const observation of observations) {
      const recency = 2 ** (-observation.ageDays / RECENCY_HALF_LIFE_DAYS);
      const typeMatch = observation.dayType === dayType
        ? 1
        : CROSS_DAY_TYPE_WEIGHT;
      const seasonal = Math.exp(
        -(seasonalDistance(observation.dayOfYear, today.dayOfYear) ** 2) /
          (2 * SEASON_SIGMA_DAYS ** 2),
      );
      const weight = recency * typeMatch * seasonal;
      if (!(weight > 0)) continue;
      weighted[observation.quarter] += weight * observation.ratio;
      weights[observation.quarter] += weight;
      observedSquares += weight * (observation.ratio - 1) ** 2;
      observedWeight += weight;
    }
    // Shrink toward 1 — "no opinion" — in proportion to how little was seen.
    const estimate = weighted.map((sum, quarter) =>
      (sum + SHRINKAGE) / (weights[quarter] + SHRINKAGE)
    );
    totalWeight += weights.reduce((total, value) => total + value, 0);
    // Re-centre so the multipliers describe shape alone and never move the
    // level, which the outlook sets from published prices.
    const mean = estimate.reduce((total, value) => total + value, 0) /
      QUARTERS_PER_DAY;
    const centred = mean > 0.05
      ? estimate.map((value) => value / mean)
      : estimate;

    // Averaging keeps the timing and loses the depth. A trough that moves an
    // hour between days lands in different quarters and partly cancels, and
    // the shrinkage pulls every quarter further toward 1 on top of that — a
    // twelve-day archive of a wandering evening peak kept barely a third of
    // the spread a single day of it shows. That is not a display problem: a
    // shallow prior never gets as cheap as a real night, so the last published
    // quarters look like the bargain of the week and the planner buys against
    // a forecast. Stretch the shape about its own mean until it is as deep as
    // the days it was estimated from, which moves no peak and invents no hour.
    const observedVariance = observedWeight > 0
      ? observedSquares / observedWeight
      : 0;
    const shapeVariance = centred.reduce(
      (total, value) => total + (value - 1) ** 2,
      0,
    ) / QUARTERS_PER_DAY;
    const deepest = Math.min(...centred);
    // Never past the point where a quarter would imply energy is free.
    const ceiling = deepest < 1
      ? (1 - MIN_SHAPE_MULTIPLIER) / (1 - deepest)
      : Number.POSITIVE_INFINITY;
    // Thin evidence must not assert a deep day either. The same pseudo-count
    // that shrinks a lightly-seen quarter toward "no opinion" also holds the
    // restoration back, so one unusual day is damped and a fortnight is not —
    // and more evidence still sharpens the estimate rather than flattening it.
    const evidenceDays = observedWeight / QUARTERS_PER_DAY;
    const confidence = evidenceDays / (evidenceDays + SHRINKAGE);
    const matched = shapeVariance > 1e-9
      ? Math.sqrt(observedVariance / shapeVariance)
      : 1;
    const gain = Math.min(1 + (matched - 1) * confidence, ceiling);
    byDayType[dayType] = gain > 1
      ? centred.map((value) => 1 + (value - 1) * gain)
      : centred;
  }

  return {
    byDayType,
    effectiveDays: totalWeight / QUARTERS_PER_DAY / dayTypes.length,
    observedDays: new Set(observations.map((entry) => entry.dayKey)).size,
  };
}

export interface OutlookSlot {
  start: string;
  import_price_sek_per_kwh: number | null;
}

/**
 * A shadow import price for every slot, published where known and inferred
 * where not.
 *
 * The *level* comes from this plan's own published slots rather than from
 * history, because a day-ahead window is the best available statement of what
 * energy currently costs; the observations only supply the shape. Those same
 * published slots are fed back in as observations, which is what guarantees a
 * shape exists even for a home with no archive at all.
 *
 * A plan with no published price gets no outlook, and the caller falls back to
 * a price-free objective that can still prefer solar and a flat draw. That is a
 * broken price source, not a young one.
 */
/**
 * How fast an unpublished day's level leaves the last published one for the
 * recent norm, per day of lead.
 *
 * The published window says what electricity costs today; it says little about
 * the day after tomorrow. Daily prices swing with wind and demand and come
 * back: over 91 days of SE3 day-ahead prices (July to September 2026), carrying
 * the published level forward missed the level two days on by 46 EUR/MWh and
 * three days on by 55, while the median of the last fortnight missed by 38 and
 * 39. The best blend moved a third of the way to that median one day out, two
 * thirds two days out and all the way three days out, which is this rate.
 */
export const LEVEL_REVERSION_PER_DAY = 0.35;
/** Days of archive the norm is the median of. */
export const LEVEL_NORM_DAYS = 14;
/** Fewer complete days than this is not a norm to revert to. */
const LEVEL_NORM_MIN_DAYS = 5;

/**
 * The median daily mean price over the last complete days before `asOf`, or
 * null without enough of them.
 */
export function recentDailyNorm(archive: readonly StoredPriceRow[], asOf: number): number | null {
  const days = new Map<number, { sum: number; count: number }>();
  for (const row of archive) {
    const at = Date.parse(row.start_ts);
    if (!Number.isFinite(at) || at >= asOf || !Number.isFinite(row.import_price_sek_per_kwh)) continue;
    const daysBack = Math.floor((asOf - at) / 86_400_000);
    if (daysBack >= LEVEL_NORM_DAYS) continue;
    const day = days.get(daysBack) ?? { sum: 0, count: 0 };
    day.sum += row.import_price_sek_per_kwh;
    day.count += 1;
    days.set(daysBack, day);
  }
  // A day counts when most of it is on record, at quarter or hour resolution.
  const means = [...days.values()].filter(day => day.count >= 20).map(day => day.sum / day.count).sort((a, b) => a - b);
  if (means.length < LEVEL_NORM_MIN_DAYS) return null;
  const middle = Math.floor(means.length / 2);
  return means.length % 2 ? means[middle] : (means[middle - 1] + means[middle]) / 2;
}

/** Days of prices and wind the wind model is fitted on. */
export const WIND_FIT_DAYS = 30;
/** Fewer days than this with both a price and a wind speed is not a fit. */
const WIND_FIT_MIN_DAYS = 14;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isWeekend = (day: string): number => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 ? 1 : 0;
};

/**
 * What a day's mean price is expected to be from its wind, or null without
 * enough evidence that wind explains this home's prices.
 *
 * Wind is the largest thing that moves the daily level and the market does not
 * publish it past tomorrow, while the weather forecast reaches ten days. Over
 * 93 days of SE3 prices (July to September 2026) the mean wind speed at ten
 * SMHI stations followed the zone's wind generation with a correlation of
 * 0.97, and a level fitted on the last 30 days of wind and day type missed the
 * level two days on by 22 EUR/MWh and three days on by 25, where reverting to
 * the fortnight's median missed by 34 and 41.
 *
 * The fit is ordinary least squares of the daily mean price on wind speed and
 * a weekend flag, and it is only used when more wind has meant lower prices:
 * anything else is a coincidence in thirty points, not a market.
 */
export function windLevelModel(
  archive: readonly StoredPriceRow[],
  wind: readonly WindDay[],
  asOf: number,
): ((day: string) => number | null) | null {
  const speedByDay = new Map<string, number>();
  for (const entry of wind) {
    if (typeof entry?.day === "string" && Number.isFinite(entry.mean_speed_m_s) && entry.mean_speed_m_s >= 0) {
      speedByDay.set(entry.day, entry.mean_speed_m_s);
    }
  }
  if (speedByDay.size === 0) return null;
  const firstMs = asOf - WIND_FIT_DAYS * 86_400_000;
  const prices = new Map<string, { sum: number; count: number }>();
  for (const row of archive) {
    const at = Date.parse(row.start_ts);
    if (!Number.isFinite(at) || at >= asOf || at < firstMs || !Number.isFinite(row.import_price_sek_per_kwh)) continue;
    const day = utcDay(at);
    const held = prices.get(day) ?? { sum: 0, count: 0 };
    held.sum += row.import_price_sek_per_kwh;
    held.count += 1;
    prices.set(day, held);
  }
  const rows: { speed: number; weekend: number; level: number }[] = [];
  for (const [day, held] of prices) {
    const speed = speedByDay.get(day);
    // A day counts when most of it is on record, at quarter or hour resolution.
    if (speed === undefined || held.count < 20) continue;
    rows.push({ speed, weekend: isWeekend(day), level: held.sum / held.count });
  }
  if (rows.length < WIND_FIT_MIN_DAYS) return null;

  const mean = (pick: (row: typeof rows[number]) => number) => rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
  const speedMean = mean((row) => row.speed);
  const weekendMean = mean((row) => row.weekend);
  const levelMean = mean((row) => row.level);
  let ss = 0, sw = 0, ww = 0, sy = 0, wy = 0;
  for (const row of rows) {
    const speed = row.speed - speedMean;
    const weekend = row.weekend - weekendMean;
    const level = row.level - levelMean;
    ss += speed * speed;
    sw += speed * weekend;
    ww += weekend * weekend;
    sy += speed * level;
    wy += weekend * level;
  }
  if (ss < 1e-9) return null;
  // Without both day types in the window the flag explains nothing.
  const determinant = ss * ww - sw * sw;
  const both = ww > 1e-9 && Math.abs(determinant) > 1e-9;
  const perSpeed = both ? (sy * ww - wy * sw) / determinant : sy / ss;
  const perWeekend = both ? (wy * ss - sy * sw) / determinant : 0;
  if (!(perSpeed < 0)) return null;

  const levels = rows.map((row) => row.level);
  const lowest = Math.min(...levels) * 0.8;
  const highest = Math.max(...levels) * 1.25;
  return (day) => {
    const speed = speedByDay.get(day);
    if (speed === undefined) return null;
    const level = levelMean + perSpeed * (speed - speedMean) + perWeekend * (isWeekend(day) - weekendMean);
    return Math.min(highest, Math.max(lowest, level));
  };
}

export function buildPriceOutlook(
  slots: OutlookSlot[],
  archive: StoredPriceRow[] = [],
  options: { timeZone?: string; asOf?: number; wind?: readonly WindDay[] } = {},
): PriceOutlook {
  const timeZone = options.timeZone ?? "Europe/Stockholm";
  const published = slots.filter((slot) =>
    typeof slot.import_price_sek_per_kwh === "number" &&
    Number.isFinite(slot.import_price_sek_per_kwh)
  );
  if (published.length === 0) {
    return {
      shadowImportSekPerKwh: slots.map(() => 0),
      levelSekPerKwh: null,
      observedDays: 0,
      effectiveDays: 0,
      shaped: false,
    };
  }

  const parsedAsOf = options.asOf ?? Date.parse(slots[0]?.start ?? "");
  const asOf = Number.isFinite(parsedAsOf) ? parsedAsOf : Date.now();
  const shape = estimatePriceShape({
    // The published window is evidence too — and for a new installation it is
    // the only evidence, which is precisely the case the old design gave up on.
    observations: [
      ...archive,
      ...published.map((slot) => ({
        start_ts: slot.start,
        import_price_sek_per_kwh: slot.import_price_sek_per_kwh as number,
      })),
    ],
    timeZone,
    asOf,
  });

  const level = published.reduce(
    (total, slot) => total + (slot.import_price_sek_per_kwh as number),
    0,
  ) / published.length;

  // The published window is normalised out of the shape before it sets the
  // level, so a day-ahead window that happens to be mostly cheap night hours
  // does not drag the whole tail down with it.
  let publishedShapeMean = 1;
  if (shape) {
    const multipliers = published
      .map((slot) => {
        const local = localSlot(Date.parse(slot.start), timeZone);
        return shape.byDayType[local.dayType][local.quarter];
      })
      .filter((value) => Number.isFinite(value));
    if (multipliers.length > 0) {
      const mean = multipliers.reduce((total, value) => total + value, 0) /
        multipliers.length;
      if (mean > 0.05) publishedShapeMean = mean;
    }
  }

  // Each unpublished quarter's level: the published one, drawn toward the
  // recent norm the further past the published window it lies.
  const norm = recentDailyNorm(archive, asOf);
  const publishedUntil = Math.max(...published.map((slot) => Date.parse(slot.start)));
  const publishedDayLevel = level / publishedShapeMean;
  // With wind, the level is what the day's wind says, plus what is left of
  // how far the published days stand from what their own wind said.
  const windLevel = options.wind?.length ? windLevelModel(archive, options.wind, asOf) : null;
  let publishedWindLevel: number | null = null;
  if (windLevel) {
    const expected = published
      .map((slot) => windLevel(utcDay(Date.parse(slot.start))))
      .filter((value): value is number => value !== null);
    // Most of the published window must have a wind of its own to stand on.
    if (expected.length * 2 >= published.length) {
      publishedWindLevel = expected.reduce((sum, value) => sum + value, 0) / expected.length;
    }
  }
  let levelBasis: LevelBasis = "published";
  const dayLevelAt = (startMs: number): number => {
    if (!Number.isFinite(publishedUntil)) return publishedDayLevel;
    // Half a day in, the first unpublished day is one day of lead.
    const leadDays = Math.max(0, (startMs - publishedUntil) / 86_400_000) + 0.5;
    const weight = Math.min(1, LEVEL_REVERSION_PER_DAY * leadDays);
    const expected = publishedWindLevel === null ? null : windLevel!(utcDay(startMs));
    if (expected !== null) {
      levelBasis = "wind";
      return Math.max(0, expected + (1 - weight) * (publishedDayLevel - publishedWindLevel!));
    }
    if (norm === null) return publishedDayLevel;
    if (levelBasis === "published") levelBasis = "recent_norm";
    return publishedDayLevel + weight * (norm - publishedDayLevel);
  };

  const shadowImportSekPerKwh = slots.map((slot) => {
    if (typeof slot.import_price_sek_per_kwh === "number") {
      return slot.import_price_sek_per_kwh;
    }
    const startMs = Date.parse(slot.start);
    if (!Number.isFinite(startMs)) return level;
    if (!shape) return Math.max(0, dayLevelAt(startMs) * publishedShapeMean);
    const local = localSlot(startMs, timeZone);
    const multiplier = shape.byDayType[local.dayType][local.quarter];
    if (!Number.isFinite(multiplier)) return level;
    return Math.max(0, dayLevelAt(startMs) * multiplier);
  });

  return {
    shadowImportSekPerKwh,
    levelSekPerKwh: level,
    observedDays: shape?.observedDays ?? 0,
    effectiveDays: shape?.effectiveDays ?? 0,
    shaped: true,
    levelBasis,
  };
}
