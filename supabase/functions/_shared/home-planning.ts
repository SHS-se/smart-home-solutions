import type { OptimisationSnapshot } from "./energy-optimisation.ts";

/** Website choice only removes battery planning; measurements remain untouched. */
export function applyBatteryChoice(snapshot: OptimisationSnapshot, included: boolean): OptimisationSnapshot {
  if (included) return snapshot;
  return { ...snapshot, battery: null, capabilities: { ...snapshot.capabilities, battery: false },
    policy: { ...snapshot.policy, battery_export_enabled: false,
      battery_export_reserve_soc: 0, battery_export_min_price_sek_per_kwh: 0 } };
}
