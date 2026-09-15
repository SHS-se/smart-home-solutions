/** Battery scope is an accounting permission, never physical circuit routing. */
import { z } from "zod";
export const SOLAR_ATTRIBUTION = "proportional-self-consumed-pv-v1";
export const batterySupplyScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("whole_house") }).strict(),
  z.object({ kind: z.literal("selected"), include_base: z.boolean(),
    planned_device_keys: z.array(z.string().min(1).max(128).refine(k => !k.startsWith("$"))).max(32),
  }).strict(),
]).refine(s => s.kind !== "selected" || s.planned_device_keys.every((key, i, keys) => !i || keys[i - 1] < key),
  "keys must be unique and canonical").transform(s => s.kind === "selected" && !s.include_base && !s.planned_device_keys.length
    ? { kind: "none" as const } : s);
export type BatterySupplyScope = z.infer<typeof batterySupplyScopeSchema>;
export function proportionalSupply(houseW: number, pvW: number, eligibleGrossW: number) {
  if ([houseW, pvW, eligibleGrossW].some(w => !Number.isFinite(w) || w < 0) || eligibleGrossW > houseW) {
    throw new Error("supply accounting requires a reconciled nonnegative AC partition");
  }
  const attributedPvW = houseW ? Math.min(pvW, houseW) * eligibleGrossW / houseW : 0;
  return { eligibleGrossW, attributedPvW,
    houseSupplyBoundW: Math.min(eligibleGrossW - attributedPvW, Math.max(0, houseW - pvW)) };
}
