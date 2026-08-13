// What a kWh is worth in a slot the market has not priced yet.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §1.4.3. Nord Pool publishes day-ahead and
// the horizon is 72 hours, so two thirds of every plan is permanently unpriced.
// Those slots used to score on `gridW / 100` — no time preference, linear in
// power, and not denominated in money. This module supplies the missing number.
//
// The shape is *measured*, from the home's own stored prices. "Peaks are early
// morning and late evening" is a true generalisation and still must not be
// hard-coded: §1.3.1 is a long account of what happens when a plausible constant
// is presented as a measurement. Below a coverage floor this returns no shape at
// all rather than inventing one.

export interface StoredPriceRow {
  start_ts: string;
  import_price_sek_per_kwh: number;
}

export type DayType = "weekday" | "weekend";

export const QUARTERS_PER_DAY = 96;
/**
 * Distinct days of archive required per day type before a shape is published.
 * Two weeks covers a fortnight of weather and both halves of a working week;
 * below it the median of a quarter is a handful of samples and mostly noise.
 */
export const MIN_SHAPE_COVERAGE_DAYS = 14;
/** Guards against a near-zero daily mean turning a normalisation into a spike. */
const MIN_LEVEL_SEK_PER_KWH = 0.01;

export interface PriceShape {
  /** Multiplier per quarter of local day, normalised to mean 1 within a day type. */
  byDayType: Record<DayType, number[]>;
  coverageDays: Record<DayType, number>;
  sampleCount: number;
}

export interface PriceOutlook {
  /** Shadow import price in SEK/kWh for each slot, in slot order. */
  shadowImportSekPerKwh: number[];
  /** Null when no published price was available to set the level from. */
  levelSekPerKwh: number | null;
  shapeCoverageDays: number;
  /** True when both a level and a measured shape were available. */
  shaped: boolean;
}

interface LocalSlot {
  dayType: DayType;
  quarter: number;
  dayKey: string;
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
 * Local day type and quarter-of-day.
 *
 * Quarter is derived from local wall-clock time, so the profile survives the
 * daylight-saving changeovers: the same clock hour keeps the same index even
 * though the day is 92 or 100 quarters long.
 */
export const localSlot = (startMs: number, timeZone: string): LocalSlot => {
  const parts = formatterFor(timeZone).formatToParts(new Date(startMs));
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(value("hour")) % 24;
  const minute = Number(value("minute"));
  return {
    dayType: WEEKEND.has(value("weekday")) ? "weekend" : "weekday",
    quarter: hour * 4 + Math.floor(minute / 15),
    dayKey: `${value("year")}-${value("month")}-${value("day")}`,
  };
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

/**
 * Derive a normalised daily price shape from stored prices.
 *
 * Normalising each day type to its own mean is the point: shape is far more
 * stable across seasons than level, so a summer archive can still say *when* a
 * winter day is expensive without claiming to know *how* expensive. Returns null
 * when neither day type clears the coverage floor.
 */
export function buildPriceShape(
  rows: StoredPriceRow[],
  timeZone = "Europe/Stockholm",
): PriceShape | null {
  const samples: Record<DayType, Array<number[]>> = {
    weekday: Array.from({ length: QUARTERS_PER_DAY }, () => []),
    weekend: Array.from({ length: QUARTERS_PER_DAY }, () => []),
  };
  const days: Record<DayType, Set<string>> = {
    weekday: new Set(),
    weekend: new Set(),
  };
  let sampleCount = 0;

  for (const row of rows) {
    const price = row.import_price_sek_per_kwh;
    if (typeof price !== "number" || !Number.isFinite(price)) continue;
    const startMs = Date.parse(row.start_ts);
    if (!Number.isFinite(startMs)) continue;
    const slot = localSlot(startMs, timeZone);
    samples[slot.dayType][slot.quarter].push(price);
    days[slot.dayType].add(slot.dayKey);
    sampleCount += 1;
  }

  const coverageDays: Record<DayType, number> = {
    weekday: days.weekday.size,
    weekend: days.weekend.size,
  };
  const byDayType = {} as Record<DayType, number[]>;
  let published = false;

  for (const dayType of ["weekday", "weekend"] as const) {
    // A day type short of coverage borrows the other rather than inventing a
    // shape; a weekend priced on the weekday curve is wrong in a small,
    // explainable way, while a shape fitted to three days is wrong unboundedly.
    const usable = coverageDays[dayType] >= MIN_SHAPE_COVERAGE_DAYS;
    if (!usable) continue;
    const medians = samples[dayType].map((values) =>
      values.length > 0 ? median(values) : Number.NaN
    );
    const known = medians.filter((value) => Number.isFinite(value));
    if (known.length < QUARTERS_PER_DAY / 2) continue;
    const mean = known.reduce((total, value) => total + value, 0) / known.length;
    if (!Number.isFinite(mean) || Math.abs(mean) < MIN_LEVEL_SEK_PER_KWH) continue;
    // An unsampled quarter takes the day's own mean, which is a multiplier of
    // exactly 1 — no opinion, rather than a hole.
    byDayType[dayType] = medians.map((value) =>
      Number.isFinite(value) ? value / mean : 1
    );
    published = true;
  }

  if (!published) return null;
  byDayType.weekday ??= byDayType.weekend;
  byDayType.weekend ??= byDayType.weekday;
  return { byDayType, coverageDays, sampleCount };
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
 * energy currently costs; the archive only supplies the shape. A plan with no
 * published price at all gets no outlook, and the caller falls back to a
 * price-free objective that can still prefer solar and a flat draw.
 */
export function buildPriceOutlook(
  slots: OutlookSlot[],
  shape: PriceShape | null,
  timeZone = "Europe/Stockholm",
): PriceOutlook {
  const published = slots
    .map((slot) => slot.import_price_sek_per_kwh)
    .filter((price): price is number =>
      typeof price === "number" && Number.isFinite(price)
    );
  if (published.length === 0) {
    return {
      shadowImportSekPerKwh: slots.map(() => 0),
      levelSekPerKwh: null,
      shapeCoverageDays: 0,
      shaped: false,
    };
  }

  // The published window is normalised out of the shape before it sets the
  // level, so a day-ahead window that happens to be mostly cheap night hours
  // does not drag the whole tail down with it.
  const level = published.reduce((total, value) => total + value, 0) /
    published.length;
  const shapeCoverageDays = shape
    ? Math.max(shape.coverageDays.weekday, shape.coverageDays.weekend)
    : 0;

  let publishedShapeMean = 1;
  if (shape) {
    const multipliers = slots
      .filter((slot) => typeof slot.import_price_sek_per_kwh === "number")
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

  const shadowImportSekPerKwh = slots.map((slot) => {
    if (typeof slot.import_price_sek_per_kwh === "number") {
      return slot.import_price_sek_per_kwh;
    }
    if (!shape) return level;
    const startMs = Date.parse(slot.start);
    if (!Number.isFinite(startMs)) return level;
    const local = localSlot(startMs, timeZone);
    const multiplier = shape.byDayType[local.dayType][local.quarter];
    if (!Number.isFinite(multiplier)) return level;
    return Math.max(0, level * multiplier / publishedShapeMean);
  });

  return {
    shadowImportSekPerKwh,
    levelSekPerKwh: level,
    shapeCoverageDays,
    shaped: shape !== null,
  };
}
