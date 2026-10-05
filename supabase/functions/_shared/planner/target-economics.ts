import type { UtilityCurve } from "./store-value.ts";
import { DEFAULT_URGENT_PRICE_MULTIPLIER } from "./value-preferences.ts";

/** One service day, independent of the length of a plan or its remaining suffix. */
export const SERVICE_DAY_HOURS = 24;

type ServiceTiming =
  | { kind: "held"; slot_hours: readonly number[] }
  | { kind: "event"; slot: number; slots: number };

export interface TargetEconomicsEvidence {
  method: "target_utility";
  target: number;
  scale: number;
  reference_sek_per_kwh: number;
  willingness_multiplier: number;
  service_basis: "service_day" | "readiness_event";
}

/**
 * A target is service intent, not a supply-clearing price. Price its shortfall
 * with the existing relative urgency policy; free solar must not erase it.
 * Excess inventory earns no direct comfort reward. Its value comes from the
 * later shortfalls that the physical trajectory prevents.
 */
export function targetEconomics(input: {
  unit: string; target: number; step: number; units_per_kwh: number;
  reference_sek_per_kwh: number; scale: number; timing: ServiceTiming;
}): {
  curve: UtilityCurve; usage_weight: number[]; terminal_weight: number;
  derivation: TargetEconomicsEvidence;
} {
  const value = input.units_per_kwh > 0 ? input.scale * DEFAULT_URGENT_PRICE_MULTIPLIER *
    input.reference_sek_per_kwh / input.units_per_kwh : 0;
  const timing = input.timing;
  const held = timing.kind === "held";
  const weights = timing.kind === "held"
    ? timing.slot_hours.map(hours => hours / SERVICE_DAY_HOURS)
    : Array.from({ length: timing.slots }, (_, index) => index === timing.slot ? 1 : 0);
  const low = Math.max(0, input.target - 8 * input.step);
  return {
    curve: { unit: input.unit, points: [
      ...(low < input.target ? [{ at: low, sek_per_unit: value }] : []),
      { at: input.target, sek_per_unit: value },
    ] },
    usage_weight: weights,
    terminal_weight: held ? 1 : 0,
    derivation: { method: "target_utility", target: input.target, scale: input.scale,
      reference_sek_per_kwh: input.reference_sek_per_kwh,
      willingness_multiplier: DEFAULT_URGENT_PRICE_MULTIPLIER,
      service_basis: held ? "service_day" : "readiness_event" },
  };
}
