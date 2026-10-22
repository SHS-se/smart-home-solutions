/** A source's explicit interval duration, never the distance to its next row. */
interface PriceIntervalSource {
  start_ts: string;
  import_price_sek_per_kwh: number;
}

interface PriceCoverage {
  mean: number;
  coveredMs: number;
}

/**
 * Reduce non-overlapping price intervals into the caller's existing buckets.
 * Native archive rows cover 15 minutes; an hourly source must explicitly pass
 * one hour. Missing rows never extend their neighbours. The last usable row
 * at a duplicate timestamp supplies the price and counts for coverage once.
 */
export function priceCoverageByBucket<Key extends string | number>(
  rows: readonly PriceIntervalSource[],
  intervalMs: number,
  bucketForStart: (startMs: number) => Key | null,
): Map<Key, PriceCoverage> {
  const prices = new Map<number, number>();
  for (const row of rows) {
    const at = Date.parse(row.start_ts);
    if (Number.isFinite(at) && Number.isFinite(row.import_price_sek_per_kwh)) {
      prices.set(at, row.import_price_sek_per_kwh);
    }
  }
  const buckets = new Map<Key, { weightedSum: number; coveredMs: number }>();
  for (const [at, price] of prices) {
    const key = bucketForStart(at);
    if (key === null) continue;
    const bucket = buckets.get(key) ?? { weightedSum: 0, coveredMs: 0 };
    bucket.weightedSum += price * intervalMs;
    bucket.coveredMs += intervalMs;
    buckets.set(key, bucket);
  }
  return new Map([...buckets].map(([key, bucket]) => [key, {
    mean: bucket.weightedSum / bucket.coveredMs,
    coveredMs: bucket.coveredMs,
  }]));
}
