// Default utility curves, and the rules for accepting a customer's overrides.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.10: the curves are supplied once and
// then left alone, because the money available to a household from this system
// is small against the value of its attention. That makes good defaults a
// requirement rather than a convenience — a home must be plannable before
// anyone opens an editor, and a curve nobody ever revisits must still be
// roughly right.
//
// Every default below is shaped, not tuned. The claim each one makes is that
// the *ordering* is right — a cold pool outranks a warm one, the first
// kilometres of range outrank the last — because ordering is what the planner
// consumes. Absolute levels are refined from overrides and, later, from
// revealed preference: a manual override is a customer stating that a curve is
// wrong, which is worth more than a number typed at commissioning.

import { type UtilityCurve, validateCurve } from "./store-value.ts";

export type ValueStoreKey = "pool" | "ev" | "hot_water";

export interface ValueSettings {
  /** Purchase price divided by warranted lifetime throughput, SEK per kWh. */
  battery_degradation_sek_per_kwh: number;
  /**
   * A plug-in hybrid's fallback cost per km, if it has one.
   *
   * Null for a battery vehicle. This is the one shortfall price that is not a
   * taste at all — it is the pump price of the fuel the car burns instead.
   */
  vehicle_fallback_sek_per_km: number | null;
}

export const DEFAULT_VALUE_SETTINGS: ValueSettings = {
  // A mid-range figure for a domestic LFP pack: a 30–40k SEK battery against
  // roughly 6000 cycles of usable throughput. Wrong for any specific
  // installation, right enough to stop pointless shallow cycling until the
  // customer's own invoice replaces it.
  battery_degradation_sek_per_kwh: 0.45,
  vehicle_fallback_sek_per_km: null,
};

/**
 * Pool water temperature.
 *
 * Steep below the enjoyable band, moderate across it, nothing above. The
 * moderate section is what lets the planner bank surplus before a cloudy day,
 * and the zero above 31 °C is what stops it doing so without limit. Slightly
 * negative would be more honest — an over-warm pool evaporates faster and is
 * less pleasant — but a curve that goes negative can make *cooling* look
 * profitable, and there is no actuator for that.
 *
 * The levels are set against the physics rather than picked freely, because a
 * pool is enormous and a curve that ignores its scale simply never heats. A
 * 55 m³ pool holds about 64 kWh per °C, so at a COP of 4.5 a degree costs
 * roughly 14 kWh — about 17 SEK of grid import, or 5 SEK of forgone export. An
 * earlier draft valued a degree at 4 SEK and the planner correctly refused to
 * heat at all, which was a defect in the default rather than in the objective.
 *
 * The resulting behaviour is the intended one: a cold pool is worth heating
 * from the grid, a pool inside its band is worth topping up from surplus only,
 * and a warm pool is worth nothing.
 */
export const DEFAULT_POOL_CURVE: UtilityCurve = {
  unit: "celsius",
  points: [
    { at: 25, sek_per_unit: 80 },
    { at: 28, sek_per_unit: 30 },
    { at: 30, sek_per_unit: 8 },
    { at: 31, sek_per_unit: 0 },
  ],
};

/**
 * Vehicle range, scaled to the range the customer actually asked for.
 *
 * Stating the curve in kilometres is what makes winter automatic: consumption
 * per km rises as temperature falls, so the same state of charge buys less
 * range and lands further up the steep part without any seasonal parameter.
 *
 * The levels come from the alternative, not from taste. A kilometre costs
 * `kWh/km × price`, so at 0.16 kWh/km a kilometre is worth about 0.32 SEK when
 * the fallback is importing at 2 SEK/kWh. An earlier default put the middle
 * band at 0.08 SEK/km — roughly 0.46 SEK/kWh — which is *below* an ordinary
 * export price, so a half-charged car declined free afternoon surplus and the
 * energy was sold instead. That was the same order-of-magnitude error the pool
 * curve had.
 *
 * The breakpoints are relative to the target because an absolute kilometre
 * figure means nothing across vehicles: the customer's own charge limit is the
 * statement of how much range they want, so "wanted" ends there and everything
 * above it is worth very little.
 *
 *   - below a quarter of target: range anxiety. Worth more than any import
 *     price, because being unable to make an unplanned trip is not a saving.
 *   - up to target: worth roughly what charging later would cost, so surplus
 *     and ordinary grid both clear it while a price spike does not.
 *   - above target to full: worth almost nothing, which is why charging to the
 *     limit from the grid is rarely correct.
 */
