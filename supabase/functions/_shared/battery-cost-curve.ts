/** A deterministic, bill-only search over non-increasing battery value curves. */
import { marginalValue, type UtilityCurve } from "./store-value.ts";
import type { OptimisationSnapshot } from "./energy-optimisation.ts";

export const COST_CURVE_ALGORITHM = 1;
export const COST_CURVE_EVALUATIONS = 40;
export const COST_CURVE_KNOTS = 10;
export interface CostCurveInput {
  snapshot: OptimisationSnapshot;
  now: string;
}
export interface CostCurveRecord {
  key: string;
  curve: UtilityCurve;
  source_snapshot_id: string;
  evaluations: number;
  bill_before_sek: number;
  bill_after_sek: number;
  published_until: string;
}
export interface CostCurveEvaluation {
  curve: UtilityCurve;
  bill_sek: number;
}

/** Object key ordering and evolving measurements cannot change a price identity. */
export async function costCurveKey(input: CostCurveInput): Promise<string> {
  const quarter = Math.floor(Date.parse(input.now) / 900_000) * 900_000;
  const prices: [number, number, number][] = [];
  for (const slot of input.snapshot.slots) {
    if (Date.parse(slot.start) + 900_000 <= quarter) continue;
    if (
      slot.import_price_sek_per_kwh === null ||
      slot.export_price_sek_per_kwh === null
    ) break;
    prices.push([
      Date.parse(slot.start),
      slot.import_price_sek_per_kwh,
      slot.export_price_sek_per_kwh,
    ]);
  }
  if (!prices.length) {
    throw new Error("No published prices are available for a price-only curve");
  }
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([COST_CURVE_ALGORITHM, quarter, prices]),
    ),
  );
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export function evenlySpacedCurve(
  curve: UtilityCurve,
  capacity: number,
): UtilityCurve {
  return {
    unit: "kwh",
    points: Array.from({ length: COST_CURVE_KNOTS }, (_, i) => {
      const at = i * capacity / (COST_CURVE_KNOTS - 1);
      return { at, sek_per_unit: marginalValue(curve, at) };
    }),
  };
}

/**
 * The exact incumbent is tested before resampling. Proposals alter a nonnegative
 * adjacent-value gap: raising a gap raises its entire prefix. This can reshape
 * knees without making a curve increase. Only quoted bills enter this routine.
 */
export function* costCurveSearch(
  capacity: number,
  scale: number,
  seeds: UtilityCurve[],
): Generator<UtilityCurve, CostCurveEvaluation, number> {
  let count = 0;
  let best: CostCurveEvaluation | undefined;
  const seen = new Set<string>();
  function* evaluate(
    curve: UtilityCurve,
  ): Generator<UtilityCurve, boolean, number> {
    const identity = JSON.stringify(
      curve.points.map((p) => [p.at, p.sek_per_unit]),
    );
    if (seen.has(identity) || count >= COST_CURVE_EVALUATIONS) return false;
    seen.add(identity);
    count++;
    const bill = yield curve;
    if (!Number.isFinite(bill)) {
      throw new Error("The price-only trial did not produce a finite bill");
    }
    if (!best || bill < best.bill_sek - 1e-8) {
      best = { curve, bill_sek: bill };
      return true;
    }
    return false;
  }
  for (const seed of seeds) {
    yield* evaluate(seed);
    yield* evaluate(evenlySpacedCurve(seed, capacity));
  }
  yield* evaluate({
    unit: "kwh",
    points: Array.from(
      { length: COST_CURVE_KNOTS },
      (_, i) => ({ at: i * capacity / 9, sek_per_unit: 0 }),
    ),
  });
  if (!best) throw new Error("A battery curve search needs an evaluable seed");
  let step = scale / 4;
  let unsuccessful = 0;
  // Stop after three unsuccessful scales; the evaluation limit bounds partial sweeps.
  for (
    let sweep = 0;
    sweep < 6 && count < COST_CURVE_EVALUATIONS && step > 0;
    sweep++
  ) {
    let improved = false;
    for (
      let i = 0;
      i < COST_CURVE_KNOTS && count < COST_CURVE_EVALUATIONS;
      i++
    ) {
      for (const direction of [1, -1]) {
        const base = evenlySpacedCurve(best.curve, capacity);
        const gap = base.points[i].sek_per_unit -
          (base.points[i + 1]?.sek_per_unit ?? 0);
        const delta = direction > 0 ? step : -Math.min(gap, step);
        if (delta === 0) continue;
        const candidate = {
          unit: "kwh",
          points: base.points.map((p, j) => ({
            at: p.at,
            sek_per_unit: Math.max(0, p.sek_per_unit + (j <= i ? delta : 0)),
          })),
        };
        improved = (yield* evaluate(candidate)) || improved;
      }
    }
    if (improved) unsuccessful = 0;
    else {
      unsuccessful++;
      step /= 4;
    }
    if (unsuccessful >= 3) break;
  }
  return best;
}
