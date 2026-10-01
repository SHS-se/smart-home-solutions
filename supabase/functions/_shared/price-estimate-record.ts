// What a plan estimated for the days the market had not published, as rows to
// keep (energy_price_estimate_days) so the estimate can be checked once the
// real prices exist. Nothing reads these but the staff accuracy view.

import { localSlot, QUARTERS_PER_DAY } from "./planner/energy-price-shape.ts";

export interface PriceEstimateRow {
  home_id: string;
  issued_on: string;
  target_day: string;
  timezone: string;
  /** Import SEK/kWh per quarter of the local day; null where published or outside the plan. */
  quarters: (number | null)[];
  basis: string;
  issued_at: string;
}

/** Fewer estimated quarters than this in a day says too little about the day to keep. */
const MIN_QUARTERS = 8;

/**
 * One row per local day that has quarters priced by estimate rather than by
 * the market. A day the market has since published yields no row, so the row
 * already stored for it keeps the last estimate made before it was.
 */
export function priceEstimateRows(options: {
  homeId: string;
  timezone: string;
  issuedAt: string;
  slots: { start: string; import_price_sek_per_kwh?: number | null }[];
  shadowImportSekPerKwh: readonly number[] | undefined;
  basis: string | undefined;
}): PriceEstimateRow[] {
  const { homeId, timezone, issuedAt, slots, shadowImportSekPerKwh: shadow } = options;
  const issued = Date.parse(issuedAt);
  if (!shadow || shadow.length !== slots.length || !Number.isFinite(issued)) return [];
  const issuedOn = localSlot(issued, timezone).dayKey;
  const days = new Map<string, (number | null)[]>();
  slots.forEach((slot, index) => {
    const published = typeof slot.import_price_sek_per_kwh === "number";
    const at = Date.parse(slot.start);
    const estimate = shadow[index];
    if (published || !Number.isFinite(at) || !Number.isFinite(estimate)) return;
    const local = localSlot(at, timezone);
    const quarters = days.get(local.dayKey) ?? new Array(QUARTERS_PER_DAY).fill(null);
    quarters[local.quarter] = Math.round(estimate * 1e4) / 1e4;
    days.set(local.dayKey, quarters);
  });
  return [...days]
    .filter(([day, quarters]) => day >= issuedOn && quarters.filter((value) => value !== null).length >= MIN_QUARTERS)
    .map(([target_day, quarters]) => ({
      home_id: homeId, issued_on: issuedOn, target_day, timezone, quarters,
      basis: options.basis ?? "recent_norm", issued_at: issuedAt,
    }));
}