export function vehicleRangeCurve(targetRangeKm: number): UtilityCurve {
  const target = Math.max(20, targetRangeKm);
  return {
    unit: "km",
    // Breakpoints are vertices of an interpolated curve, not band values, so
    // the anxiety zone needs its own pair: with only one high point the decline
    // to the wanted level would be spread across the whole mid range and a car
    // at half charge would bid several times what a kilometre is worth.
    points: [
      { at: round2(target * 0.15), sek_per_unit: 2.0 },
      { at: round2(target * 0.3), sek_per_unit: 0.45 },
      { at: round2(target), sek_per_unit: 0.32 },
      // Ends at zero so the top is a slope rather than a cliff: an interpolated
      // curve stopping at a positive value drops straight to nothing there.
      { at: round2(target * 1.3), sek_per_unit: 0 },
    ],
  };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The shape for a vehicle whose target is not known: a nominal 400 km. */
export const DEFAULT_EV_CURVE: UtilityCurve = vehicleRangeCurve(400);

/**
 * Hot water, in litre-degrees above the temperature a draw is useful at.
 *
 * Present for completeness and currently unused: the house has no tank
 * temperature sensor, so there is no state to value and the boiler keeps its
 * duty-cycle permission contract (§1.6.4). Shipping the curve anyway keeps the
 * store list uniform, so adding a sensor later is a mapping rather than a code
 * change.
 */
export const DEFAULT_HOT_WATER_CURVE: UtilityCurve = {
  unit: "litre_degrees",
  points: [
    { at: 3_000, sek_per_unit: 0.004 },
    { at: 6_000, sek_per_unit: 0.001 },
    { at: 9_000, sek_per_unit: 0 },
  ],
};

export const DEFAULT_VALUE_CURVES: Record<ValueStoreKey, UtilityCurve> = {
  pool: DEFAULT_POOL_CURVE,
  ev: DEFAULT_EV_CURVE,
  hot_water: DEFAULT_HOT_WATER_CURVE,
};

export interface StoredCurveRow {
  store_key: string;
  unit: string;
  points: unknown;
}

export interface ResolvedCurve {
  curve: UtilityCurve;
  /** Whether this home supplied it, or it fell back to the shipped default. */
  source: "customer" | "default";
}

const MAX_POINTS = 12;

/**
 * Accept one stored curve, or explain why it cannot be used.
 *
 * Deliberately strict. A curve is the only thing standing between "minimise
 * cost" and "turn everything off", so a malformed one must never be silently
 * repaired into something plausible — the customer would get a house that
 * economises by delivering nothing, and no error to explain it.
 */
export function parseStoredCurve(row: StoredCurveRow): UtilityCurve | string {
  if (!Array.isArray(row.points)) return "points must be an array";
  if (row.points.length === 0) return "a curve needs at least one point";
  if (row.points.length > MAX_POINTS) {
    return `a curve may not exceed ${MAX_POINTS} points`;
  }
  const points: { at: number; sek_per_unit: number }[] = [];
  for (const raw of row.points) {
    if (typeof raw !== "object" || raw === null) return "a point must be an object";
    const at = Number((raw as Record<string, unknown>).at);
    const value = Number((raw as Record<string, unknown>).sek_per_unit);
    if (!Number.isFinite(at) || !Number.isFinite(value)) {
      return "a point needs finite at and sek_per_unit";
    }
    points.push({ at, sek_per_unit: value });
  }
  const curve: UtilityCurve = { unit: row.unit, points };
  const rejection = validateCurve(curve);
  if (rejection) return `${rejection.reason}: ${rejection.detail}`;
  return curve;
}

/**
 * Resolve every store's curve, preferring the customer's and falling back.
 *
 * A rejected override falls back to the default rather than failing the plan,
 * and reports why. Refusing to plan the whole home because one curve was
 * edited into a bad shape would be a worse failure than heating the pool on a
 * shipped default for an afternoon.
 */
export function resolveValueCurves(
  rows: StoredCurveRow[],
): {
  curves: Record<ValueStoreKey, ResolvedCurve>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const byKey = new Map(rows.map((row) => [row.store_key, row]));
  const curves = {} as Record<ValueStoreKey, ResolvedCurve>;
  for (const key of Object.keys(DEFAULT_VALUE_CURVES) as ValueStoreKey[]) {
    const row = byKey.get(key);
    if (!row) {
      curves[key] = { curve: DEFAULT_VALUE_CURVES[key], source: "default" };
      continue;
    }
    const parsed = parseStoredCurve(row);
    if (typeof parsed === "string") {
      warnings.push(`${key} curve rejected (${parsed}); using the default`);
      curves[key] = { curve: DEFAULT_VALUE_CURVES[key], source: "default" };
      continue;
    }
    curves[key] = { curve: parsed, source: "customer" };
  }
  return { curves, warnings };
}

/** Merge a stored settings row over the shipped defaults. */
export function resolveValueSettings(
  row: Partial<ValueSettings> | null | undefined,
): ValueSettings {
  if (!row) return { ...DEFAULT_VALUE_SETTINGS };
  const degradation = Number(row.battery_degradation_sek_per_kwh);
  const fallback = row.vehicle_fallback_sek_per_km;
  return {
    battery_degradation_sek_per_kwh: Number.isFinite(degradation) &&
        degradation >= 0
      ? degradation
      : DEFAULT_VALUE_SETTINGS.battery_degradation_sek_per_kwh,
    vehicle_fallback_sek_per_km:
      typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0
        ? fallback
        : null,
  };
}
